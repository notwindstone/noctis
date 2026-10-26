import type { ServerHooks } from '../plugins/hooks'
import type { Catalog } from './catalog'

/**
 * Recommendations. OpenSubsonic has no recommendation API beyond getSimilarSongs and
 * getTopSongs, so these live under /api/noctis/v1/recommendations (and also back
 * getSimilarSongs2).
 *
 * The built-in algorithm is a deliberately simple placeholder: songs other listeners
 * of the seed played, then songs sharing artist, genre, tags and era, then random ones.
 * The real recommender and AI tagging are future work (see VISION.md); they'll plug in
 * here or through the hook.
 *
 * Plugins change it through the `onRecommend` hook:
 *   before { user, seed, limit, context } — stop with `{ status: 'stop', response: songIds }`
 *     to replace the algorithm entirely;
 *   after  { user, seed, limit, context, songIds } — reorder, filter or extend `songIds`
 *     (or stop with a replacement).
 */

export interface RecommendInput {
  user: number
  /** A song to start from; without it, the user's recent listening. */
  seed?: string
  limit: number
  /** Free-form, for plugins: "radio", "home", "autoplay"… */
  context?: string
}

export class Recommender {
  constructor(
    private readonly catalog: Catalog,
    private readonly hooks: ServerHooks,
  ) {}

  async recommend(input: RecommendInput): Promise<string[]> {
    const limit = Math.max(1, Math.min(500, input.limit))
    const context = { ...input, limit }
    const before = await this.hooks.runBefore<string[]>('onRecommend', context)
    const songIds = before.stopped ? before.response : await this.builtIn(context)
    const result = { ...context, songIds }
    const after = await this.hooks.run<string[]>('onRecommend', 'after', result)
    return (after.stopped ? after.response : result.songIds).slice(0, limit)
  }

  private async builtIn({ user, seed, limit }: RecommendInput): Promise<string[]> {
    const picked = new Set<string>()
    const exclude = new Set<string>(seed ? [seed] : [])
    const add = (ids: string[]) => {
      for (const id of ids) {
        if (picked.size >= limit) return
        if (!exclude.has(id)) picked.add(id)
      }
    }

    const seeds = seed ? [seed] : [...new Set((await this.catalog.recentPlays(user, 50)).map((play) => play.song_id))].slice(0, 10)
    // Without a seed, don't recommend what was just played.
    if (!seed) for (const id of seeds) exclude.add(id)

    for (const id of seeds) add((await this.catalog.coPlayed(id, limit)).map((row) => row.song_id))
    for (const id of seeds) {
      const song = await this.catalog.song(id, user)
      if (song) add(await this.catalog.similarTo(song, Math.ceil(limit / seeds.length) + 5))
    }
    if (picked.size < limit) add((await this.catalog.randomSongs({ size: limit * 2 }, user)).map((row) => row.id))
    return [...picked]
  }
}
