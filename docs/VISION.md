# Noctis: what we're building and why

## The problem

Most music streaming services share the same problems:

- **Bad UI** that you can't change.
- **Missing music**: niche songs, regional releases, remixes and uploads that never make
  it into a catalogue.
- **Inconsistent quality**: the same song in a different, worse quality depending on the
  service.
- **Missing features**, and **high prices** for what is there.

The free and open-source alternatives aren't much better. Self-hosting usually means
something like Jellyfin + Navidrome: you can only play what you've already found and
downloaded, metadata is often missing, and almost nobody goes through that hassle when
Spicetify on top of Spotify exists. Downloading your favourite artists by hand works,
but it's tedious, especially when your taste spans genres that have nothing to do with
each other.

## The idea

Build our own service, in two halves. Both are extended with plugins.

### The client

A cross-platform app: Android, Windows, Linux, macOS, the browser, and possibly iOS.

- Out of the box it does the basics with a clean default design (in the spirit of
  monochrome.tf).
- **Any part of the interface can be added, removed or changed by plugins.** People
  can build their own look and features, down to Winamp-style themes. (The Liquid Glass
  plugin already turns the Material You UI into an iOS one.)
- It ships with **no music services**. It plays **music on the device** (Settings → Local
  music):
  - **Android:** the whole device, from Android's media index, with the "Music and audio"
    permission it asks for once. Music the index misses can be added as extra folders.
  - **Browsers:** folders the user picks, through the File System Access API.
- **In the browser**, the app is served by Noctis servers themselves (admins can turn it
  off) or from any static host. Service plugins like YouTube Music need a CORS proxy
  there; servers stream their own songs, so that's left to extensions for now.

### The server (backend)

- It speaks **OpenSubsonic** (at `/rest`), so existing clients and tools talk to it
  too: Feishin, Symfonium, Supersonic and the rest. Everything OpenSubsonic doesn't
  cover lives under **`/noctis/`**: where each song can be played from, recommendations,
  accounts, administration and plugin negotiation. Plugin routes live under
  `/api/plugins/`.
- By default it has **no streaming services**. Plugins add them, including **local files
  on the server** (the local-library plugin, with the directories the admin chooses).
- **Storage:** PostgreSQL for the catalog, users, groups, play queues, bookmarks and
  plugin data, and Redis for sessions.
- **Accounts:** users are in **groups**, and groups grant **permissions**: browse, stream,
  download, playlists, queues, scanning, managing users, plus permissions plugins
  define. Admins are simply the "admins" group. An instance that doesn't want accounts
  turns on **guest access**: requests without a session act as the "guests" group
  (browse and stream by default), and anything per-user still needs an account.
- **Only OpenSubsonic clients are supported**, with API keys. Legacy Subsonic auth (a
  password in every URL, or md5 tokens that force the server to keep plaintext
  passwords) is refused, so the server never stores or receives passwords after sign-in.
  (The Noctis *client* still signs in to other servers that only have it, like
  Navidrome's demo, with token auth, after API keys.)
- It's secure enough to host **public instances**, like Invidious or Monochrome. A
  public server also takes heavy work off devices with weak hardware.

### Where audio comes from

The server builds **its own music database** by indexing services (through plugins) and
local files. The same song found in several places becomes **one song with several
sources**, each with its quality: codec, bitrate, lossless or not.

- **Noctis clients** get every source of a song from the server, for many songs at
  once (`POST /api/noctis/v1/sources`), and **choose where to play it from** ("Play from",
  in Settings → Playback and in the player's menu):
  - a copy **on the device**;
  - the user's **own account** on a service, through the client plugin for it (YouTube
    Music, Spotify…). The server says which plugin that is, and offers it if it has it;
  - any of the **server's streams**.

  The automatic choice prefers the device, then the user's own services, then the
  server. The same applies to downloading for offline listening.
- **The server can also stream audio itself**, through providers: plugins that stream a
  service's audio directly. That's what makes it work with clients that aren't Noctis,
  like any OpenSubsonic app, which only know "stream this song". A provider can also be
  client-only: it lists sources Noctis clients can play themselves, but the server never
  streams them.
- **Plugins can add sources**, or reorder them, with the `onSources` hook, and client
  plugins can add "Play from" options.

This also answers part of the copyright question below. Users who connect their own
services play from their own accounts, and the server only needs to stream what a
provider plugin on it can legitimately serve.

### Recommendations and AI (designed, not built yet)

The plan:
- gather songs from across the internet;
- split them by sound quality and find their metadata;
- add **AI-generated tags**. "AI" here doesn't mean slop: enough songs and human-made tags
  already exist to train proper classification. Corporations just don't care to do it;
- run **recommendations** on the server, so they stay consistent whichever plugins add
  sources.

The agreed design is in [RECOMMENDATIONS.md](RECOMMENDATIONS.md). In short:

- **Native core, replaceable AI.** The core owns the schema, song identity, the job queue
  and the recommendation API. The models run in **AI providers**: either a container in
  any language (custom models, GPUs), or a Noctis server plugin. Both speak one task
  contract (`tag`, `embed`, `match`, `recommend`), and results are stored with the model
  that made them, so models can be swapped safely.
- **Plugins feed the catalog** and don't keep their own big indexes. The catalog is a lazy
  cache of what's searched or played, built on MusicBrainz IDs and ISRCs.
- **Instances share derived data** (identities, tags and embeddings, as signed datasets
  merged in with a record of their source), never listening history.
- **Admins configure what runs:** every part can be switched on or off, and AI workers
  can run on other machines. For example, Noctis on a VPS and a GPU box at home that
  connects to it for jobs. Without AI, recommendations still work from metadata and
  shared data.

**The models and recommendation logic are for the project's author and other
contributors to build**, on that design. What's there now is the plumbing:
- a `tags` field per song;
- a simple placeholder recommender;
- `/api/noctis/v1/recommendations`, which also backs OpenSubsonic's `getSimilarSongs2`;
- the `onRecommend` hook.

A lightweight on-device algorithm for picking among downloaded songs might also be
possible on the client. That's undecided.

### Plugins on both sides

On the server, plugins can add:

- **New API endpoints.** These are usually paired with a client plugin, so the server
  processes something and hands it to clients. Anything can be built on top of these.
  That includes **OpenSubsonic extensions** (new `/rest` endpoints, listed in
  `getOpenSubsonicExtensions`) and **hooks that change what any OpenSubsonic call
  returns**.
- **Music services**: indexing songs into the catalog, and streaming them (providers).
- **Library scanners** that `startScan` drives, like the local-library plugin.
- **Permissions** that admins can grant to groups.
- **Changes to recommendations**, or a full replacement (`onRecommend`).
- **AI providers**, once built: tagging, embeddings, matching and recommendation
  models, alongside containers with custom models ([RECOMMENDATIONS.md](RECOMMENDATIONS.md)).

Like mods in Minecraft, a server can **require clients to have a matching plugin**
before they connect. A plugin can be client-only, server-only, or both. That makes
entirely new features possible end to end, without a client or server release.

## Why not just Monochrome with themes?

- **The service lives on without us.** If this project dies or goes unmaintained for a
  long time, people can still change it however they want, on both sides, through
  plugins.
- **Unique experiences.** People customise the client and the server to fit how they
  listen, rather than accepting one product's choices.
- **A public backend** instead of logic built into the client keeps clients light.

## Open problems

### Copyright

Storing music on the server and distributing it is piracy. Ideas so far:

- **Analyse, don't keep.** Download only about 30 seconds of a song for analysis
  (quality, tags, embeddings), delete it, and stream the full song in real time from a
  service when someone plays it. Even a temporary copy is still a copy. Whether it's
  covered, for example by text-and-data-mining exceptions like the EU's (which
  rightsholders can opt out of), depends on the jurisdiction. This needs real legal
  advice before any public instance does it.
- **Users bring their own access.** Each client connects its own Spotify, SoundCloud,
  YouTube or Yandex Music API keys or accounts. "Play from" already lets a client play a
  server's song with the user's own account. Open questions remain:
  - How do recommendations work across everyone's different sources?
  - How do users avoid exposing their keys to strangers running public instances?
    Credentials should never be stored in plaintext or sent to the instance where
    avoidable.
  - How do we stop a malicious instance, or a malicious client, from tampering with
    data? That covers both metadata and the training signal for recommendations.

### Security of public instances

- **Server plugins are trusted code.** As with Minecraft server mods, only the instance
  owner can install them, from the server's own disk, never through the API.
- **Already in place:**
  - sessions that can be revoked, stored only as hashes;
  - Argon2 password hashes;
  - permissions per group;
  - no legacy password auth;
  - request size limits;
  - client plugins verified against the hashes the server announces.
- **Still needed:** rate limiting, and an admin UI.

## Where things are

| Path | What |
| --- | --- |
| `apps/client` | The Vue + Capacitor client |
| `apps/server` | The Bun + Elysia server: OpenSubsonic at `/rest`, Noctis at `/api/noctis/v1`, plugin routes at `/api/plugins` |
| `packages/plugin-core` | Plugin code shared by both: manifests, archives, versions, dependencies, hooks, client–server negotiation |
| `examples/plugins` | Example plugins: client-only (YouTube Music, Spotify, Liquid Glass), server-only (local library), and both (server charts) |
| `docker-compose.yml` | PostgreSQL and Redis for the server |
| `docs/PLUGINS.md` | Writing client plugins |
| `docs/SERVER-PLUGINS.md` | The server, its plugins, and how clients and servers agree on them |
| `docs/RECOMMENDATIONS.md` | The design for recommendations, AI providers, song identity and the catalog at scale |
