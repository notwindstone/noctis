import { pinyin } from 'pinyin-pro'

/**
 * Built-in romanization: Japanese kana (Hepburn), Korean (Revised Romanization), Chinese
 * (pinyin with tone marks) and Russian/Ukrainian Cyrillic. Kanji can't be read without a
 * dictionary, so a Japanese line with kanji comes back incomplete; a source's own romaji
 * or the AI romanizer covers those.
 */


export type Script = 'ja' | 'ko' | 'zh' | 'ru' | 'latin' | 'other'

const KANA = /[぀-ヿㇰ-ㇿ]/
const HANGUL = /[가-힯ᄀ-ᇿ㄰-㆏]/
const HAN = /[㐀-鿿]/
const CYRILLIC = /[Ѐ-ӿ]/
const LATIN_LETTER = /[A-Za-zÀ-ɏ]/

/** The script a line is mostly in. Kana beats Han: kanji mixed with kana is Japanese. */
export function scriptOf(text: string): Script {
  if (KANA.test(text)) return 'ja'
  if (HANGUL.test(text)) return 'ko'
  if (HAN.test(text)) return 'zh'
  if (CYRILLIC.test(text)) return 'ru'
  if (LATIN_LETTER.test(text)) return 'latin'
  return 'other'
}

/* --------------------------- Japanese --------------------------- */

const BASE: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
}

const SMALL_Y: Record<string, string> = { ゃ: 'a', ゅ: 'u', ょ: 'o' }
/** Small vowels after a consonant kana make foreign sounds (ファ → fa, ティ → ti). */
const SMALL_VOWEL: Record<string, string> = { ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o' }

/** Katakana → hiragana, so there is one table. */
function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60))
}

function kanaToRomaji(input: string): { text: string; complete: boolean } {
  const kana = toHiragana(input)
  let out = ''
  let complete = true
  let doubled = false
  for (let i = 0; i < kana.length; i++) {
    const char = kana[i]
    if (char === 'っ') {
      doubled = true
      continue
    }
    if (char === 'ー') {
      const last = out[out.length - 1]
      if (last && /[aiueo]/.test(last)) out += last
      continue
    }
    let syllable = BASE[char]
    if (syllable === undefined) {
      if (HAN.test(char)) complete = false
      const punctuation: Record<string, string> = { '、': ',', '。': '.', '「': '"', '」': '"', '・': ' ', '！': '!', '？': '?', '～': '~', '　': ' ' }
      out += punctuation[char] ?? char
      doubled = false
      continue
    }
    const next = kana[i + 1]
    if (next && SMALL_Y[next] && syllable.length >= 2 && syllable.endsWith('i')) {
      // きゃ → kya, しゃ → sha, ちゃ → cha, じゃ → ja
      const stem = /^(sh|ch|j)i$/.test(syllable) ? syllable.slice(0, -1) : `${syllable.slice(0, -1)}y`
      syllable = stem + SMALL_Y[next]
      i++
    } else if (next && SMALL_VOWEL[next] && syllable.length >= 2) {
      // ふぁ → fa, てぃ → ti, うぃ → wi
      const vowel = SMALL_VOWEL[next]
      syllable = (syllable === 'fu' ? 'f' : syllable === 'u' ? 'w' : syllable === 'te' ? 't' : syllable === 'de' ? 'd' : syllable.slice(0, -1)) + vowel
      i++
    }
    if (char === 'ん') {
      // n before a vowel or y is written "n'" so it isn't read as the next syllable.
      const after = BASE[kana[i + 1]] ?? ''
      syllable = /^[aiueoy]/.test(after) ? "n'" : 'n'
    }
    if (doubled) {
      const head = syllable.startsWith('ch') ? 't' : syllable[0]
      out += head
      doubled = false
    }
    out += syllable
  }
  // Particles read differently, but guessing them wrongly is worse than the plain spelling.
  return { text: out.replace(/\s+/g, ' ').trim(), complete }
}

/* --------------------------- Korean ----------------------------- */

const INITIALS = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h']
const VOWELS = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i']
/** The sound a final leaves when nothing follows it. */
const FINAL_SOUND = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'p', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't']
/** What a final becomes when the next syllable starts with a vowel (ㅇ): it moves over. */
const LIAISON = ['', 'g', 'kk', 'gs', 'n', 'nj', 'nh', 'd', 'r', 'lg', 'lm', 'lb', 'ls', 'lt', 'lp', 'lh', 'm', 'b', 'bs', 's', 'ss', 'ng', 'j', 'ch', 'k', 't', 'p', 'h']

function hangulToRoman(text: string): string {
  const syllables = Array.from(text)
  let out = ''
  for (let i = 0; i < syllables.length; i++) {
    const code = syllables[i].codePointAt(0)! - 0xac00
    if (code < 0 || code > 11171) {
      out += syllables[i]
      continue
    }
    const initial = Math.floor(code / 588)
    const vowel = Math.floor((code % 588) / 28)
    const final = code % 28
    out += INITIALS[initial] + VOWELS[vowel]
    if (final === 0) continue
    const next = syllables[i + 1]?.codePointAt(0)! - 0xac00
    const nextStartsWithVowel = next >= 0 && next <= 11171 && Math.floor(next / 588) === 11
    if (nextStartsWithVowel) {
      // 먹어 → meogeo: the final is sounded as the next syllable's start.
      out += LIAISON[final]
    } else {
      out += FINAL_SOUND[final]
    }
  }
  return out.replace(/\s+/g, ' ').trim()
}

/* ---------------------------- Chinese --------------------------- */

function hanToPinyin(text: string): string {
  return pinyin(text, { toneType: 'symbol', nonZh: 'consecutive' }).replace(/\s+/g, ' ').trim()
}

/* ---------------------------- Cyrillic -------------------------- */

const CYRILLIC_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', є: 'ye', і: 'i', ї: 'yi', ґ: 'g',
}

function cyrillicToLatin(text: string): string {
  return Array.from(text)
    .map((char) => {
      const lower = char.toLowerCase()
      const mapped = CYRILLIC_MAP[lower]
      if (mapped === undefined) return char
      return char === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1)
    })
    .join('')
}

/* ----------------------------- Entry ---------------------------- */

export interface Romanized {
  text: string
  /** False when part of the line is still in its own script (kanji). */
  complete: boolean
}

/** Romanize one line; null when it is Latin already or has no letters worth reading. */
export function romanizeLine(text: string, hint: { japanese?: boolean } = {}): Romanized | null {
  // A line of kanji alone reads the same in Chinese and Japanese; the rest of the song decides.
  const script = hint.japanese && scriptOf(text) === 'zh' ? 'ja' : scriptOf(text)
  switch (script) {
    case 'ja': {
      const result = kanaToRomaji(text)
      return { text: result.text, complete: result.complete && !HAN.test(result.text) }
    }
    case 'ko':
      return { text: hangulToRoman(text), complete: true }
    case 'zh':
      return { text: hanToPinyin(text), complete: true }
    case 'ru':
      return { text: cyrillicToLatin(text), complete: true }
    default:
      return null
  }
}
