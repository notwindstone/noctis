# Recommendations, AI and the catalog: the design

> **Status: agreed design, not built yet.** What exists today is the plumbing described
> under [What's there now](#whats-there-now). The models and the recommendation logic
> are for the project's author and contributors to build; this document is the socket
> they plug into.

Why any of this exists: to combine many sources (YouTube Music, SoundCloud, local files…)
into **one stream**, with recommendations and tags that work across all of them, and
without every user hitting every service's rate limits.

## Principles

1. **The core owns the data and the contract; the AI is replaceable.** Recommendations,
   tags and embeddings are native parts of the server (schema, API, job queue), but the
   models run in separate, swappable **AI providers**.
2. **Plugins feed the catalog; they don't own databases.** A service plugin resolves
   songs and streams. It never keeps its own million-row index.
3. **Index lazily.** The catalog is a cache of what's searched, played or adjacent, plus
   the small, permanent parts: identities, tags and embeddings.
4. **Share derived data, never listening history.** Instances can share identities, tags
   and embeddings. What people listen to stays on their instance.
5. **Degrade gracefully.** A Raspberry Pi with no AI provider still recommends; a GPU box
   recommends better.

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

  Swapping models means changing one image in `docker-compose.yml`, or one URL in
  `NOCTIS_AI_WORKERS`. Noctis will ship a minimal reference worker in Python as a
  template: replace the model function, keep the protocol.
- **A Noctis server plugin**, for light logic or a hosted model API:
  `Plugin.defineAiProvider(id, { manifest, tasks: { tag, embed, … } })`, the way
  `defineProvider` works for audio.

The rest of Noctis doesn't know which kind is answering. Admins choose which provider
handles each task, and several can run at once (for example, one container for tagging
and another for embeddings).

### Jobs

- **Queue:** the core keeps a job queue in PostgreSQL or Redis and sends each job to a
  provider that handles its task.
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

## Hardware tiers

| Tier | What runs | Good for |
| --- | --- | --- |
| **No AI** | Metadata similarity and shared open data | Raspberry Pi, old laptops |
| **Precomputed** | Tags and embeddings pulled from a shared dataset; nothing computed locally | Small home servers |
| **Full** | Local or remote AI providers, on a CPU or GPU | Big or public instances |

The core checks what's available and uses the best tier it can.

## Many public instances

The model sits between SearXNG (everyone independent) and full federation:

- **Shared: an open dataset** of identity mappings, tags and embeddings. None of it is
  copyrighted audio, and it's what's expensive to compute. It's published as versioned
  dumps or a feed, **signed** by publishers each admin chooses to trust, much like
  MusicBrainz dumps.
- **Private: listening history.** It's personal, and it's the easiest signal to poison.
  Collaborative recommendations stay per instance. Sharing anonymised aggregates may come
  later, opt-in, if at all.
- **No central server** the network depends on. If a publisher disappears, instances keep
  what they have.
- **Poisoning:** signatures say who published what, embeddings can be recomputed to check
  suspicious entries, and admins can drop a publisher.

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
   - the provider registry, with `Plugin.defineAiProvider` and `NOCTIS_AI_WORKERS`.
4. **Model-tagged storage:** integer keys, lookup tables, and pgvector embeddings tagged by
   model.
5. **A reference Python worker:** a template with a toy model.
6. **The shared-dataset format:** signed dumps and a feed.
7. **The models and recommenders themselves:** for the author and contributors.
