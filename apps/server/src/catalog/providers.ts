import type { SongRow, SourceRow } from './catalog'

/**
 * Providers: where audio comes from, all defined by plugins (`Plugin.defineProvider`):
 * the local-library plugin for files on the server, service plugins for the rest. A provider streams the songs it added to the catalog, so
 * the server can play them to any client, including OpenSubsonic apps that know
 * nothing about Noctis. Noctis clients also see each source and may play it from their
 * own client-side service instead (see /api/noctis/v1/songs/:id/sources).
 */

export interface StreamRequest {
  song: SongRow
  source: SourceRow
  /** The client's Range header, if any; forward it to support seeking. */
  range?: string
  /** Target bitrate the client asked for (kbps); providers may ignore it. */
  maxBitRate?: number
}

export interface Provider {
  /** "YouTube Music", "Local files"… */
  name: string
  /**
   * Audio for a source: a Response (streamed to the client as is, so honour `range`),
   * or a URL the server fetches and relays. Throw if it can't be played.
   *
   * Leave it out for a provider only clients can play (e.g. a service the server can't
   * reach): its sources are listed for Noctis clients, with `clientService`, but never
   * streamed by the server.
   */
  stream?(request: StreamRequest): Promise<Response | string>
  /** Artwork for a cover reference "<provider>:<rest>": a Response or a URL. */
  cover?(reference: string): Promise<Response | string | null>
  /**
   * For Noctis clients: the client-side service that can play this provider's sources
   * itself (a client plugin's service id, e.g. "youtube-music"). Omit if there's none.
   */
  clientService?: string
  /**
   * The id of the client plugin that provides `clientService`, so clients without it
   * can be told what to install. If the server has that plugin as a "both" plugin,
   * clients can download it from the server.
   */
  clientPlugin?: string
}

/** Something that fills the catalog, which startScan / getScanStatus drive (e.g. a library plugin). */
export interface Scanner {
  name: string
  /** Start a scan; resolves when it's done. */
  scan(): Promise<unknown>
  status(): { scanning: boolean; count: number; lastScan?: number }
}

export class Scanners {
  private readonly entries = new Map<string, { scanner: Scanner; owner: string }>()

  define(id: string, scanner: Scanner, owner: string) {
    this.entries.set(id, { scanner, owner })
  }

  remove(id: string) {
    this.entries.delete(id)
  }

  /** Every scanner's status, summed for OpenSubsonic's getScanStatus. */
  status() {
    const all = [...this.entries.values()].map(({ scanner }) => scanner.status())
    return { scanning: all.some((status) => status.scanning), count: all.reduce((sum, status) => sum + status.count, 0) }
  }

  scanAll() {
    return Promise.allSettled([...this.entries.values()].map(({ scanner }) => scanner.scan()))
  }
}

export class Providers {
  private readonly entries = new Map<string, { provider: Provider; owner: string }>()

  define(id: string, provider: Provider, owner: string) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error(`Invalid provider id "${id}"`)
    this.entries.set(id, { provider, owner })
  }

  remove(id: string) {
    this.entries.delete(id)
  }

  get(id: string): Provider | undefined {
    return this.entries.get(id)?.provider
  }

  list() {
    // `streams`: whether the server can play its sources (an indexer like MusicBrainz can't).
    return [...this.entries.entries()].map(([id, { provider, owner }]) => ({ id, name: provider.name, owner, streams: Boolean(provider.stream), clientService: provider.clientService, clientPlugin: provider.clientPlugin }))
  }
}
