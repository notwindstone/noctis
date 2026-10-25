import type { RedisClient } from 'bun'
import { sha256Hex } from '@noctis/plugin-core'
import type { Database } from './db'

/**
 * Users, groups and sessions.
 *
 * - Users and groups live in PostgreSQL. Passwords are stored only as Argon2 hashes.
 * - What a user may do comes from their groups' permissions (below). "admins" have "*".
 * - Sessions live in Redis: a session token is what clients send (OpenSubsonic's
 *   `apiKey`, or `Authorization: Bearer` on /noctis). Redis stores only its SHA-256, with
 *   a sliding expiry, and revoking a session takes effect immediately.
 * - Guests: with guest access on, requests without a token act as the "guests" group
 *   (browse and stream by default). Anything per-user (stars, playlists, queues) still
 *   needs an account.
 */

/** Built-in permissions. Plugins add their own, prefixed with their id (see Permissions.define). */
export const BUILTIN_PERMISSIONS: Record<string, string> = {
  '*': 'Everything (administrators)',
  'library.read': 'Browse and search the catalog',
  stream: 'Play songs',
  download: 'Download songs',
  annotate: 'Star, rate and scrobble',
  playlists: 'Create and edit their own playlists',
  'playlists.public': 'Make playlists public',
  queue: 'Save play queues and bookmarks',
  'library.scan': 'Start library scans',
  'users.manage': 'Create users and manage groups',
}

const BUILTIN_GROUPS = [
  { name: 'admins', description: 'Full access', permissions: ['*'] },
  { name: 'users', description: 'Regular accounts', permissions: ['library.read', 'stream', 'download', 'annotate', 'playlists', 'queue'] },
  { name: 'guests', description: 'Requests without an account, when guest access is on', permissions: ['library.read', 'stream'] },
]

export interface User {
  /** 0 for guests. */
  id: number
  name: string
  groups: string[]
  permissions: string[]
  guest: boolean
}

export const can = (user: Pick<User, 'permissions'>, permission: string) => user.permissions.includes('*') || user.permissions.includes(permission)

export class AuthError extends Error {
  constructor(
    /** OpenSubsonic error code (40: credentials, 44: invalid key, 50: not allowed…). */
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

/** Permissions plugins define, so admins can see and grant them. */
export class Permissions {
  private readonly defined = new Map<string, { description: string; owner: string }>()

  define(name: string, description: string, owner: string) {
    if (owner !== 'noctis' && !name.startsWith(`${owner}.`)) throw new Error(`Plugin permissions must start with "${owner}."`)
    if (!/^[a-z0-9*][a-z0-9._-]*$/.test(name)) throw new Error(`Invalid permission "${name}"`)
    this.defined.set(name, { description, owner })
  }

  list() {
    return [
      ...Object.entries(BUILTIN_PERMISSIONS).map(([name, description]) => ({ name, description, owner: 'noctis' })),
      ...[...this.defined.entries()].map(([name, { description, owner }]) => ({ name, description, owner })),
    ]
  }

  removeOwnedBy(owner: string) {
    for (const [name, entry] of this.defined) if (entry.owner === owner) this.defined.delete(name)
  }
}

const USERNAME = /^[A-Za-z0-9._-]{1,64}$/
const GROUP = /^[a-z0-9][a-z0-9._-]{0,63}$/

export class Accounts {
  private dummyHash: Promise<string> = Bun.password.hash('noctis-dummy-password')

  constructor(private readonly sql: Database) {}

  /** Create the built-in groups if they're missing. */
  async seed() {
    for (const group of BUILTIN_GROUPS) {
      await this.sql`INSERT INTO groups (name, description, permissions, builtin) VALUES (${group.name}, ${group.description}, ${this.sql.array(group.permissions, 'text')}, TRUE) ON CONFLICT (name) DO NOTHING`
    }
  }

  async count(): Promise<number> {
    const [{ n }] = await this.sql`SELECT COUNT(*)::int AS n FROM users`
    return n
  }

  async create(name: string, password: string, groups: string[] = ['users']): Promise<User> {
    if (!USERNAME.test(name)) throw new AuthError(10, 'Usernames are 1–64 letters, digits, ".", "_" or "-"')
    if (password.length < 8) throw new AuthError(10, 'Passwords need at least 8 characters')
    if (await this.find(name)) throw new AuthError(10, 'That username is taken')
    const hash = await Bun.password.hash(password)
    const [row] = await this.sql`INSERT INTO users (name, password_hash, created) VALUES (${name}, ${hash}, ${Date.now()}) RETURNING id`
    await this.setGroups(row.id, groups)
    return (await this.byId(row.id))!
  }

  async byId(id: number): Promise<User | null> {
    const [row] = await this.sql`
      SELECT u.id, u.name,
        COALESCE(array_agg(DISTINCT g.name) FILTER (WHERE g.name IS NOT NULL), '{}') AS groups,
        COALESCE(array_agg(DISTINCT p) FILTER (WHERE p IS NOT NULL), '{}') AS permissions
      FROM users u
      LEFT JOIN user_groups ug ON ug.user_id = u.id
      LEFT JOIN groups g ON g.id = ug.group_id
      LEFT JOIN LATERAL unnest(g.permissions) AS p ON TRUE
      WHERE u.id = ${id}
      GROUP BY u.id`
    return row ? { id: row.id, name: row.name, groups: row.groups, permissions: row.permissions, guest: false } : null
  }

  async find(name: string): Promise<User | null> {
    const [row] = await this.sql`SELECT id FROM users WHERE lower(name) = lower(${name})`
    return row ? this.byId(row.id) : null
  }

  async verifyPassword(name: string, password: string): Promise<User> {
    const [row] = await this.sql`SELECT id, password_hash FROM users WHERE lower(name) = lower(${name})`
    // Verify against a dummy hash for unknown users, so timing doesn't reveal which names exist.
    const ok = await Bun.password.verify(password, row?.password_hash ?? (await this.dummyHash))
    if (!row || !ok) throw new AuthError(40, 'Wrong username or password')
    return (await this.byId(row.id))!
  }

  async setPassword(id: number, password: string) {
    if (password.length < 8) throw new AuthError(10, 'Passwords need at least 8 characters')
    await this.sql`UPDATE users SET password_hash = ${await Bun.password.hash(password)} WHERE id = ${id}`
  }

  async deleteUser(id: number) {
    await this.sql`DELETE FROM users WHERE id = ${id}`
  }

  async users(): Promise<User[]> {
    const rows = await this.sql`SELECT id FROM users ORDER BY lower(name)`
    return (await Promise.all(rows.map((row: { id: number }) => this.byId(row.id)))).filter((user): user is User => user !== null)
  }

  /* ---------------- Groups ---------------- */

  async groups(): Promise<{ name: string; description: string; permissions: string[]; builtin: boolean; members: number }[]> {
    return await this.sql`
      SELECT g.name, g.description, g.permissions, g.builtin, (SELECT COUNT(*)::int FROM user_groups WHERE group_id = g.id) AS members
      FROM groups g ORDER BY g.builtin DESC, g.name`
  }

  async guestPermissions(): Promise<string[]> {
    const [row] = await this.sql`SELECT permissions FROM groups WHERE name = 'guests'`
    return row?.permissions ?? []
  }

  async saveGroup(name: string, fields: { description?: string; permissions: string[] }) {
    if (!GROUP.test(name)) throw new AuthError(10, 'Group names are lowercase letters, digits, ".", "_" or "-"')
    // Admins must stay admins, or nobody could manage the server.
    const permissions = name === 'admins' ? ['*'] : [...new Set(fields.permissions)]
    await this.sql`
      INSERT INTO groups (name, description, permissions) VALUES (${name}, ${fields.description ?? ''}, ${this.sql.array(permissions, 'text')})
      ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions, description = COALESCE(${fields.description ?? null}, groups.description)`
  }

  async deleteGroup(name: string) {
    const [row] = await this.sql`SELECT builtin FROM groups WHERE name = ${name}`
    if (row?.builtin) throw new AuthError(50, `"${name}" is built in and can't be deleted`)
    await this.sql`DELETE FROM groups WHERE name = ${name}`
  }

  async setGroups(userId: number, groups: string[]) {
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM user_groups WHERE user_id = ${userId}`
      if (groups.length === 0) return
      const known = await tx`SELECT id, name FROM groups WHERE name IN ${tx(groups)}`
      if (known.length !== new Set(groups).size) throw new AuthError(70, 'Unknown group')
      for (const group of known) await tx`INSERT INTO user_groups (user_id, group_id) VALUES (${userId}, ${group.id})`
    })
  }
}

export interface SessionInfo {
  userId: number
  label: string
  created: number
}

/** Sessions in Redis, keyed by the token's hash, expiring after `ttlSeconds` without use. */
export class Sessions {
  constructor(
    private readonly redis: RedisClient,
    private readonly accounts: Accounts,
    private readonly ttlSeconds: number,
  ) {}

  private key = (hash: string) => `noctis:session:${hash}`
  private userKey = (userId: number) => `noctis:user-sessions:${userId}`

  /** A new session token; only its hash is stored, so this is the only time it's seen. */
  async create(user: User, label: string): Promise<string> {
    const token = `nk_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`
    const hash = await sha256Hex(token)
    const info: SessionInfo = { userId: user.id, label: label.slice(0, 100), created: Date.now() }
    await this.redis.set(this.key(hash), JSON.stringify(info), 'EX', this.ttlSeconds)
    await this.redis.send('SADD', [this.userKey(user.id), hash])
    return token
  }

  async verify(token: string): Promise<User> {
    const hash = await sha256Hex(token)
    const raw = await this.redis.get(this.key(hash))
    if (!raw) throw new AuthError(44, 'Invalid or expired session')
    const info = JSON.parse(raw) as SessionInfo
    const user = await this.accounts.byId(info.userId)
    if (!user) {
      await this.redis.del(this.key(hash))
      throw new AuthError(44, 'Invalid or expired session')
    }
    // Sliding expiry: a session in use stays alive.
    await this.redis.expire(this.key(hash), this.ttlSeconds)
    return user
  }

  async revoke(token: string) {
    const hash = await sha256Hex(token)
    const raw = await this.redis.get(this.key(hash))
    await this.redis.del(this.key(hash))
    if (raw) await this.redis.send('SREM', [this.userKey((JSON.parse(raw) as SessionInfo).userId), hash])
  }

  /** Sign a user out everywhere (e.g. after a password change or deletion). */
  async revokeAll(userId: number) {
    const hashes = (await this.redis.send('SMEMBERS', [this.userKey(userId)])) as string[]
    for (const hash of hashes) await this.redis.del(this.key(hash))
    await this.redis.del(this.userKey(userId))
  }
}
