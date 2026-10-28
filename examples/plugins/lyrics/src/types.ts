import type { Song } from './host'

/** One sung word or syllable. Times are seconds from the start of the song. */
export interface Word {
  start: number
  end: number
  text: string
}

export interface Line {
  /** Seconds; -1 for unsynced (plain) lyrics. */
  start: number
  end: number
  text: string
  words?: Word[]
  /** Background vocals: shown smaller, only while they are sung. */
  bg?: boolean
  /** Duets: which side a line is on. */
  agent?: 'left' | 'right'
  /** An instrumental break (drawn as three dots); `text` is empty. */
  interlude?: boolean
  translation?: string
  romanization?: string
}

export type Sync = 'word' | 'line' | 'none'

export interface Lyrics {
  lines: Line[]
  sync: Sync
  source: string
  sourceName: string
  /** The song has no vocals. */
  instrumental?: boolean
  /** Language of translations the source shipped with its lyrics (ISO 639-1). */
  translationLang?: string
}

/** What a source is asked to find. */
export interface Query {
  song: Song
  title: string
  artists: string[]
  album?: string
  /** Seconds. */
  duration?: number
}

export interface LyricsSource {
  id: string
  name: string
  description: string
  /** Needs the device's HTTP client (no CORS), so it does nothing in a plain browser. */
  native?: boolean
  get(query: Query): Promise<Lyrics | null>
}

/** Turns lines into another language. Providers are pluggable (see README). */
export interface Translator {
  id: string
  name: string
  /** Why it can't run right now (a missing key…); undefined when it can. */
  unavailable(): string | undefined
  translate(lines: string[], target: string, context: { title: string; artists: string[] }): Promise<string[]>
}

/** Writes lines in Latin letters. Returns null for a line it can't do. */
export interface Romanizer {
  id: string
  name: string
  unavailable(): string | undefined
  romanize(lines: string[], context: { title: string; artists: string[]; japanese?: boolean }): Promise<(string | null)[]>
}
