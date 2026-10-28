import { describe, expect, test } from 'bun:test'
import { attachByTime, dropCredits, finishTimes, parseLrc, parseMxmRichsync, parseSrt, parseYrc } from '../src/parse'
import { romanizeLine, scriptOf } from '../src/romanize'

describe('LRC', () => {
  test('timestamps, several per line, and offset', () => {
    const lines = parseLrc('[offset:500]\n[ar:Someone]\n[00:10.00][00:20.50]Chorus\n[00:12.5]Verse')
    expect(lines.map((line) => [line.text, line.start])).toEqual([
      ['Chorus', 10.5],
      ['Verse', 13],
      ['Chorus', 21],
    ])
  })

  test('enhanced LRC gives words', () => {
    const [line] = parseLrc('[00:01.00]<00:01.00>Hel<00:01.40>lo <00:02.00>world<00:02.50>')
    expect(line.text).toBe('Hello world')
    expect(line.words?.map((word) => [word.text, word.start])).toEqual([['Hel', 1], ['lo ', 1.4], ['world', 2]])
    expect(line.words?.[2].end).toBe(2.5)
  })

  test('NetEase credit lines are skipped', () => {
    expect(parseLrc('{"t":0,"c":[{"tx":"作曲: "}]}\n[00:01.00]Real')).toHaveLength(1)
  })
})

describe('YRC', () => {
  test('words with their own times, brackets inside text', () => {
    const [line] = parseYrc('[4090,3000](4090,500,0)Hello (4590,500,0)(world)(5090,1000,0)!')
    expect(line.start).toBeCloseTo(4.09)
    expect(line.words?.map((word) => word.text)).toEqual(['Hello ', '(world)', '!'])
  })

  test('a whole bracketed line is background vocals', () => {
    const [line] = parseYrc('[1000,2000](1000,1000,0)(Ooh (2000,1000,0)ooh)')
    expect(line.bg).toBe(true)
    expect(line.text).toBe('Ooh ooh')
  })
})

describe('Musixmatch richsync', () => {
  test('character offsets become words', () => {
    const [line] = parseMxmRichsync(JSON.stringify([{ ts: 10, te: 14, x: 'Hi you', l: [{ c: 'Hi', o: 0 }, { c: ' ', o: 1 }, { c: 'you', o: 2 }] }]))
    expect(line.words?.map((word) => [word.text, word.start, word.end])).toEqual([['Hi ', 10, 12], ['you', 12, 14]])
  })
})

describe('times', () => {
  test('lines end where the next one begins', () => {
    const lines = finishTimes(parseLrc('[00:01.00]a\n[00:05.00]b'), 20)
    expect(lines.map((line) => line.end)).toEqual([5, 20])
  })

  test('a translation joins the closest line', () => {
    const lines = parseLrc('[00:01.00]hello\n[00:05.00]bye')
    attachByTime(lines, parseLrc('[00:01.20]привет\n[00:05.10]пока'), 'translation')
    expect(lines.map((line) => line.translation)).toEqual(['привет', 'пока'])
  })

  test('credits at the top are dropped, lyrics are not', () => {
    const lines = parseLrc('[00:00.00]Song - Artist\n[00:01.00]作词：Someone\n[00:02.00]Guitar：Someone\n[00:10.00]First real line: yes')
    expect(dropCredits(lines, 'Song').map((line) => line.text)).toEqual(['First real line: yes'])
  })

  test('SRT', () => {
    expect(parseSrt('1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\n<i>Bye</i>').map((line) => [line.text, line.start, line.end])).toEqual([['Hello', 1, 2.5], ['Bye', 3, 4]])
  })
})

describe('romanization', () => {
  test('scripts', () => {
    expect(['こんにちは', '안녕', '你好', 'Привет', 'Hello', '123'].map(scriptOf)).toEqual(['ja', 'ko', 'zh', 'ru', 'latin', 'other'])
  })

  test('kana (Hepburn)', () => {
    expect(romanizeLine('きゃりーぱみゅぱみゅ')?.text).toBe('kyariipamyupamyu')
    expect(romanizeLine('まっちゃ')?.text).toBe('matcha')
    expect(romanizeLine('ファッション')?.text).toBe('fasshon')
    expect(romanizeLine('しんい')?.text).toBe("shin'i")
  })

  test('kanji are reported as incomplete', () => {
    expect(romanizeLine('こんにちは世界')?.complete).toBe(false)
    // Kanji alone are Chinese unless the song around them is Japanese.
    expect(romanizeLine('世界')?.text).toBe('shì jiè')
    expect(romanizeLine('世界', { japanese: true })?.complete).toBe(false)
  })

  test('Korean, Chinese, Russian', () => {
    expect(romanizeLine('먹어')?.text).toBe('meogeo')
    expect(romanizeLine('안녕하세요')?.text).toBe('annyeonghaseyo')
    expect(romanizeLine('你好')?.text).toBe('nǐ hǎo')
    expect(romanizeLine('Привет, мир')?.text).toBe('Privet, mir')
    expect(romanizeLine('Hello')).toBeNull()
  })
})
