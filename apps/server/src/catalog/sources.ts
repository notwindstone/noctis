import type { User } from '../auth'
import type { ServerHooks } from '../plugins/hooks'
import type { PluginManager } from '../plugins/manager'
import { songToChild } from '../subsonic/mappers'
import type { Catalog, SongRow } from './catalog'
import type { Media } from './media'
import type { Providers } from './providers'

/**
 * Where each song can be played from, for Noctis clients ("Play from"). A song can have
 * any number of sources; each says:
 *
 * - whether the server can stream it (`stream`: a /rest/stream URL for that source);
 * - which client-side service could play it instead (`clientService`), which client
 *   plugin provides that service (`clientPlugin`), and where to get the plugin if the
 *   server has it (`install`).
 *
 * Plugins add sources that aren't in the catalog (a mirror, a service only clients can
 * reach…) or reorder them with the `onSources` hook: after { song, user, sources }.
 */

export interface SongSource {
  /** "provider:externalId", stable: pass it back as /rest/stream's `source`. */
  key: string
  provider: string
  /** "YouTube Music", "Local files"… */
  name: string
  externalId: string
  /** A /rest/stream path for exactly this source, or null if the server can't stream it. */
  stream: string | null
  clientService: string | null
  clientPlugin: string | null
  /** Where to download `clientPlugin` from this server, if it has it. */
  install: string | null
  contentType: string | null
  suffix: string | null
  bitRate: number | null
  samplingRate: number | null
  bitDepth: number | null
  channelCount: number | null
  size: number | null
  lossless: boolean
}

export interface SongSources {
  song: ReturnType<typeof songToChild>
  /** The server's default stream (its best source), or null if it can't stream any. */
  stream: string | null
  sources: SongSource[]
}

export class Sources {
  constructor(
    private readonly catalog: Catalog,
    private readonly media: Media,
    private readonly providers: Providers,
    private readonly plugins: PluginManager,
    private readonly hooks: ServerHooks,
  ) {}

  async forSong(song: SongRow, user: User): Promise<SongSources> {
    const rows = await this.catalog.sources(song.id)
    const streamable = new Set((await this.media.streamable(song.id)).map((source) => `${source.provider}:${source.external_id}`))
    const id = encodeURIComponent(song.id)
    const sources: SongSource[] = rows.map((row) => {
      const key = `${row.provider}:${row.external_id}`
      const provider = this.providers.get(row.provider)
      const clientPlugin = provider?.clientPlugin ?? null
      return {
        key,
        provider: row.provider,
        name: provider?.name ?? row.provider,
        externalId: row.external_id,
        stream: streamable.has(key) ? `/rest/stream?id=${id}&source=${encodeURIComponent(key)}` : null,
        clientService: provider?.clientService ?? null,
        clientPlugin,
        install: clientPlugin && this.plugins.clientArchive(clientPlugin) ? `/noctis/v1/plugins/${clientPlugin}/client.noctis` : null,
        contentType: row.content_type,
        suffix: row.suffix,
        bitRate: row.bitrate,
        samplingRate: row.sample_rate,
        bitDepth: row.bit_depth,
        channelCount: row.channels,
        size: row.size,
        lossless: row.lossless,
      }
    })
    const result = { song, user, sources }
    const after = await this.hooks.run<SongSource[]>('onSources', 'after', result)
    const final = after.stopped ? after.response : result.sources
    return { song: songToChild(song), stream: final.some((source) => source.stream) ? `/rest/stream?id=${id}` : null, sources: final }
  }

  /** Sources for many songs at once (e.g. a whole queue), in one round trip. */
  async forSongs(ids: string[], user: User): Promise<Record<string, SongSources>> {
    const songs = await this.catalog.songs(ids, user.id)
    const entries = await Promise.all(songs.map(async (song) => [song.id, await this.forSong(song, user)] as const))
    return Object.fromEntries(entries)
  }
}
