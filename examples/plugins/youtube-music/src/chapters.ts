import { parseChapters, type Chapter } from './chapter-text'
import { innertube } from './client'
import type { Song } from './host'

/**
 * The description comes from the regular YouTube endpoint: YouTube Music's own `getInfo`
 * answers with an empty description for the same video.
 */
export async function getChapters({ song }: { song: Song }): Promise<Chapter[]> {
  const yt = await innertube()
  const info = await yt.getBasicInfo(song.id)
  return parseChapters(info.basic_info.short_description ?? '', song.duration ?? info.basic_info.duration)
}
