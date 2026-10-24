/**
 * Just enough semver for plugin versions and dependency ranges, so the client and the
 * server agree without pulling in a library.
 *
 * Versions: MAJOR.MINOR.PATCH with an optional -prerelease (build metadata is ignored).
 * Ranges: exact "1.2.3" or "=1.2.3", comparisons (">=1.2", "<2"), caret "^1.2.3", tilde
 * "~1.2.3", wildcards ("*", "1.x", "1.2.*"), several separated by spaces (all must
 * match) and alternatives joined with "||".
 */

export interface Version {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

export function isValidVersion(text: string): boolean {
  return parseVersion(text) !== null
}

function comparePrerelease(a: string[], b: string[]): number {
  // A release is newer than any of its prereleases.
  if (a.length === 0 || b.length === 0) return b.length - a.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    const numA = /^\d+$/.test(a[i]) ? Number(a[i]) : null
    const numB = /^\d+$/.test(b[i]) ? Number(b[i]) : null
    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA < numB ? -1 : 1
    } else if (numA !== null) {
      return -1
    } else if (numB !== null) {
      return 1
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1
    }
  }
  return 0
}

export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePrerelease(a.prerelease, b.prerelease)
}

type Comparator = { op: '<' | '<=' | '>' | '>=' | '='; version: Version }

const v = (major: number, minor: number, patch: number, prerelease: string[] = []): Version => ({ major, minor, patch, prerelease })

/** A partial version ("1", "1.2", "1.x") and how many parts it pinned. */
function parsePartial(text: string): { version: Version; parts: number } | null {
  const match = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(text)
  if (!match) return null
  const raw = [match[1], match[2], match[3]]
  let parts = 0
  for (const part of raw) {
    if (part === undefined || /^[xX*]$/.test(part)) break
    parts++
  }
  const nums = raw.map((part, index) => (index < parts ? Number(part) : 0))
  return { version: v(nums[0], nums[1], nums[2], parts === 3 && match[4] ? match[4].split('.') : []), parts }
}

function comparatorsFor(token: string): Comparator[] | null {
  if (token === '*' || token === '' || /^[xX]$/.test(token)) return []
  const op = /^(<=|>=|<|>|=|\^|~)?(.*)$/.exec(token)
  if (!op) return null
  const partial = parsePartial(op[2])
  if (!partial) return null
  const { version: base, parts } = partial
  const { major, minor, patch } = base

  switch (op[1]) {
    case '^': {
      // Changes that don't modify the left-most non-zero part.
      const upper = major > 0 || parts === 1 ? v(major + 1, 0, 0) : minor > 0 || parts === 2 ? v(0, minor + 1, 0) : v(0, 0, patch + 1)
      return [{ op: '>=', version: base }, { op: '<', version: upper }]
    }
    case '~': {
      const upper = parts === 1 ? v(major + 1, 0, 0) : v(major, minor + 1, 0)
      return [{ op: '>=', version: base }, { op: '<', version: upper }]
    }
    case '>':
      if (parts < 3) return [{ op: '>=', version: parts === 1 ? v(major + 1, 0, 0) : v(major, minor + 1, 0) }]
      return [{ op: '>', version: base }]
    case '<=':
      if (parts < 3) return [{ op: '<', version: parts === 1 ? v(major + 1, 0, 0) : v(major, minor + 1, 0) }]
      return [{ op: '<=', version: base }]
    case '<':
    case '>=':
      return [{ op: op[1], version: base }]
    default:
      // "1.2.3" / "=1.2.3" exactly; "1.2" / "1.x" any version within.
      if (parts === 3) return [{ op: '=', version: base }]
      if (parts === 0) return []
      return [{ op: '>=', version: base }, { op: '<', version: parts === 1 ? v(major + 1, 0, 0) : v(major, minor + 1, 0) }]
  }
}

function test(version: Version, comparator: Comparator): boolean {
  const order = compareVersions(version, comparator.version)
  switch (comparator.op) {
    case '<':
      return order < 0
    case '<=':
      return order <= 0
    case '>':
      return order > 0
    case '>=':
      return order >= 0
    case '=':
      return order === 0
  }
}

/** Parse a range into alternatives of comparator sets; null if it isn't valid. */
export function parseRange(range: string): Comparator[][] | null {
  const sets: Comparator[][] = []
  for (const alternative of range.split('||')) {
    // "1.2.3 - 2.0.0" hyphen ranges.
    const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(alternative)
    const tokens = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : alternative.trim().replace(/(<=|>=|<|>|=|\^|~)\s+/g, '$1').split(/\s+/)
    const set: Comparator[] = []
    for (const token of tokens) {
      const comparators = comparatorsFor(token)
      if (!comparators) return null
      set.push(...comparators)
    }
    sets.push(set)
  }
  return sets
}

export function isValidRange(range: string): boolean {
  return parseRange(range) !== null
}

/**
 * Whether `version` is in `range`. As in npm, a prerelease only matches a comparator
 * set that names a prerelease of the same MAJOR.MINOR.PATCH.
 */
export function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version)
  const sets = parseRange(range)
  if (!parsed || !sets) return false
  return sets.some((set) => {
    if (!set.every((comparator) => test(parsed, comparator))) return false
    if (parsed.prerelease.length === 0) return true
    return set.some(
      ({ version: c }) =>
        c.prerelease.length > 0 && c.major === parsed.major && c.minor === parsed.minor && c.patch === parsed.patch,
    )
  })
}
