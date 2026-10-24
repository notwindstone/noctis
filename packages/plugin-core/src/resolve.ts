import type { PluginManifest } from './manifest'
import { satisfies } from './semver'

/**
 * Load order and dependency checks for a set of plugins on one side.
 *
 * A plugin loads after everything it depends on. It can't load when a dependency is
 * missing, has a version outside the wanted range, can't load itself, or is part of a
 * cycle; the problems say which.
 */

export interface ResolvablePlugin {
  id: string
  manifest: Pick<PluginManifest, 'version' | 'dependencies'>
}

export type DependencyProblem =
  | { id: string; kind: 'missing'; dependency: string; wanted: string }
  | { id: string; kind: 'version'; dependency: string; wanted: string; found: string }
  | { id: string; kind: 'blocked'; dependency: string }
  | { id: string; kind: 'cycle'; path: string[] }

export interface Resolution {
  /** Ids that can load, dependencies first; otherwise in the order given. */
  order: string[]
  problems: DependencyProblem[]
}

export function resolveLoadOrder(plugins: ResolvablePlugin[]): Resolution {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]))
  const problems: DependencyProblem[] = []
  const broken = new Set<string>()

  // Direct problems: missing dependencies and wrong versions.
  for (const plugin of plugins) {
    for (const [dependency, wanted] of Object.entries(plugin.manifest.dependencies)) {
      const found = byId.get(dependency)
      if (!found) {
        problems.push({ id: plugin.id, kind: 'missing', dependency, wanted })
        broken.add(plugin.id)
      } else if (!satisfies(found.manifest.version, wanted)) {
        problems.push({ id: plugin.id, kind: 'version', dependency, wanted, found: found.manifest.version || '(none)' })
        broken.add(plugin.id)
      }
    }
  }

  // Depth-first topological sort, detecting cycles and spreading breakage to dependents.
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  function visit(id: string, path: string[]): boolean {
    const current = state.get(id)
    if (current === 'done') return !broken.has(id)
    if (current === 'visiting') {
      const cycle = [...path.slice(path.indexOf(id)), id]
      for (const member of cycle) broken.add(member)
      problems.push({ id, kind: 'cycle', path: cycle })
      return false
    }
    state.set(id, 'visiting')
    let ok = !broken.has(id)
    for (const dependency of Object.keys(byId.get(id)!.manifest.dependencies)) {
      if (!byId.has(dependency)) continue
      if (!visit(dependency, [...path, id])) {
        if (ok && !broken.has(id)) problems.push({ id, kind: 'blocked', dependency })
        ok = false
      }
    }
    state.set(id, 'done')
    if (!ok) broken.add(id)
    else order.push(id)
    return ok
  }

  for (const plugin of plugins) visit(plugin.id, [])
  return { order, problems }
}

/** A problem as a sentence, for logs and error screens. */
export function describeProblem(problem: DependencyProblem): string {
  switch (problem.kind) {
    case 'missing':
      return `${problem.id} needs ${problem.dependency} ${problem.wanted}, which isn't installed`
    case 'version':
      return `${problem.id} needs ${problem.dependency} ${problem.wanted}, but ${problem.found} is installed`
    case 'blocked':
      return `${problem.id} can't load because ${problem.dependency} can't`
    case 'cycle':
      return `Plugins depend on each other in a loop: ${problem.path.join(' → ')}`
  }
}
