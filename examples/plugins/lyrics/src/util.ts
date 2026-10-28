import { Noctis } from './host'
import type { Query } from './types'

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

export interface Reply {
  status: number
  data: unknown
}

/** A request without CORS where the app can make one; a timeout either way. */
export async function http(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  timeoutMs = 10_000,
): Promise<Reply> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      Noctis.libs.http.request(url, init),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${new URL(url).host}`)), timeoutMs)
      }),
    ])
    return { status: response.status, data: response.data }
  } finally {
    clearTimeout(timer)
  }
}

export function asText(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data)
}

/** True where cross-origin requests to arbitrary sites work: devices, not the browser. */
export function hasNativeHttp(): boolean {
  return Noctis.libs.native.platform !== 'web'
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/* ------------------------------------------------------------------ *
 * Matching a song to a search result
 * ------------------------------------------------------------------ */

/** "Song (feat. X) - Remastered 2011" → "song": what a lyrics site would call it. */
export function cleanTitle(title: string): string {
  return title
    .replace(/\s*[([](feat\.?|ft\.?|featuring|with)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s*[([][^)\]]*(remaster|version|edit|mix|live|deluxe|bonus|explicit|mono|stereo)[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+(.*(remaster|version|edit|mix|live|mono|stereo|single).*)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function tokens(text: string): Set<string> {
  return new Set(normalize(text).split(' ').filter(Boolean))
}

/** 0..1: how much of `wanted` shows up in `found`, and the reverse (softer). */
export function similarity(wanted: string, found: string): number {
  const a = normalize(wanted)
  const b = normalize(found)
  if (!a || !b) return 0
  if (a === b) return 1
  const ta = tokens(wanted)
  const tb = tokens(found)
  let shared = 0
  for (const token of ta) if (tb.has(token)) shared++
  const recall = shared / ta.size
  const precision = shared / tb.size
  // Scripts without spaces (CJK) tokenise as one blob, so compare as substrings too.
  const contains = a.includes(b) || b.includes(a) ? 0.85 : 0
  return Math.max(contains, recall * 0.7 + precision * 0.3)
}

export interface Candidate {
  title: string
  artists: string[]
  duration?: number
}

/** 0..1 score of a search result for a query; below ~0.6 it is probably another song. */
export function scoreCandidate(query: Query, candidate: Candidate): number {
  const title = similarity(cleanTitle(query.title), cleanTitle(candidate.title))
  const wantedArtists = query.artists.join(' ')
  const artist = wantedArtists && candidate.artists.length ? Math.max(...candidate.artists.map((name) => similarity(name, wantedArtists)), similarity(candidate.artists.join(' '), wantedArtists)) : 0.5
  let score = title * 0.65 + artist * 0.35
  if (query.duration && candidate.duration) {
    const gap = Math.abs(query.duration - candidate.duration)
    if (gap > 12) score *= 0.5
    else if (gap > 4) score *= 0.85
  }
  return score
}

export function best<T extends Candidate>(query: Query, list: T[], minimum = 0.62): T | null {
  let winner: T | null = null
  let top = minimum
  for (const item of list) {
    const score = scoreCandidate(query, item)
    if (score > top) {
      top = score
      winner = item
    }
  }
  return winner
}

export function searchTerm(query: Query): string {
  return `${cleanTitle(query.title)} ${query.artists[0] ?? ''}`.trim()
}

/* ------------------------------------------------------------------ *
 * A small key-value store in IndexedDB (lyrics are too big for plugin storage)
 * ------------------------------------------------------------------ */

const DB = 'noctis-lyrics'
let opened: Promise<IDBDatabase> | undefined

function open(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('kv')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return opened
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const request = action(db.transaction('kv', mode).objectStore('kv'))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

interface Stored<T> {
  value: T
  at: number
}

export const kv = {
  async get<T>(key: string): Promise<T | undefined> {
    try {
      const entry = await run<Stored<T> | undefined>('readonly', (store) => store.get(key))
      return entry?.value
    } catch {
      return undefined
    }
  },
  async set<T>(key: string, value: T): Promise<void> {
    try {
      await run('readwrite', (store) => store.put({ value, at: Date.now() } satisfies Stored<T>, key))
    } catch {
      /* private mode: no cache */
    }
  },
  async remove(key: string): Promise<void> {
    try {
      await run('readwrite', (store) => store.delete(key))
    } catch {
      /* nothing */
    }
  },
  async clear(): Promise<void> {
    try {
      await run('readwrite', (store) => store.clear())
    } catch {
      /* nothing */
    }
  },
  /** Forget everything except files the user attached (`local:`). */
  async clearCache(): Promise<void> {
    try {
      const db = await open()
      await new Promise<void>((resolve) => {
        const store = db.transaction('kv', 'readwrite').objectStore('kv')
        const cursor = store.openCursor()
        cursor.onsuccess = () => {
          const at = cursor.result
          if (!at) return resolve()
          if (!String(at.key).startsWith('local:')) at.delete()
          at.continue()
        }
        cursor.onerror = () => resolve()
      })
    } catch {
      /* nothing */
    }
  },
  /** Keep the newest `limit` cached entries; attached files are never trimmed. */
  async trim(limit: number): Promise<void> {
    try {
      const db = await open()
      await new Promise<void>((resolve) => {
        const entries: { key: IDBValidKey; at: number }[] = []
        const store = db.transaction('kv', 'readwrite').objectStore('kv')
        const cursor = store.openCursor()
        cursor.onsuccess = () => {
          const at = cursor.result
          if (at) {
            if (!String(at.key).startsWith('local:')) entries.push({ key: at.key, at: (at.value as Stored<unknown>).at })
            at.continue()
            return
          }
          entries.sort((a, b) => b.at - a.at)
          for (const old of entries.slice(limit)) store.delete(old.key)
          resolve()
        }
        cursor.onerror = () => resolve()
      })
    } catch {
      /* nothing */
    }
  },
  async count(): Promise<number> {
    try {
      return await run('readonly', (store) => store.count())
    } catch {
      return 0
    }
  },
}
