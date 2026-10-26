import { Noctis } from './host'

/**
 * API instances, as in Monochrome (monochrome.st): community-run servers this plugin
 * talks to. Three kinds, detected when one is added:
 *
 * - "hifi": hifi-api (github.com/uimaxbai/hifi-api), a TIDAL proxy: the "API instances"
 *   in Monochrome's INSTANCES.md. Search, albums, artists, playlists, lossless streams.
 * - "tracks": the Music API Proxy & Track Streamer (tracks.monochrome.st), Monochrome's
 *   newer catalog: search, releases, artists, and FLAC at /track/:id.
 * - "deezer": a Deezer streaming instance (Monochrome's Deezer fallback): FLAC by ISRC.
 *
 * Requests go to a random instance of the right kind and move on to the next when one
 * is down, rate-limited (429) or failing (5xx), like Monochrome's fetchWithRetry.
 */

export type InstanceKind = 'tracks' | 'hifi' | 'deezer'

export interface Instance {
  url: string
  kind: InstanceKind
  version?: string
}

export const OFFICIAL = 'https://tracks.monochrome.st'

/** From Monochrome's INSTANCES.md (API instances) and its Deezer fallback default, as one-tap suggestions. */
export const SUGGESTED: Instance[] = [
  { url: 'https://api.monochrome.tf', kind: 'hifi' },
  { url: 'https://wolf.qqdl.site', kind: 'hifi' },
  { url: 'https://maus.qqdl.site', kind: 'hifi' },
  { url: 'https://vogel.qqdl.site', kind: 'hifi' },
  { url: 'https://katze.qqdl.site', kind: 'hifi' },
  { url: 'https://hund.qqdl.site', kind: 'hifi' },
  { url: 'https://tidal.kinoplus.online', kind: 'hifi' },
  { url: OFFICIAL, kind: 'tracks' },
  { url: 'https://dzr.tabs-vs-spaces.wtf', kind: 'deezer' },
]

const { http } = Noctis.libs
const { ref } = Noctis.packages.vue

interface Storage {
  get<T>(key: string, fallback?: T): T | undefined
  set(key: string, value: unknown): void
}

let storage: Storage
export const instances = ref<Instance[]>([])

export function initInstances(pluginStorage: Storage) {
  storage = pluginStorage
  instances.value = storage.get<Instance[]>('instances', []) ?? []
}

function save() {
  storage.set('instances', instances.value)
}

export const hasKind = (kind: InstanceKind) => instances.value.some((instance) => instance.kind === kind)

export class InstanceError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message)
  }
}

function normalize(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '')
  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

async function getJson(url: string): Promise<{ status: number; data: unknown }> {
  const response = await http.request(url, { headers: { accept: 'application/json' } })
  return { status: response.status, data: response.data }
}

/** What kind of instance `url` is, by asking it; throws if it's neither. */
async function detect(url: string): Promise<Instance> {
  const tracks = await getJson(`${url}/search/tracks?q=a&limit=1`).catch(() => null)
  if (tracks?.status === 200 && Array.isArray((tracks.data as { tracks?: unknown })?.tracks)) return { url, kind: 'tracks' }
  const root = await getJson(`${url}/`).catch(() => null)
  const version = (root?.data as { version?: string } | null)?.version
  if (root?.status === 200 && typeof version === 'string') return { url, kind: 'hifi', version }
  const deezer = await http.request(`${url}/stream/?isrc=GBAYE9200070&format=MP3_128`, { headers: { range: 'bytes=0-0' } }).catch(() => null)
  if (deezer && (deezer.status === 200 || deezer.status === 206)) return { url, kind: 'deezer' }
  throw new InstanceError("That isn't a Monochrome API instance (hifi-api, tracks API or Deezer), or it's down")
}

/** Add an instance; with `kind` (a suggestion), even while it's unreachable from here. */
export async function addInstance(input: string, kind?: InstanceKind): Promise<Instance> {
  let url: string
  try {
    url = normalize(input)
  } catch {
    throw new InstanceError("That isn't a valid address")
  }
  if (instances.value.some((instance) => instance.url === url)) throw new InstanceError('That instance is already added')
  const instance = await detect(url).catch((error) => {
    if (kind) return { url, kind }
    throw error
  })
  instances.value = [...instances.value, instance]
  save()
  return instance
}

export function removeInstance(url: string) {
  instances.value = instances.value.filter((instance) => instance.url !== url)
  save()
}

/** Instances of a kind, starting at a random one (spreading the load, as Monochrome does). */
export function rotation(kind: InstanceKind): Instance[] {
  const list = instances.value.filter((instance) => instance.kind === kind)
  if (list.length === 0) {
    throw new InstanceError(
      kind === 'tracks'
        ? 'Add a Monochrome API instance first: Settings → Monochrome (tracks.monochrome.st is the official one)'
        : 'This needs a hifi-api instance: add one in Settings → Monochrome',
    )
  }
  const start = Math.floor(Math.random() * list.length)
  return [...list.slice(start), ...list.slice(0, start)]
}

/** GET `path` from instances of `kind` until one answers. 404 isn't retried elsewhere. */
export async function call<T>(kind: InstanceKind, path: string): Promise<T> {
  let lastError: Error | null = null
  for (const instance of rotation(kind)) {
    let response: { status: number; data: unknown }
    try {
      response = await getJson(`${instance.url}${path}`)
    } catch (error) {
      lastError = error as Error
      continue
    }
    if (response.status >= 200 && response.status < 300) return response.data as T
    if (response.status === 404) throw new InstanceError('Not found on this instance', 404)
    lastError = new InstanceError(`${new URL(instance.url).host} answered HTTP ${response.status}`, response.status)
  }
  throw lastError ?? new InstanceError('No instance answered')
}
