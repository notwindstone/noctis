import { readdir, stat } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { parseFile, selectCover } from 'music-metadata'

/**
 * Local library: audio files on the server, as a server plugin.
 *
 * - Directories: set by an admin with PUT /api/plugins/local-library/directories, or
 *   on first start from LOCAL_LIBRARY_DIRS (separated by ":"). Kept in plugin storage.
 * - Scanning: at startup and on OpenSubsonic startScan (it registers a scanner), or
 *   POST /api/plugins/local-library/scan.
 * - Streaming: the "local" provider, so every client, Noctis or OpenSubsonic, can play
 *   the files. Source ids are "<directory hash>/<relative path>": server paths never
 *   reach clients, and a file can't be served from outside the directories.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Scope = { Plugin: any; Noctis: any }

const AUDIO = new Set(['.mp3', '.flac', '.ogg', '.opus', '.m4a', '.aac', '.wav', '.aiff', '.aif', '.wma', '.ape', '.wv', '.mpc', '.webm'])
const LOSSLESS = new Set(['flac', 'alac', 'wav', 'aiff', 'ape', 'wavpack', 'pcm'])
const COVER_FILES = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'front.png']
const CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.webm': 'audio/webm',
}

const hashOf = (dir: string) => new Bun.CryptoHasher('sha1').update(dir).digest('hex').slice(0, 10)

async function* walk(dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    // Symlinks aren't followed: everything served stays inside the directories.
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile() && AUDIO.has(extname(entry.name).toLowerCase())) yield path
  }
}

export default async function localLibrary({ Plugin, Noctis }: Scope) {
  const { t } = Noctis.packages.elysia
  const { catalog, auth } = Noctis

  let directories: string[] = await Plugin.storage.get('directories', null)
  if (!directories) {
    directories = (process.env.LOCAL_LIBRARY_DIRS ?? '').split(':').filter(Boolean).map((dir) => resolve(dir))
    await Plugin.storage.set('directories', directories)
  }
  const byHash = () => new Map(directories.map((dir) => [hashOf(dir), dir]))

  const status = { scanning: false, count: 0, lastScan: undefined as number | undefined }

  /** A source id back to a path, only if it's inside a configured directory. */
  function pathOf(externalId: string): string | null {
    const slash = externalId.indexOf('/')
    const dir = byHash().get(externalId.slice(0, slash))
    if (!dir) return null
    const full = resolve(dir, externalId.slice(slash + 1))
    return full.startsWith(dir + sep) ? full : null
  }

  async function add(file: string, id: string) {
    const { common, format } = await parseFile(file, { duration: false, skipCovers: true })
    const extension = extname(file).toLowerCase()
    const name = file.split(sep).pop()!.replace(/\.[^.]+$/, '')
    const codec = (format.codec ?? '').toLowerCase()
    await catalog.upsertSong({
      title: common.title ?? name,
      artist: common.artist ?? common.albumartist ?? 'Unknown artist',
      album: common.album,
      albumArtist: common.albumartist,
      track: common.track.no ?? undefined,
      disc: common.disk.no ?? undefined,
      year: common.year,
      genre: common.genre?.[0],
      duration: format.duration,
      cover: `local:${id}`,
      source: {
        provider: 'local',
        externalId: id,
        contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
        suffix: extension.slice(1),
        bitrate: format.bitrate ? format.bitrate / 1000 : undefined,
        sampleRate: format.sampleRate,
        bitDepth: format.bitsPerSample,
        channels: format.numberOfChannels,
        size: (await stat(file)).size,
        lossless: format.lossless ?? LOSSLESS.has(codec),
      },
    })
  }

  async function scan(): Promise<number> {
    if (status.scanning) return status.count
    status.scanning = true
    status.count = 0
    const seen = new Set<string>()
    const started = performance.now()
    try {
      for (const dir of directories) {
        const hash = hashOf(dir)
        for await (const file of walk(dir)) {
          const id = `${hash}/${relative(dir, file).split(sep).join('/')}`
          try {
            await add(file, id)
            seen.add(id)
            status.count++
          } catch (error) {
            Plugin.warn(`Couldn't read ${id}:`, error)
          }
        }
      }
      const removed = await catalog.removeSources('local', seen)
      Plugin.log(`Scanned ${status.count} files in ${directories.length} ${directories.length === 1 ? 'directory' : 'directories'} in ${((performance.now() - started) / 1000).toFixed(1)} s${removed ? ` (${removed} gone)` : ''}`)
    } finally {
      status.scanning = false
      status.lastScan = Date.now()
    }
    return status.count
  }

  Plugin.permissions.define('local-library.manage', 'Choose the directories of the local library and rescan it')

  function attach() {
    Plugin.defineProvider('local', {
      name: 'Local files',
      async stream({ source }: { source: { external_id: string; content_type: string | null } }) {
        const path = pathOf(source.external_id)
        if (!path) throw new Error('Not in the library directories')
        const file = Bun.file(path)
        if (!(await file.exists())) throw new Error('The file is gone; rescan the library')
        return new Response(file, { headers: { 'content-type': source.content_type ?? file.type } })
      },
      async cover(reference: string) {
        const path = pathOf(reference.slice('local:'.length))
        if (!path) return null
        try {
          const { common } = await parseFile(path, { duration: false })
          const picture = selectCover(common.picture)
          if (picture) return new Response(picture.data, { headers: { 'content-type': picture.format } })
        } catch {
          /* fall back to a cover file */
        }
        const dir = path.slice(0, path.lastIndexOf(sep))
        for (const name of COVER_FILES) {
          const file = Bun.file(join(dir, name))
          if (await file.exists()) return new Response(file)
        }
        return null
      },
    })

    Plugin.defineScanner('local', { name: 'Local library', scan, status: () => ({ ...status }) })

    // Admin routes: which directories, and rescans.
    const allowed = async (request: Request) => {
      const user = await auth.userFrom(request)
      return user && auth.can(user, 'local-library.manage') ? user : null
    }
    Plugin.routes((app: any) =>
      app
        .get('/directories', async ({ request, status: reply }: any) => {
          if (!(await allowed(request))) return reply(403, { error: 'Not allowed' })
          return { directories, scan: status }
        })
        .put('/directories', { body: t.Object({ directories: t.Array(t.String({ minLength: 1, maxLength: 4096 }), { maxItems: 50 }) }) }, async ({ request, body, status: reply }: any) => {
          if (!(await allowed(request))) return reply(403, { error: 'Not allowed' })
          const next: string[] = []
          for (const dir of body.directories as string[]) {
            const full = resolve(dir)
            const info = await stat(full).catch(() => null)
            if (!info?.isDirectory()) return reply(400, { error: `"${dir}" isn't a directory on the server` })
            next.push(full)
          }
          directories = [...new Set(next)]
          await Plugin.storage.set('directories', directories)
          void scan()
          return { directories, scan: { ...status, scanning: true } }
        })
        .post('/scan', async ({ request, status: reply }: any) => {
          if (!(await allowed(request))) return reply(403, { error: 'Not allowed' })
          void scan()
          return { ...status, scanning: true }
        }),
    )
  }

  Plugin.subscribe('lifecycle::disable', () => Plugin.removeAll())
  Plugin.subscribe('lifecycle::dirty-enable', attach)
  attach()
  if ((await Plugin.storage.get('scanOnStart', true)) && directories.length > 0) void scan()
}
