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
- It ships with **no music**, except songs stored locally on the device.

### The server (backend)

- It starts from an existing API shape, such as **OpenSubsonic**, so existing clients
  and tools can talk to it.
- By default it has **no streaming services**. It has the recommendation model, the
  local songs it hosts, and accounts for users to connect with.
- It gathers songs from across the internet, splits them by sound quality, finds
  metadata, and adds **AI-generated tags**. "AI" here doesn't mean slop: enough songs
  and human-made tags already exist to train proper classification. Corporations just
  don't care to do it.
- It runs the **recommendations**, so they stay consistent whichever plugins add
  sources.
- It's secure enough to host **public instances**, like Invidious or Monochrome. A
  public server also takes heavy work off devices with weak hardware.
- A lightweight on-device algorithm for picking among downloaded songs might also be
  possible on the client. That's undecided.

### Plugins on both sides

On the server, plugins can add:

- **New API endpoints.** These are usually paired with a client plugin, so the server
  processes something and hands it to clients. Anything can be built on top of these.
- **Music services** to stream from.
- **Changes to the recommendation system**, or a full replacement. Whether that can be
  done well is still an open question.

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
  YouTube or Yandex Music API keys or accounts. That raises its own questions:
  - How do recommendations work across everyone's different sources?
  - How do users avoid exposing their keys to strangers running public instances?
    Credentials should never be stored in plaintext or sent to the instance where
    avoidable.
  - How do we stop a malicious instance, or a malicious client, from tampering with
    data? That covers both metadata and the training signal for recommendations.

### Security of public instances

- **Server plugins are trusted code.** As with Minecraft server mods, only the instance
  owner can install them, from the server's own disk, never through the API.
- **Public instances need the usual protections**: authentication, rate limits,
  request size limits, and no plugin code reaching users without them knowing what
  they're installing.

## Where things are

| Path | What |
| --- | --- |
| `apps/client` | The Vue + Capacitor client |
| `apps/server` | The Bun + Elysia server |
| `packages/plugin-core` | Plugin code shared by both: manifests, archives, versions, dependencies, hooks, client–server negotiation |
| `examples/plugins` | Example plugins: client-only, server-only, and both |
| `docs/PLUGINS.md` | Writing client plugins |
| `docs/SERVER-PLUGINS.md` | Server and both-sides plugins, and how clients and servers agree on them |
