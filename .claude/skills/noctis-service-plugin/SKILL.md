---
name: noctis-service-plugin
description: Build or fix a Noctis streaming-service plugin (home, search, albums, playlists, artists, queues/radios, library, streams, chapters, account/sign-in) such as YouTube Music, Spotify, SoundCloud or Monochrome. Use when defining a service with Plugin.defineService, mapping a third-party API to Noctis models, or debugging a service plugin against the live API.
---

# Noctis service plugins

A service is an object of endpoints grouped by area; the app handles screens, paging, queue,
cache, downloads, likes and history. Types: `apps/client/src/services/types.ts` and
`apps/client/src/models.ts`. Table of endpoints: [docs/PLUGINS.md → Services](../../../docs/PLUGINS.md).
Real examples: `youtube-music` (TypeScript, youtubei.js), `soundcloud`, `spotify`, `monochrome`.
Read [noctis-plugin-dev](../noctis-plugin-dev/SKILL.md) first for the plugin basics.

## Definition

```ts
Plugin.defineService('my-service', {
  name: 'My service', icon: 'music',
  home: { load, more },
  search: { filters, query, more, suggestions },
  albums: { get }, playlists: { get, more }, artists: { get }, browse: { get },
  queue: { start, more, radio },
  streams: { resolve },
  chapters: { get },                       // optional
  links: { share }, thumbnails: { resize }, // synchronous!
  get library() { return signedIn.value ? library : undefined }, // getters for live parts
  account: { get signedIn() { … }, get sessionKey() { … }, signInMethods, signOut },
})
```

Leave out what the service can't do; the app hides the feature.

## Rules that keep it correct

- **Every item gets `source: '<your id>'`**, and ids are prefixed (`spotify:4uLU…`) so they never collide
  in likes, downloads or the queue. Calls about an item are routed by its `source`.
- Songs need `duration` (seconds) whenever known: chapters, "leave out long songs", station skipping and
  sorting use it. A "song" of 12 h or more is a **station** (placeholder with seconds of audio): the app
  skips it, so don't try to make it playable.
- `account.sessionKey` must change whenever content would differ (account, region, language): screens
  refetch and cached pages drop. YouTube Music ties its persisted visitor id to language+region for this reason.
- `streams.resolve` returns `{ url, mimeType, bitrate, expiresAt, contentLength?, fetchUrl?, fetchHeaders? }`;
  downloads fetch `contentLength` bytes in 1 MB ranges from `fetchUrl ?? url`. Make `expiresAt` honest,
  the player refreshes an expired URL once.
- A throttled source declares `downloads: { concurrency, minIntervalMs }`.
- Sign-in goes through `signInMethods`/`signOut` (shown in Settings → Accounts), not rows of your own.
- Offer yourself as a copy for other sources with `Noctis.libs.matching.offerAsSource(id, { … })`.
- Paged lists return `hasMore`; the app keeps asking while the end is on screen, so an endpoint that
  returns an empty page *with* `hasMore: true` forever will spin. Return `hasMore: false` at the end.

## Learn the API from the real service

Write a throwaway script next to the plugin (`examples/plugins/<id>/x.tmp.ts`, delete it after) and run it
with `bun`; it can use the same npm client (e.g. `youtubei.js`) the plugin bundles, with no app around it.
Print shapes before mapping them. Findings worth remembering:

- YouTube Music: `yt.music.getInfo(id)` returns an **empty description**; `yt.getBasicInfo(id)` (the
  regular endpoint) has it, which is where chapter timestamps live. `MusicResponsiveListItem.views` exists
  but playlist items carry no counts.
- Home feeds are paged: first page 3 shelves, then continuations; test with a tall viewport and a normal
  one that every page eventually loads.
- Missing artwork on i.ytimg.com comes back as a 120×90 grey image with HTTP 404, not an error.
- Thumbnails: ask for the size drawn (`thumbnails.resize`), 16:9 stills for video art.

## Test it end to end

Seed the plugin via localStorage (see noctis-plugin-dev), start `bunx vite --port <free port>`, then in the
page call `window.__NOCTIS__.libs.player.playSongs([...])` and read `player.currentSong`, `player.chapters`
and friends; take a screenshot of the Home screen and look at it. Check Home, search, an album, a radio and
one stream before calling it done. Desktop-only paths (nativeFetch) can't be run in headless Chromium:
say so rather than claim them tested.
