import type { Line, Sync, Word } from './types'

/**
 * Lyric formats → lines. All times in seconds.
 *
 * - LRC, including "enhanced" LRC with `<mm:ss.xx>` word times;
 * - NetEase YRC (`[start,duration](start,duration,0)word…`, milliseconds);
 * - Musixmatch's line ("mxm") and word ("richsync") JSON;
 * - TTML (Apple's format: `<p begin end>` with `<span>` words, agents and background vocals);
 * - SRT, and plain text.
 */

const TIME = /(\d+):(\d{1,2})(?:[.:](\d{1,3}))?/

function seconds(minutes: string, secs: string, fraction?: string): number {
  const frac = fraction ? Number(`0.${fraction}`) : 0
  return Number(minutes) * 60 + Number(secs) + frac
}

/** Close the gaps: a line ends where the next begins unless it says otherwise. */
export function finishTimes(lines: Line[], duration?: number): Line[] {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const next = lines.slice(i + 1).find((item) => !item.bg && item.start >= 0)
    const fallback = next ? next.start : duration && duration > line.start ? duration : line.start + 5
    if (line.words?.length) {
      const last = line.words[line.words.length - 1]
      if (!(line.end > line.start)) line.end = Math.max(last.end, line.start)
      // Words that run on to the next one's start: the last one ends with the line.
      if (!(last.end > last.start)) last.end = Math.max(line.end, fallback)
    }
    if (!(line.end > line.start)) line.end = Math.max(fallback, line.start)
  }
  return lines
}

export function sortLines(lines: Line[]): Line[] {
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => a.line.start - b.line.start || a.index - b.index)
    .map((entry) => entry.line)
}

/* ------------------------------------------------------------------ *
 * LRC
 * ------------------------------------------------------------------ */

export function parseLrc(text: string): Line[] {
  const lines: Line[] = []
  let offset = 0
  for (const raw of text.split(/\r?\n/)) {
    const row = raw.trim()
    if (!row || row.startsWith('{')) continue // NetEase puts credits there as JSON
    const meta = /^\[([a-z]+):(.*)\]$/i.exec(row)
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') offset = Number(meta[2]) / 1000 || 0
      continue
    }
    const stamps: number[] = []
    let rest = row
    for (let m = /^\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(rest); m; m = /^\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(rest)) {
      stamps.push(seconds(m[1], m[2], m[3]))
      rest = rest.slice(m[0].length)
    }
    if (stamps.length === 0) continue

    // Enhanced LRC: "<00:12.00>word <00:12.50>word"
    const words: Word[] = []
    let plain = rest
    if (/<\d+:\d{1,2}[.:]\d{1,3}>/.test(rest)) {
      const parts = rest.split(/<(\d+:\d{1,2}[.:]\d{1,3})>/)
      plain = parts[0]
      for (let i = 1; i < parts.length; i += 2) {
        const at = TIME.exec(parts[i])
        if (!at) continue
        const start = seconds(at[1], at[2], at[3])
        const wordText = parts[i + 1] ?? ''
        if (wordText === '') {
          // A bare closing stamp: it ends the previous word.
          if (words.length) words[words.length - 1].end = start
          continue
        }
        if (words.length && !(words[words.length - 1].end > words[words.length - 1].start)) words[words.length - 1].end = start
        words.push({ start, end: start, text: wordText })
      }
      plain = words.map((word) => word.text).join('')
    }

    const bg = /^\(.*\)$/.test(plain.trim()) && plain.trim().length > 2
    for (const stamp of stamps) {
      const start = stamp + offset
      lines.push({
        start,
        end: 0,
        text: (bg ? plain.trim().slice(1, -1) : plain).trim(),
        bg: bg || undefined,
        words: words.length ? words.map((word) => ({ ...word, start: word.start + offset, end: word.end + offset })) : undefined,
      })
    }
  }
  return sortLines(lines)
}

/* ------------------------------------------------------------------ *
 * NetEase YRC
 * ------------------------------------------------------------------ */

const YRC_WORD = /\((\d+),(\d+),-?\d+\)((?:(?!\(\d+,\d+,-?\d+\)).)*)/gs

export function parseYrc(text: string): Line[] {
  const lines: Line[] = []
  for (const raw of text.split(/\r?\n/)) {
    const head = /^\[(\d+),(\d+)\](.*)$/s.exec(raw.trim())
    if (!head) continue
    const start = Number(head[1]) / 1000
    const end = (Number(head[1]) + Number(head[2])) / 1000
    const words: Word[] = []
    for (const m of head[3].matchAll(YRC_WORD)) {
      words.push({ start: Number(m[1]) / 1000, end: (Number(m[1]) + Number(m[2])) / 1000, text: m[3] })
    }
    if (words.length === 0) continue
    let joined = words.map((word) => word.text).join('')
    const bg = /^\s*[(（].*[)）]\s*$/.test(joined)
    if (bg) {
      // "(Ahh)" is a background line: drop the brackets from the first and last word.
      words[0].text = words[0].text.replace(/^\s*[(（]/, '')
      words[words.length - 1].text = words[words.length - 1].text.replace(/[)）]\s*$/, '')
      joined = words.map((word) => word.text).join('')
    }
    lines.push({ start, end, text: joined.trim(), words: mergeWhitespace(words), bg: bg || undefined })
  }
  return sortLines(lines)
}

/** Whitespace-only pieces belong to the word before them. */
function mergeWhitespace(words: Word[]): Word[] {
  const out: Word[] = []
  for (const word of words) {
    if (word.text.trim() === '' && out.length) out[out.length - 1].text += word.text
    else out.push({ ...word })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Musixmatch
 * ------------------------------------------------------------------ */

interface MxmLine {
  text: string
  time: { total: number }
}

/** `subtitle_format=mxm`: `[{ text, time: { total } }]`. */
export function parseMxmSubtitle(body: string): Line[] {
  const list = JSON.parse(body) as MxmLine[]
  return sortLines(list.map((item) => ({ start: item.time.total, end: 0, text: (item.text ?? '').trim() })))
}

interface RichsyncLine {
  ts: number
  te: number
  x: string
  l: { c: string; o: number }[]
}

/** Richsync: lines of `{ c: characters, o: offset from the line start }`. */
export function parseMxmRichsync(body: string): Line[] {
  const list = JSON.parse(body) as RichsyncLine[]
  const lines: Line[] = []
  for (const item of list) {
    const pieces = item.l.map((piece) => ({ text: piece.c, start: item.ts + piece.o, end: 0 }))
    const words: Word[] = []
    for (let i = 0; i < pieces.length; i++) {
      pieces[i].end = i + 1 < pieces.length ? pieces[i + 1].start : item.te
      if (pieces[i].text.trim() === '' && words.length) {
        words[words.length - 1].text += pieces[i].text
        words[words.length - 1].end = pieces[i].end
      } else {
        words.push({ ...pieces[i] })
      }
    }
    const bg = /^\(.*\)$/.test(item.x.trim()) && item.x.trim().length > 2
    lines.push({ start: item.ts, end: item.te, text: (item.x ?? '').trim(), words: words.length ? words : undefined, bg: bg || undefined })
  }
  return sortLines(lines)
}

/* ------------------------------------------------------------------ *
 * TTML
 * ------------------------------------------------------------------ */

function clock(value: string | null): number {
  if (!value) return NaN
  const v = value.trim()
  if (v.endsWith('s')) return Number(v.slice(0, -1))
  const parts = v.split(':').map(Number)
  if (parts.some(Number.isNaN)) return NaN
  return parts.reduce((total, part) => total * 60 + part, 0)
}

export function parseTtml(text: string): { lines: Line[]; sync: Sync } {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('Not valid TTML')
  const lines: Line[] = []
  let word = false
  const agents = new Map<string, 'left' | 'right'>()
  for (const agent of Array.from(doc.getElementsByTagNameNS('*', 'agent'))) {
    const id = agent.getAttribute('xml:id')
    if (id) agents.set(id, agents.size % 2 === 0 ? 'left' : 'right')
  }

  for (const p of Array.from(doc.getElementsByTagNameNS('*', 'p'))) {
    const start = clock(p.getAttribute('begin'))
    const end = clock(p.getAttribute('end'))
    if (Number.isNaN(start)) continue
    const agentId = p.getAttribute('ttm:agent') ?? p.getAttributeNS('*', 'agent')
    const agent = agentId && agents.size > 1 ? agents.get(agentId) : undefined

    const collect = (root: Element): Word[] => {
      const words: Word[] = []
      for (const node of Array.from(root.childNodes)) {
        if (node.nodeType === 3) {
          const value = node.textContent ?? ''
          if (value.trim() === '' && words.length) words[words.length - 1].text += ' '
          continue
        }
        const el = node as Element
        if (el.localName !== 'span') continue
        const role = el.getAttribute('ttm:role') ?? el.getAttributeNS('*', 'role')
        if (role === 'x-bg') continue
        const ws = clock(el.getAttribute('begin'))
        const we = clock(el.getAttribute('end'))
        if (Number.isNaN(ws)) continue
        words.push({ start: ws, end: we, text: el.textContent ?? '' })
      }
      return words
    }

    const words = collect(p)
    if (words.length) word = true
    const main = words.length ? words.map((item) => item.text).join('') : (p.textContent ?? '')
    lines.push({ start, end: Number.isNaN(end) ? 0 : end, text: main.trim(), words: words.length ? words : undefined, agent })

    for (const span of Array.from(p.getElementsByTagNameNS('*', 'span'))) {
      const role = span.getAttribute('ttm:role') ?? span.getAttributeNS('*', 'role')
      if (role !== 'x-bg') continue
      const bgWords = collect(span)
      const bgText = (bgWords.length ? bgWords.map((item) => item.text).join('') : (span.textContent ?? '')).replace(/^\(|\)$/g, '').trim()
      if (bgWords.length) {
        bgWords[0].text = bgWords[0].text.replace(/^\(/, '')
        bgWords[bgWords.length - 1].text = bgWords[bgWords.length - 1].text.replace(/\)$/, '')
      }
      const bs = clock(span.getAttribute('begin'))
      const be = clock(span.getAttribute('end'))
      if (bgText) lines.push({ start: Number.isNaN(bs) ? start : bs, end: Number.isNaN(be) ? 0 : be, text: bgText, words: bgWords.length ? bgWords : undefined, bg: true, agent })
    }
  }
  return { lines: sortLines(lines), sync: word ? 'word' : 'line' }
}

/* ------------------------------------------------------------------ *
 * SRT and plain text
 * ------------------------------------------------------------------ */

export function parseSrt(text: string): Line[] {
  const lines: Line[] = []
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const rows = block.split('\n')
    const at = rows.findIndex((row) => row.includes('-->'))
    if (at === -1) continue
    const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/.exec(rows[at])
    if (!m) continue
    const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`)
    const end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(`0.${m[8]}`)
    const body = rows.slice(at + 1).join(' ').replace(/<[^>]+>/g, '').trim()
    if (body) lines.push({ start, end, text: body })
  }
  return sortLines(lines)
}

export function parsePlain(text: string): Line[] {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((row) => row.trimEnd())
    .map((row): Line => ({ start: -1, end: -1, text: row }))
}

/** Guess the format of a file the user picked. */
export function parseAny(text: string, name = ''): { lines: Line[]; sync: Sync } {
  const lower = name.toLowerCase()
  const trimmed = text.replace(/^﻿/, '').trim()
  if (lower.endsWith('.ttml') || lower.endsWith('.xml') || trimmed.startsWith('<')) return parseTtml(trimmed)
  if (lower.endsWith('.srt') || /^\d+\s*\n\d+:\d+:\d+[,.]\d+\s*-->/.test(trimmed)) return { lines: parseSrt(trimmed), sync: 'line' }
  if (/^\[\d+,\d+\]\(/m.test(trimmed)) return { lines: parseYrc(trimmed), sync: 'word' }
  const lrc = parseLrc(trimmed)
  if (lrc.length > 0) return { lines: lrc, sync: lrc.some((line) => line.words?.length) ? 'word' : 'line' }
  return { lines: parsePlain(trimmed), sync: 'none' }
}

/* ------------------------------------------------------------------ *
 * Translations that come as a second LRC
 * ------------------------------------------------------------------ */

/**
 * Attach a second set of lines (a translation or a romanization) to `lines` by time:
 * each goes to the line starting closest to it, within a second and a half.
 */
export function attachByTime(lines: Line[], other: Line[], field: 'translation' | 'romanization'): number {
  let attached = 0
  const real = lines.filter((line) => !line.bg && line.start >= 0)
  for (const item of other) {
    if (!item.text.trim()) continue
    let best: Line | undefined
    let distance = 1.5
    for (const line of real) {
      const d = Math.abs(line.start - item.start)
      if (d < distance) {
        distance = d
        best = line
      }
    }
    if (best && !best[field]) {
      best[field] = item.text.trim()
      attached++
    }
  }
  return attached
}

/**
 * Credit lines some catalogues put at the top ("作词：…", "Lyrics by: …", "Song - Artist"):
 * they are tags, not lyrics. Only the first few lines are looked at.
 */
const CREDIT = /^(?:[\u4e00-\u9fff]{1,8}|lyrics|lyricist|music|composer|composed|written|arranged|arrangement|producer|produced|mixed|mastered|guitar|bass|drums|keyboards?|vocals?)(?:\s+by)?\s*[:：]|^[A-Za-z][A-Za-z &/]{1,24}\s*：/i

export function dropCredits(lines: Line[], title?: string): Line[] {
  const head = Math.min(lines.length, 12)
  let skip = 0
  for (let i = 0; i < head; i++) {
    const text = lines[i].text.trim()
    const isTitle = i < 2 && lines[i].start <= 1 && / - /.test(text) && (!title || text.toLowerCase().includes(title.toLowerCase().slice(0, 6)))
    if (CREDIT.test(text) || isTitle || (text === '' && skip === i)) skip = i + 1
    else if (i >= skip) break
  }
  return lines.slice(skip)
}
