/**
 * Chapters of a long upload (a mix, a whole album in one file), read from the track list
 * its description carries: "0:00 First song", "1. 03:17 - Second song"… YouTube itself
 * only makes chapters from a list that starts at 0:00 and has at least three entries;
 * the same rules keep a stray time in a description from becoming one.
 */
export interface Chapter {
  title: string
  start: number
}

const TIME = String.raw`(\d{1,2}(?::\d{2}){1,2})`
const TIME_FIRST = new RegExp(String.raw`^\W*(?:\d+[.)]\s+)?[\[(]?${TIME}[\])]?\s*[-–—:|.)]*\s*(.+)$`)
const TITLE_FIRST = new RegExp(String.raw`^(.+?)\s*[-–—:|(\[]*\s*${TIME}[\])]?$`)

const seconds = (time: string) => time.split(':').reduce((total, part) => total * 60 + Number(part), 0)

export function parseChapters(description: string, duration?: number): Chapter[] {
  const found: Chapter[] = []
  for (const line of description.split(/\r?\n/)) {
    const text = line.trim()
    const match = TIME_FIRST.exec(text) ?? TITLE_FIRST.exec(text)
    if (!match) continue
    // The two patterns put the time in a different group.
    const [time, title] = TIME_FIRST.test(text) ? [match[1], match[2]] : [match[2], match[1]]
    const cleaned = title.replace(/^[\s\-–—:|.)]+|[\s\-–—:|(\[]+$/g, '').trim()
    if (cleaned) found.push({ title: cleaned, start: seconds(time) })
  }
  const ordered = found.every((chapter, index) => index === 0 || chapter.start > found[index - 1].start)
  if (found.length < 3 || found[0].start !== 0 || !ordered) return []
  return duration ? found.filter((chapter) => chapter.start < duration) : found
}
