import { computed, ref, watch } from 'vue'
import { runAfterHooks } from './plugins/hooks'
import { persisted } from './storage'

/**
 * The app's own language: what Noctis itself is written in (not `contentLanguage`, which
 * is what services are asked for; the two are independent). The choice is "system" or one
 * of the languages below; `language` is what that resolves to.
 *
 * Plugins only get `language` and the `onLanguageChange` hook (see namespace.ts): they
 * translate themselves, with whatever i18n library they like.
 *
 * Messages are keyed by their English text: `t('Library')` is "Library" until the
 * language's catalog says otherwise, so nothing breaks when a string isn't translated.
 */

export const SYSTEM_LANGUAGE = 'system'

export type Messages = Record<string, string>

const catalogs: Record<string, Messages> = {
  en: {},
  ru: {
    Home: 'Главная',
    Library: 'Библиотека',
    Settings: 'Настройки',
    'Liked songs': 'Понравившееся',
    Downloads: 'Загрузки',
    Cached: 'Кеш',
    'Recently played': 'Недавно слушали',
    'Local music': 'Локальная музыка',
    'Your playlists': 'Ваши плейлисты',
    'Your artists': 'Ваши исполнители',
    Appearance: 'Оформление',
    Playback: 'Воспроизведение',
    Content: 'Контент',
    Storage: 'Хранилище',
    About: 'О приложении',
    Accounts: 'Аккаунты',
    Language: 'Язык',
    'Content language': 'Язык контента',
    'Use system language': 'Язык системы',
    'Sign out': 'Выйти',
    'Sign in': 'Войти',
    Retry: 'Повторить',
    Loading: 'Загрузка',
    Search: 'Поиск',
  },
}

/** Languages the app is translated to. */
export const availableLanguages = Object.keys(catalogs)

/** "pt-BR" → "pt-br"; messages are per language, so "pt-br" falls back to "pt". */
const normalize = (code: string) => code.trim().toLowerCase().replace('_', '-')

function resolve(code: string): string {
  const wanted = normalize(code)
  if (wanted in catalogs) return wanted
  const base = wanted.split('-')[0]
  return base in catalogs ? base : 'en'
}

/** "system" or a language code. */
export const languagePreference = persisted<string>('noctis:language', SYSTEM_LANGUAGE, (value) => typeof value === 'string')

/** Languages the system asks for (navigator.languages), most wanted first. */
const systemLanguages = ref<readonly string[]>(typeof navigator === 'undefined' ? ['en'] : navigator.languages?.length ? navigator.languages : [navigator.language])
if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => {
    systemLanguages.value = navigator.languages?.length ? navigator.languages : [navigator.language]
  })
}

/** The language the app is shown in: "en" or "ru"… */
export const language = computed(() => {
  if (languagePreference.value !== SYSTEM_LANGUAGE) return resolve(languagePreference.value)
  for (const code of systemLanguages.value) {
    const resolved = resolve(code)
    if (resolved !== 'en' || normalize(code).split('-')[0] === 'en') return resolved
  }
  return 'en'
})

/** A language's own name: "Русский", "English". */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code)
    if (name) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1)
  } catch {
    /* an odd code */
  }
  return code
}

/** Choices for a picker: "Use system language", then each language by its own name. */
export const languageOptions = computed(() => [
  { value: SYSTEM_LANGUAGE, label: t('Use system language'), description: languageName(language.value) },
  ...availableLanguages.map((code) => ({ value: code, label: languageName(code) })),
])

/** The text for `key` (its English text) in the current language; `{name}` placeholders take `params`. */
export function t(key: string, params?: Record<string, string | number>): string {
  const text = catalogs[language.value]?.[key] ?? catalogs.en[key] ?? key
  return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : text
}

// The language of the page: spell-check, hyphenation and screen readers use it.
watch(language, (code) => (document.documentElement.lang = code), { immediate: true })

// Plugins can react through `hook::onLanguageChange::after` instead of watching.
watch(language, (code, previous) => runAfterHooks('onLanguageChange', { language: code, previous }))
