import type { StreamInfo } from './models'

const CODECS: [RegExp, string][] = [
  [/opus/i, 'Opus'],
  [/mp4a\.40\.5|mp4a\.40\.29/i, 'HE-AAC'],
  [/mp4a|aac/i, 'AAC'],
  [/flac/i, 'FLAC'],
  [/vorbis/i, 'Vorbis'],
  [/alac/i, 'ALAC'],
  [/ec-3|eac3/i, 'E-AC-3'],
  [/mpeg|mp3/i, 'MP3'],
  [/wav|pcm/i, 'WAV'],
]

/** "Opus • 47 kbps • 48 kHz • 3.4 MB": what a stream is, for the gray line in the player. */
export function streamLabel(stream: StreamInfo): string {
  const codec = CODECS.find(([pattern]) => pattern.test(stream.mimeType))?.[1] ?? stream.mimeType.split(';')[0].replace(/^audio\//, '').toUpperCase()
  return [
    codec,
    stream.bitrate > 0 ? `${Math.round(stream.bitrate / 1000)} kbps` : undefined,
    stream.sampleRate ? `${Number((stream.sampleRate / 1000).toFixed(1))} kHz` : undefined,
    stream.contentLength ? `${(stream.contentLength / 1024 / 1024).toFixed(1)} MB` : undefined,
  ]
    .filter(Boolean)
    .join(' • ')
}
