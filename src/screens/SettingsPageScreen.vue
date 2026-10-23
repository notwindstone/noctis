<script setup lang="ts">
import { Capacitor } from '@capacitor/core'
import { computed, onMounted, ref } from 'vue'
import MIcon from '../components/MIcon.vue'
import SettingsRow from '../components/SettingsRow.vue'
import Thumb from '../components/Thumb.vue'
import TopAppBar from '../components/TopAppBar.vue'
import { haptic } from '../haptics'
import { clearHistory, clearSearchHistory, history, searchHistory } from '../library'
import type { Route, SettingsPage } from '../navigation'
import { cached, clearCache, clearDownloads, downloads, formatBytes, usage } from '../offline'
import {
  audioQuality,
  autoplayRelated,
  cacheEnabled,
  contentCountry,
  contentLanguage,
  hapticsEnabled,
  maxCacheMb,
  mediaControls,
  pauseHistory,
  persistentQueue,
  playerArtworkColors,
  pureBlack,
  type AudioQuality,
} from '../preferences'
import { notify } from '../snackbar'
import {
  colorSource,
  effectiveColorSource,
  isDark,
  mode,
  oklchHex,
  SEEDS,
  seedId,
  setSeed,
  supportsSystemColor,
  type ColorSource,
  type ThemeMode,
} from '../theme'
import { confirm, showChoice, showTextDialog } from '../ui'
import {
  account,
  canSignInNatively,
  refreshAccount,
  signedIn,
  signInWithCookie,
  signInWithGoogle,
  signOut,
  useAccountForContent,
} from '../ytm/client'
import { version as vueVersion } from 'vue'

const props = defineProps<{ route: Route; screenKey: number; isRoot: boolean }>()
const page = computed<SettingsPage>(() => (props.route.name === 'settings-page' ? props.route.page : 'about'))

const TITLES: Record<SettingsPage, string> = {
  account: 'Account',
  appearance: 'Appearance',
  playback: 'Playback',
  content: 'Content',
  storage: 'Storage',
  about: 'About',
}

/* ------------------------------------------------------------------ *
 * Account
 * ------------------------------------------------------------------ */

const signingIn = ref(false)

onMounted(() => {
  if (page.value === 'account' && signedIn.value) void refreshAccount()
})

async function googleSignIn() {
  signingIn.value = true
  try {
    const ok = await signInWithGoogle()
    notify(ok ? `Signed in${account.value ? ` as ${account.value.name}` : ''}` : 'Sign-in did not complete.')
  } catch {
    /* cancelled */
  } finally {
    signingIn.value = false
  }
}

function cookieSignIn() {
  showTextDialog({
    title: 'Sign in with a cookie',
    description:
      'Paste the Cookie header from a signed-in music.youtube.com request in a desktop browser (DevTools → Network). It must contain SAPISID. Treat it like a password.',
    placeholder: 'SAPISID=…; __Secure-3PAPISID=…; …',
    multiline: true,
    confirmLabel: 'Sign in',
    async onConfirm(value) {
      const ok = await signInWithCookie(value)
      notify(ok ? `Signed in${account.value ? ` as ${account.value.name}` : ''}` : 'That cookie has no SAPISID, so it cannot sign in.')
    },
  })
}

function confirmSignOut() {
  confirm({
    title: 'Sign out?',
    message: 'Your downloads, likes and history on this device stay where they are.',
    confirmLabel: 'Sign out',
    destructive: true,
    onConfirm: async () => {
      await signOut()
      notify('Signed out')
    },
  })
}

/* ------------------------------------------------------------------ *
 * Appearance
 * ------------------------------------------------------------------ */

const THEME_LABELS: Record<ThemeMode, string> = { system: 'Follow system', light: 'Light', dark: 'Dark' }
const SOURCE_LABELS: Record<ColorSource, string> = {
  system: 'Wallpaper',
  artwork: 'Album art',
  seed: 'Preset colour',
}

function chooseTheme() {
  showChoice<ThemeMode>({
    title: 'Theme',
    value: mode.value,
    options: (['system', 'light', 'dark'] as const).map((value) => ({ value, label: THEME_LABELS[value] })),
    onSelect: (value) => (mode.value = value),
  })
}

function chooseSource() {
  const options: { value: ColorSource; label: string; description?: string }[] = [
    {
      value: 'system',
      label: 'Wallpaper',
      description: supportsSystemColor.value ? 'Material You colours from your wallpaper' : 'Needs Android 12 or later',
    },
    { value: 'artwork', label: 'Album art', description: 'The whole app follows what is playing' },
    { value: 'seed', label: 'Preset colour', description: 'Pick one of the colours below' },
  ]
  showChoice<ColorSource>({
    title: 'Dynamic colour',
    value: colorSource.value,
    options,
    onSelect: (value) => (colorSource.value = value),
  })
}

function swatch(hue: number) {
  return { background: oklchHex(isDark.value ? 80 : 40, 0.14, hue) }
}

function pickSeed(id: string) {
  haptic('tick')
  setSeed(id)
}

/* ------------------------------------------------------------------ *
 * Playback & content
 * ------------------------------------------------------------------ */

const QUALITY_LABELS: Record<AudioQuality, string> = {
  auto: 'Automatic',
  high: 'High',
  low: 'Data saver',
}

function chooseQuality() {
  showChoice<AudioQuality>({
    title: 'Audio quality',
    value: audioQuality.value,
    options: [
      { value: 'auto', label: 'Automatic', description: 'High, or data saver on slow and metered connections' },
      { value: 'high', label: 'High', description: 'Best available, usually Opus ~160 kbps' },
      { value: 'low', label: 'Data saver', description: 'Smallest stream, around 50–70 kbps' },
    ],
    onSelect: (value) => (audioQuality.value = value),
  })
}

const LANGUAGES: Record<string, string> = {
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  nl: 'Nederlands',
  pl: 'Polski',
  'pt-BR': 'Português (Brasil)',
  ru: 'Русский',
  tr: 'Türkçe',
  uk: 'Українська',
  'zh-CN': '中文（简体）',
}

const COUNTRIES: Record<string, string> = {
  US: 'United States',
  GB: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  IT: 'Italy',
  NL: 'Netherlands',
  PL: 'Poland',
  BR: 'Brazil',
  MX: 'Mexico',
  JP: 'Japan',
  KR: 'South Korea',
  IN: 'India',
  TR: 'Türkiye',
  UA: 'Ukraine',
  KZ: 'Kazakhstan',
  RU: 'Russia',
}

function chooseLanguage() {
  showChoice({
    title: 'Content language',
    value: contentLanguage.value,
    options: Object.entries(LANGUAGES).map(([value, label]) => ({ value, label })),
    onSelect: (value) => (contentLanguage.value = value),
  })
}

function chooseCountry() {
  showChoice({
    title: 'Content region',
    value: contentCountry.value,
    options: Object.entries(COUNTRIES).map(([value, label]) => ({ value, label })),
    onSelect: (value) => (contentCountry.value = value),
  })
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

const CACHE_SIZES = [128, 256, 512, 1024, 2048, 0]
const cacheLabel = (mb: number) => (mb === 0 ? 'Unlimited' : mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`)

function chooseCacheSize() {
  showChoice({
    title: 'Maximum cache size',
    value: String(maxCacheMb.value),
    options: CACHE_SIZES.map((mb) => ({ value: String(mb), label: cacheLabel(mb) })),
    onSelect: (value) => (maxCacheMb.value = Number(value)),
  })
}

function ask(title: string, message: string, run: () => unknown) {
  confirm({ title, message, confirmLabel: 'Clear', destructive: true, onConfirm: async () => void (await run()) })
}

/* ------------------------------------------------------------------ *
 * About
 * ------------------------------------------------------------------ */

const platform = Capacitor.getPlatform()
const platformLabel = platform === 'web' ? 'Web preview' : platform.charAt(0).toUpperCase() + platform.slice(1)
</script>

<template>
  <div class="screen settings-page">
    <TopAppBar :title="TITLES[page]" back :reveal-at="48" />
    <h1 class="screen-headline type-headline-medium">{{ TITLES[page] }}</h1>

    <!-- Account -->
    <template v-if="page === 'account'">
      <template v-if="signedIn">
        <div class="account-hero">
          <Thumb :src="account?.photo" :size="88" shape="circle" icon="account" />
          <strong class="type-title-large">{{ account?.name ?? 'Signed in' }}</strong>
          <span v-if="account?.handle" class="type-body-medium muted">{{ account.handle }}</span>
        </div>
        <div class="settings-group">
          <SettingsRow
            v-model="useAccountForContent"
            icon="manage-account"
            title="Personalised content"
            description="Use your account for home, search and radios"
          />
          <SettingsRow icon="sync" title="Refresh account info" @click="refreshAccount" />
        </div>
        <div class="settings-group">
          <SettingsRow icon="logout" title="Sign out" destructive @click="confirmSignOut" />
        </div>
      </template>

      <template v-else>
        <div class="account-hero">
          <span class="account-card-icon large"><MIcon name="account" :size="48" /></span>
          <strong class="type-title-large">Not signed in</strong>
          <span class="type-body-medium muted account-hero-note">
            Sign in to bring your YouTube Music library, liked songs and personal mixes. Without an account, Noctis
            still works: likes, history and downloads stay on this device.
          </span>
          <button
            v-if="canSignInNatively"
            class="filled-button large"
            type="button"
            :disabled="signingIn"
            @click="googleSignIn"
          >
            <MIcon name="login" />
            Sign in with Google
          </button>
          <p v-else class="type-body-small muted account-hero-note">
            Google sign-in opens a native window and is available in the Android app. In the browser preview, use a cookie instead.
          </p>
        </div>
        <div class="settings-group">
          <SettingsRow icon="cookie" title="Sign in with a cookie" description="Advanced: paste a music.youtube.com cookie" @click="cookieSignIn" />
        </div>
      </template>
    </template>

    <!-- Appearance -->
    <template v-else-if="page === 'appearance'">
      <div class="settings-group">
        <SettingsRow
          :icon="mode === 'dark' ? 'dark' : mode === 'light' ? 'light' : 'auto'"
          title="Theme"
          :value="THEME_LABELS[mode]"
          @click="chooseTheme"
        />
        <SettingsRow v-model="pureBlack" icon="contrast" title="Pure black" description="True black backgrounds in dark theme" :disabled="!isDark" />
      </div>

      <div class="settings-group">
        <SettingsRow icon="wallpaper" title="Dynamic colour" :value="colorSource === effectiveColorSource ? SOURCE_LABELS[colorSource] : `${SOURCE_LABELS[colorSource]} (unavailable here, using preset)`" @click="chooseSource" />
        <div class="seed-row" role="group" aria-label="Preset colours">
          <button
            v-for="item in SEEDS"
            :key="item.id"
            class="seed-swatch"
            type="button"
            :style="swatch(item.hue)"
            :aria-pressed="effectiveColorSource === 'seed' && seedId === item.id"
            :aria-label="item.name"
            @click="pickSeed(item.id)"
          >
            <MIcon v-if="effectiveColorSource === 'seed' && seedId === item.id" name="check" :size="20" />
          </button>
        </div>
      </div>

      <div class="settings-group">
        <SettingsRow
          v-model="playerArtworkColors"
          icon="image"
          title="Player colours from artwork"
          description="Tint the player with the colours of the album art"
        />
      </div>
    </template>

    <!-- Playback -->
    <template v-else-if="page === 'playback'">
      <div class="settings-group">
        <SettingsRow icon="quality" title="Audio quality" :value="QUALITY_LABELS[audioQuality]" @click="chooseQuality" />
        <SettingsRow v-model="autoplayRelated" icon="radio" title="Autoplay" description="Keep playing similar songs when the queue ends" />
        <SettingsRow v-model="persistentQueue" icon="queue" title="Remember queue" description="Restore the queue and position on launch" />
        <SettingsRow
          v-model="mediaControls"
          icon="lockscreen"
          title="Lock screen controls"
          description="Song, play/pause and skip on the lock screen and in notifications. Also keeps music playing in the background."
        />
      </div>
      <div class="settings-group">
        <SettingsRow v-model="pauseHistory" icon="history" title="Pause listening history" description="Don't add songs to Recently played" />
        <SettingsRow v-model="hapticsEnabled" icon="vibrate" title="Haptic feedback" description="A soft tap on touches" />
      </div>
    </template>

    <!-- Content -->
    <template v-else-if="page === 'content'">
      <div class="settings-group">
        <SettingsRow icon="language" title="Language" :value="LANGUAGES[contentLanguage] ?? contentLanguage" @click="chooseLanguage" />
        <SettingsRow icon="tune" title="Region" :value="COUNTRIES[contentCountry] ?? contentCountry" @click="chooseCountry" />
      </div>
      <p class="settings-note type-body-small muted">Changes what YouTube Music recommends and the language of titles and labels.</p>
    </template>

    <!-- Storage -->
    <template v-else-if="page === 'storage'">
      <div class="storage-meter" aria-hidden="true">
        <span class="storage-meter-download" :style="{ flex: Math.max(usage.download, 1) }" />
        <span class="storage-meter-cache" :style="{ flex: Math.max(usage.cache, 1) }" />
      </div>

      <h2 class="settings-subheader type-title-small">Downloads</h2>
      <div class="settings-group">
        <SettingsRow
          icon="downloaded"
          title="Downloaded songs"
          :value="`${downloads.length} songs · ${formatBytes(usage.download)}`"
        />
        <SettingsRow
          icon="delete"
          title="Remove all downloads"
          destructive
          :disabled="downloads.length === 0"
          @click="ask('Remove all downloads?', 'Downloaded songs will need a connection again.', clearDownloads)"
        />
      </div>

      <h2 class="settings-subheader type-title-small">Cache</h2>
      <div class="settings-group">
        <SettingsRow
          v-model="cacheEnabled"
          icon="cached"
          title="Cache played songs"
          description="Keep songs you play for offline listening. Uses extra data while streaming."
        />
        <SettingsRow icon="storage" title="Maximum cache size" :value="cacheLabel(maxCacheMb)" :disabled="!cacheEnabled" @click="chooseCacheSize" />
        <SettingsRow
          icon="delete"
          title="Clear cache"
          :value="`${cached.length} songs · ${formatBytes(usage.cache)}`"
          :disabled="cached.length === 0"
          @click="ask('Clear cache?', 'Cached songs will be streamed again next time.', clearCache)"
        />
      </div>

      <h2 class="settings-subheader type-title-small">History</h2>
      <div class="settings-group">
        <SettingsRow
          icon="history"
          title="Clear listening history"
          :value="`${history.length} songs`"
          :disabled="history.length === 0"
          @click="ask('Clear listening history?', 'Recently played on this device will be emptied.', clearHistory)"
        />
        <SettingsRow
          icon="search"
          title="Clear search history"
          :value="`${searchHistory.length} searches`"
          :disabled="searchHistory.length === 0"
          @click="ask('Clear search history?', 'Your recent searches will be removed.', clearSearchHistory)"
        />
      </div>
    </template>

    <!-- About -->
    <template v-else>
      <div class="about-hero">
        <span class="about-logo"><MIcon name="music" filled :size="40" /></span>
        <strong class="type-headline-small">Noctis</strong>
        <span class="type-body-medium muted">A Material You client for YouTube Music</span>
      </div>
      <div class="settings-group">
        <SettingsRow icon="info" title="Version" value="0.2.0" />
        <SettingsRow icon="code" title="Built with" :value="`Vue ${vueVersion} · Capacitor 8 · youtubei.js`" />
        <SettingsRow icon="tune" title="Platform" :value="platformLabel" />
        <SettingsRow
          icon="warning"
          title="Stream access"
          :value="'YouTube Music web client · BotGuard proof-of-origin tokens'"
        />
      </div>
      <p class="settings-note type-body-small muted">
        Noctis is not affiliated with YouTube or Google. Inspired by InnerTune and ArchiveTune.
      </p>
    </template>
  </div>
</template>
