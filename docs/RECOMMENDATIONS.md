# Recommendations, AI and the catalog: the design

> **Status: agreed design, not built yet.** What exists today is the plumbing described
> under [What's there now](#whats-there-now). The models and the recommendation logic
> are for the project's author and contributors to build; this document is the socket
> they plug into.

Why any of this exists: to combine many sources (YouTube Music, SoundCloud, local files…)
into **one stream**, with recommendations and tags that work across all of them, and
without every user hitting every service's rate limits.

## Glossary

- **Embedding:** a list of numbers (say, 128) that a model produces for a song, trained
  so that songs that sound alike get similar lists. Think of coordinates on a map of
  music: calm piano pieces sit near each other, metal far away.
- **Embedding space:** whose map the coordinates are on. Vectors from different models
  can't be compared, any more than GPS coordinates can be compared with street
  addresses.
- **Making vs storing embeddings:** making them needs the model (heavy, often a GPU):
  that's an AI provider's job. Storing and searching them ("the 50 songs closest to
  this one") is ordinary database work for the core, with pgvector, and needs no model.
  Already-stored vectors keep working while the GPU box is off.
- **Job queue:** the server's to-do list of background work ("analyse song X", "tag
  song Y"). It isn't the song queue. Jobs wait in the database until a worker takes
  them, and are retried if they fail.
- **AI provider / worker:** something that does AI tasks: a container (any language)
  or a Noctis server plugin.
- **Publisher:** whoever publishes a shared dataset, such as the official Noctis
  dataset or a community dataset of anime-music tags.

## Principles

1. **The core owns the data and the contract; the AI is replaceable.** The core stores
   and searches tags and embeddings, keeps the job queue, and serves the
   recommendation API. The models that *produce* tags and embeddings run in separate,
   swappable **AI providers**.
2. **Plugins feed the catalog; they don't own databases.** A service plugin resolves
   songs and streams. It never keeps its own million-row index.
3. **Index lazily.** The catalog is a cache of what's searched, played or adjacent, plus
   the small, permanent parts: identities, tags and embeddings.
4. **Share derived data, never listening history.** Instances can share identities, tags
   and embeddings. What people listen to stays on their instance.
5. **Admins decide what runs.** Every part can be switched on or off in the config (see
   [Configuration](#configuration)). Without AI providers, recommendations still work
   from metadata and shared data.

## Architecture

| Layer | Owns | Notes |
| --- | --- | --- |
| **Core** (Bun) | Catalog schema, song identity, listening events, tags and embeddings tables, the recommendation API, the job queue, the rate-limited HTTP layer | The contract. Not swappable by accident |
| **AI providers** | Audio analysis, tagging, embeddings, matching, recommendation models | Containers in any language (Python with PyTorch, GPUs), or Noctis server plugins. Several can run at once |
| **Plugins** | Sources (metadata and streams); tweaks to rankings (`onRecommend`) | Small and in-process |

The closest existing example is Immich: its server and machine-learning container are
separate, and the ML part can run on another machine.

## Song identity

Combining sources depends on knowing that two items are the same **recording**.

- **Backbone:** MusicBrainz recording IDs (MBIDs), and ISRCs where a service exposes them.
- **Fallback:** fuzzy matching on normalised title, artist and duration, which the
  `match` task (below) can improve.
- **Service ids** (a YouTube video id, a SoundCloud track id, a local file) are sources
  pointing at a recording, the way `song_sources` already works.

Open data covers cold starts:
- **MusicBrainz** has metadata and relationships for tens of millions of recordings.
- **ListenBrainz** publishes similar-artist and similar-recording data.
- **AcousticBrainz** stopped collecting in 2022, but its audio-feature dumps remain.

Large instances can mirror MusicBrainz from its dumps; small ones query its API.

## Indexing: the catalog is a cache

- **What gets resolved:** songs that are searched for, played, or adjacent to what's
  played (an album, an artist's top songs). Nothing is crawled exhaustively.
- **What's kept for good:** identity mappings, tags and embeddings, all small.
- **What expires:** service metadata, which is cheap to fetch again.
- **Lean on services that already index everything:** a plugin resolves on demand rather
  than mirroring a service.

## AI providers

### Tasks

The core defines tasks; a provider says which it handles.

| Task | Input | Output |
| --- | --- | --- |
| `tag` | an audio clip and/or metadata | tags (genres, moods, instruments…) with confidence |
| `embed` | an audio clip and/or metadata | a vector, and the embedding space it belongs to |
| `match` | two candidate songs | whether they're the same recording, with confidence |
| `recommend` | a user's history, an optional seed, candidates | ranked song ids |

### Manifest

The provider announces what it can do and what it outputs. It doesn't define
embeddings; it says which **space** its vectors are in and how many **dimensions** they
have, so the core never compares vectors across spaces, and stores and indexes them
correctly.

```json
{
  "name": "discogs-effnet",
  "version": "1.2.0",
  "tasks": ["tag", "embed"],
  "embedding": { "space": "effnet-discogs-1280", "dimensions": 1280 },
  "input": { "audio": { "seconds": 30, "sampleRate": 16000 } }
}
```

### Two ways to provide tasks, one interface

- **A container**, for custom models: any language. It speaks a small HTTP protocol:
  - `GET /manifest`;
  - `POST /tasks/<task>` with a job, answering with the result.

  Noctis will ship a minimal reference worker in Python as a
  template: replace the model function, keep the protocol.
- **A Noctis server plugin**, for light logic or a hosted model API:
  `Plugin.defineAiProvider(id, { manifest, tasks: { tag, embed, … } })`, the way
  `defineProvider` works for audio.
- **Swapping models:** change one image in `docker-compose.yml`, or connect a different
  worker with its token.

The rest of Noctis doesn't know which kind is answering. Admins choose which provider
handles each task, and several can run at once (for example, one container for tagging
and another for embeddings).

### Remote workers: Noctis on a VPS, AI at home

A worker doesn't have to run on the same machine as Noctis. For example, Noctis can run
on a VPS for availability and storage, while a GPU box at home does the AI.

- **Main model: the worker connects to the server.** It asks for jobs over HTTPS (polling
  or a long-lived connection), receives each job with its audio clip, and sends the
  result back. This needs no port forwarding at home, and the box can sleep: jobs wait
  in the queue until it's back.
- **Option: the server pushes to a worker URL**, for workers the server can reach, like a
  GPU box on the same network.
- **Authentication:** each worker has a token the admin creates, scoped to the tasks it
  may do.
- **Bandwidth:** a 30-second clip is around half a megabyte, so a home connection is
  plenty.

### Jobs

- **Queue:** the core keeps a job queue in PostgreSQL or Redis. Workers take the jobs
  for their tasks; jobs wait while no worker is available.
- **Retries and backpressure:** failed jobs are retried, and slow providers are throttled.
- **Audio:** analysis works on short clips (around 30 seconds), fetched through a provider
  and discarded afterwards (see the copyright notes in [VISION.md](VISION.md)).
- **Order:** songs that are actually played are analysed first, and the rest of the
  catalog only when a provider is idle.

### Results are tagged with the model that made them

Every tag and embedding is stored with its producer, for example
`effnet-discogs-1280@1.2.0`. That gives three things:
- **No mixing:** vectors from different embedding spaces aren't comparable, so swapping
  a model never silently corrupts recommendations.
- **Safe migration:** run the old and new model side by side, re-embed in the background,
  then switch.
- **Clean sharing:** instances only use shared embeddings from spaces they understand,
  and tags say who produced them.

### Security

AI providers are trusted code, like server plugins: the admin chooses to run them. They
never touch the database. They get a job (a clip and some metadata) and return a result,
which the core validates: vector sizes, tag formats and limits. A broken or malicious
model can produce bad tags, but it can't read users or listening history.

## Recommendations

They stay changeable at three levels:

1. **`onRecommend` hooks** in JS plugins, for tweaks: filtering, boosting, mixing things in.
2. **A `recommend` provider**, in a container or plugin, for a full replacement such as a
   custom trained model.
3. **The built-in fallback**, used when nothing else is configured: metadata similarity and
   shared data, enough for old hardware.

Signals:
- **content:** tags and embeddings;
- **collaborative:** co-listening on the instance;
- **open data:** ListenBrainz similarities.

## Configuration

There are no fixed tiers: admins switch each part on or off and tune it for their
hardware. Defaults are sensible for a small server. For example:

| Setting | What it controls |
| --- | --- |
| Recommendations | On or off; whether to use embeddings, co-listening and open data |
| AI workers | Which workers are allowed (tokens), and which handles each task |
| Audio analysis | On or off; clip length; analyse only played songs, or the whole catalog when idle |
| Shared datasets | Which publishers to import from, and how often |
| Indexing | How far to resolve around what's played; how long service metadata is kept |
| Embeddings index | IVFFlat (less memory) or HNSW (faster); dimensions to keep |
| Rate limits | Budgets per service plugin |

A Raspberry Pi might turn off audio analysis and import shared tags instead. A big
instance might run several GPU workers and index widely.

## Many public instances

The model sits between SearXNG (everyone independent) and full federation:

- **Shared: open datasets** of identity mappings, tags and embeddings. None of it is
  copyrighted audio, and it's what's expensive to compute. They're published as
  versioned dumps or feeds, **signed** by their publishers, much like MusicBrainz dumps
  or signed Linux package repositories.
- **Importing is a merge that keeps its source.** An admin merges datasets into their own
  database, and every imported row records which publisher and dataset version it came
  from. That makes updates incremental, and makes a bad dataset removable.
- **Private: listening history.** It's personal, and it's the easiest signal to poison.
  Collaborative recommendations stay per instance. Sharing anonymised aggregates may come
  later, opt-in, if at all.
- **No central server** the network depends on. If a publisher disappears, instances keep
  what they have.
- **Poisoning:** the signature proves a dataset really comes from its publisher and
  wasn't altered. Embeddings can be recomputed to check suspicious entries. If a
  publisher turns out to be bad, the admin stops importing from it and removes
  everything it contributed, which works because each row keeps its source. A blind
  merge couldn't be untangled.

## Storage at scale

Aim: tens of millions of songs on modest hardware, in PostgreSQL.

- **Integer keys internally.** Today's ids are text hashes stored in every row and index.
  Keep them as external ids, and use integer keys in the tables.
- **Lookup tables** for artists, tags and providers, so a tag is a small number rather
  than repeated text.
- **Embeddings in pgvector, quantised.** For example, 128 dimensions as 16-bit floats is
  about 256 bytes per song, roughly 2.5 GB for 10 million songs. Use IVFFlat indexes on
  weak machines and HNSW where there's memory.
- **No blobs:** artwork and lyrics stay as URLs or a cache.
- **Expiry:** service metadata can be partitioned and expired, while identities, tags and
  embeddings stay.

Rough estimate: 10 million songs with their sources fit in a few GB, plus whatever the
embeddings need.

## Rate limits

- **A core HTTP layer** that service plugins use, so it's solved once:
  - a cache per provider;
  - coalescing of identical requests;
  - request budgets per provider, with backoff.

  Then one popular song doesn't hit YouTube a hundred times.
- **"Play from your own account"** spreads the load: streams come from each user's own
  quota, not the server's.

## What's there now

- **Catalog:** one song with many sources (`song_sources`), and a `tags` field per song
  (`Noctis.catalog.setTags`).
- **Placeholder recommender:** co-listening, then shared artist, genre, tags and era, then
  random songs (`apps/server/src/catalog/recommend.ts`).
- **Recommendation API:** `/noctis/v1/recommendations`, which also backs OpenSubsonic's
  `getSimilarSongs2`.
- **Hooks:** `onRecommend` (adjust or replace) and `onSources`.

## Roadmap

1. **Song identity:** MBIDs, ISRCs and matching, with recordings as the unit sources
   point at.
2. **The rate-limited HTTP layer** for plugins.
3. **AI providers:**
   - the task contract and manifest, in `packages/plugin-core`;
   - the job queue;
   - the provider registry, with `Plugin.defineAiProvider`;
   - worker tokens, with workers that connect to the server.
4. **Model-tagged storage:** integer keys, lookup tables, and pgvector embeddings tagged by
   model.
5. **A reference Python worker:** a template with a toy model.
6. **The shared-dataset format:** signed dumps and a feed, and imports that keep each
   row's source.
7. **The feature configuration** (see Configuration).
8. **The models and recommenders themselves:** for the author and contributors.
