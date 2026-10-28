import { romanizeLine, scriptOf } from './romanize'
import { settings } from './state'
import type { Romanizer, Translator } from './types'
import { http, messageOf } from './util'

/**
 * Translators and romanizers. Built in: Google (no key), LibreTranslate, DeepL, and an AI
 * provider (OpenAI-compatible or Anthropic) that does both. Other plugins add their own
 * with `Noctis.lyrics.registerTranslator` / `registerRomanizer`.
 */

const CHUNK = 40

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/* ------------------------------ Google ------------------------------ */

const google: Translator = {
  id: 'google',
  name: 'Google Translate',
  unavailable: () => undefined,
  async translate(lines, target) {
    const out: string[] = []
    for (const part of chunks(lines, CHUNK)) {
      const reply = await http('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=' + encodeURIComponent(target), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `q=${encodeURIComponent(part.join('\n'))}`,
      })
      const segments = (reply.data as [[string, string][]])?.[0]
      if (reply.status !== 200 || !Array.isArray(segments)) throw new Error(`Google answered ${reply.status}`)
      // A segment ends a source line when its original text does.
      const result: string[] = []
      let current = ''
      for (const segment of segments) {
        current += segment[0] ?? ''
        if (typeof segment[1] === 'string' && segment[1].endsWith('\n')) {
          result.push(current.replace(/\n$/, ''))
          current = ''
        }
      }
      if (current) result.push(current)
      if (result.length !== part.length) {
        // Lines merged or split: ask one at a time rather than misalign the whole song.
        for (const line of part) out.push(line.trim() ? await googleOne(line, target) : '')
        continue
      }
      out.push(...result)
    }
    return out
  },
}

async function googleOne(text: string, target: string): Promise<string> {
  const reply = await http(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(text)}`)
  const segments = (reply.data as [string][][])?.[0]
  if (reply.status !== 200 || !Array.isArray(segments)) throw new Error(`Google answered ${reply.status}`)
  return segments.map((segment) => segment[0]).join('')
}

/* --------------------------- LibreTranslate --------------------------- */

const libre: Translator = {
  id: 'libre',
  name: 'LibreTranslate',
  unavailable: () => (settings.libreUrl.trim() ? undefined : 'Set the server address in Settings → Lyrics'),
  async translate(lines, target) {
    const base = settings.libreUrl.replace(/\/+$/, '')
    const out: string[] = []
    for (const part of chunks(lines, CHUNK)) {
      const reply = await http(`${base}/translate`, {
        method: 'POST',
        body: { q: part, source: 'auto', target, format: 'text', api_key: settings.libreKey || undefined },
      })
      const translated = (reply.data as { translatedText?: string[] | string })?.translatedText
      if (reply.status !== 200 || !Array.isArray(translated)) throw new Error(`LibreTranslate answered ${reply.status}: ${JSON.stringify(reply.data).slice(0, 100)}`)
      out.push(...translated)
    }
    return out
  },
}

/* ------------------------------- DeepL ------------------------------- */

const DEEPL_TARGET: Record<string, string> = { en: 'EN-US', pt: 'PT-BR', zh: 'ZH' }

const deepl: Translator = {
  id: 'deepl',
  name: 'DeepL',
  unavailable: () => (settings.deeplKey.trim() ? undefined : 'Add your DeepL API key in Settings → Lyrics'),
  async translate(lines, target) {
    const key = settings.deeplKey.trim()
    const host = key.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com'
    const out: string[] = []
    for (const part of chunks(lines, 50)) {
      const reply = await http(`https://${host}/v2/translate`, {
        method: 'POST',
        headers: { authorization: `DeepL-Auth-Key ${key}` },
        body: { text: part, target_lang: DEEPL_TARGET[target] ?? target.toUpperCase() },
      })
      const translations = (reply.data as { translations?: { text: string }[] })?.translations
      if (reply.status !== 200 || !translations) throw new Error(`DeepL answered ${reply.status}`)
      out.push(...translations.map((item) => item.text))
    }
    return out
  },
}

/* ------------------------------ AI (LLM) ------------------------------ */

function jsonArray(text: string, expected: number): string[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1) throw new Error('The AI did not answer with a list')
  const list = JSON.parse(text.slice(start, end + 1)) as unknown[]
  if (!Array.isArray(list) || list.length !== expected) throw new Error(`The AI returned ${Array.isArray(list) ? list.length : 0} lines for ${expected}`)
  return list.map((item) => String(item ?? ''))
}

async function ask(system: string, lines: string[]): Promise<string[]> {
  const user = JSON.stringify(lines)
  if (settings.aiKind === 'anthropic') {
    const reply = await http(`${settings.aiUrl.replace(/\/+$/, '') || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': settings.aiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: { model: settings.aiModel, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] },
    }, 60_000)
    const text = (reply.data as { content?: { text?: string }[] })?.content?.map((part) => part.text ?? '').join('')
    if (reply.status !== 200 || !text) throw new Error(`Anthropic answered ${reply.status}: ${JSON.stringify(reply.data).slice(0, 120)}`)
    return jsonArray(text, lines.length)
  }
  const reply = await http(`${settings.aiUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${settings.aiKey}` },
    body: {
      model: settings.aiModel,
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    },
  }, 60_000)
  const text = (reply.data as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content
  if (reply.status !== 200 || !text) throw new Error(`The AI answered ${reply.status}: ${JSON.stringify(reply.data).slice(0, 120)}`)
  return jsonArray(text, lines.length)
}

const aiMissing = () => (settings.aiKey.trim() && settings.aiModel.trim() ? undefined : 'Add an API key and model in Settings → Lyrics')

const NAMES: Record<string, string> = Object.fromEntries([
  ['en', 'English'], ['ru', 'Russian'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'],
  ['it', 'Italian'], ['uk', 'Ukrainian'], ['pl', 'Polish'], ['tr', 'Turkish'], ['ja', 'Japanese'], ['ko', 'Korean'],
  ['zh', 'Chinese'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['id', 'Indonesian'],
])

const ai: Translator & Romanizer = {
  id: 'ai',
  name: 'AI',
  unavailable: aiMissing,
  async translate(lines, target, context) {
    const out: string[] = []
    for (const part of chunks(lines, 60)) {
      out.push(
        ...(await ask(
          `You translate song lyrics ("${context.title}" by ${context.artists.join(', ')}) into ${NAMES[target] ?? target}. ` +
            'The user sends a JSON array of lines. Reply with ONLY a JSON array of strings, the same length and order, translating each line naturally and keeping its meaning and tone. Keep empty lines empty.',
          part,
        )),
      )
    }
    return out
  },
  async romanize(lines, context) {
    const out: (string | null)[] = []
    for (const part of chunks(lines, 60)) {
      const result = await ask(
        `You romanize song lyrics ("${context.title}" by ${context.artists.join(', ')}). ` +
          'The user sends a JSON array of lines. Reply with ONLY a JSON array of strings, the same length and order, writing each line in Latin letters as it is sung: Hepburn romaji for Japanese (kanji read as sung), Revised Romanization for Korean, pinyin with tone marks for Chinese, standard transliteration for other scripts. Lines already in Latin letters stay unchanged. Keep empty lines empty.',
        part,
      )
      out.push(...result)
    }
    return out
  },
}

/* ---------------------------- Romanizers ---------------------------- */

const builtinRomanizer: Romanizer = {
  id: 'builtin',
  name: 'Built in',
  unavailable: () => undefined,
  async romanize(lines, context) {
    const japanese = context.japanese ?? lines.some((line) => scriptOf(line) === 'ja')
    return lines.map((line) => {
      const result = romanizeLine(line, { japanese })
      // Half-done (kanji left in) is worse than nothing: let the next one try.
      return result && result.complete ? result.text : null
    })
  },
}

/* ----------------------------- Registries ----------------------------- */

export const translators = new Map<string, Translator>([google, libre, deepl, ai].map((item) => [item.id, item]))
export const romanizers = new Map<string, Romanizer>([builtinRomanizer, ai].map((item) => [item.id, item]))

export function registerTranslator(translator: Translator): () => void {
  translators.set(translator.id, translator)
  return () => void (translators.get(translator.id) === translator && translators.delete(translator.id))
}

export function registerRomanizer(romanizer: Romanizer): () => void {
  romanizers.set(romanizer.id, romanizer)
  return () => void (romanizers.get(romanizer.id) === romanizer && romanizers.delete(romanizer.id))
}

/* ------------------------- Skipping own language ------------------------- */

const ENGLISH_WORDS = new Set('the and you i to a it me my in of is that on be for we your with this love baby oh yeah know just but not all so are like no got will can when what'.split(' '))

/** Is this line already in `target`? Script for most languages; common words for English. */
export function looksLike(text: string, target: string): boolean {
  const script = scriptOf(text)
  if (script === 'other') return true
  switch (target) {
    case 'ja':
      return script === 'ja'
    case 'ko':
      return script === 'ko'
    case 'zh':
      return script === 'zh'
    case 'ru':
    case 'uk':
      return script === 'ru'
    case 'en': {
      if (script !== 'latin') return false
      const words = text.toLowerCase().match(/[a-z']+/g) ?? []
      return words.length > 0 && words.filter((word) => ENGLISH_WORDS.has(word)).length / words.length >= 0.2
    }
    default:
      return false
  }
}

export { messageOf }
