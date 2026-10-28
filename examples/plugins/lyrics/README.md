# Lyrics

Synced lyrics in the full player, in place of the cover. Tap them to open the full-screen
view. Works on every platform; sources that need a native HTTP client (no CORS) are skipped
in a plain browser.

```sh
bun run pack-plugin examples/plugins/lyrics   # → dist-plugins/lyrics.noctis (install from file: the id is the file name)
```

## What it does

- **Sources**, asked in parallel, best result wins (word-synced > line-synced > plain, or
  strictly by your order): your own files, YouLyPlus (Apple-sourced, word by word), BetterLyrics
  (needs a boidu.dev key), Musixmatch, NetEase, QQ Music, KuGou, LRCLIB, Unison, Genius.
  Settings → Lyrics lists them; drag to reorder, tap to switch one off. The lyrics screen's ⋮ menu picks another
  source for a song, shifts the timing, attaches a `.lrc`, `.ttml` (word by word, duets,
  background vocals) or `.srt` file, or searches again. Results are cached in IndexedDB.
- **Look:** Apple-Music-style. The sung line sharpens and grows, the rest blur and dim by
  distance; words fill as they are sung and rise slightly; lines scroll on a spring and the
  ones below trail the first; instrumental breaks show breathing dots; background vocals
  are smaller. Tap a line to seek, scroll to look around (it follows the song again after a
  few seconds).
- **Translation** (a button on the lyrics screen, or Settings → Lyrics): what the source
  ships when it is in your language, otherwise DeepL, an AI (OpenAI-compatible or
  Anthropic), LibreTranslate or Google, chosen automatically or by you. Lines already in
  your language are skipped.
- **Romanization:** the source's own romaji if it has it, then a built-in romanizer (kana →
  Hepburn, Hangul → Revised Romanization, Chinese → pinyin, Cyrillic), then the AI for the
  kanji lines nothing else can read.
- **Every look and animation value is a setting**, with presets (Apple Music, Minimal,
  Karaoke, Calm, Static).

## Limits

- Sources borrowed from ArchiveTune's list that aren't here: SimpMusic (its API answers 403 to
  anything but its own app), Binimum's lookup (behind a Cloudflare challenge), Paxsenix
  (needs a key; it re-serves Apple Music, Musixmatch and Spotify lyrics), Megalobiz
  (HTML scraping) and YouTube's own lyrics and subtitles. Add one with `registerSource`.
- BetterLyrics and Unison are one maintainer's service; BetterLyrics refuses uncached
  queries without a key, and Unison has few songs.
- Musixmatch uses the anonymous token its desktop app uses. It often refuses one; paste your
  own `usertoken` in settings for reliable results.
- Google's translate endpoint is unofficial and rate-limits; DeepL, AI or LibreTranslate
  are steadier.
- Japanese kanji can't be romanized without a dictionary. That comes from NetEase's romaji
  or the AI.
- Lyrics files next to local music aren't discovered automatically; attach one per song.

## For other plugins

`Noctis.lyrics` exists while the plugin is enabled:

```ts
const lyrics = Noctis.lyrics
const remove = lyrics.registerSource({ id: 'mine', name: 'Mine', description: '…', async get(query) {
  // query: { song, title, artists, album?, duration? }
  return { source: 'mine', sourceName: 'Mine', sync: 'word', lines: [{ start: 1, end: 3, text: 'Hi', words: [{ start: 1, end: 3, text: 'Hi' }] }] }
} })
lyrics.registerTranslator({ id, name, unavailable: () => undefined, translate: async (lines, target, ctx) => lines.map(…) })
lyrics.registerRomanizer({ id, name, unavailable: () => undefined, romanize: async (lines, ctx) => lines.map(…) })
lyrics.current()   // the lyrics on screen
lyrics.open()      // full screen
lyrics.reload()    // search again
```

Times are seconds; `sync` is `'word' | 'line' | 'none'`. A source returns `null` when it
has nothing and throws when it failed (the message shows in Settings → Lyrics).
