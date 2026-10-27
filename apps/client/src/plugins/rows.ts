import { shallowReactive, type Component } from 'vue'
import { writeLog } from './log'

/**
 * Settings as data. Every settings page ("section") is a list of blocks, and every row
 * is a plain object whose live fields are getters:
 *
 *   { id: 'pure-black', title: 'Pure black', get disabled() { return !isDark.value } }
 *
 * Getters read reactive state on access, so rows never need recomputing or
 * reallocating: Vue tracks exactly the fields a page renders. Built-in and plugin pages
 * live in the same `Rows` record; a plugin adds a page with `defineSection`, and it shows
 * up in Settings with the app's own rows, switches and choice dialogs.
 */

export interface ToggleControl {
  /** Current state; usually a getter. */
  readonly value: boolean
  set(value: boolean): void
}

export interface SelectControl {
  /** Dialog title; defaults to the row title. */
  title?: string
  readonly options: { value: string; label: string; description?: string }[]
  /** Current value; usually a getter. Its label is shown under the row title. */
  readonly value: string
  set(value: string): void
}

export interface SettingsRowDef {
  id: string
  /** Material Symbols name (or one added with registerIcon). */
  icon?: string
  title: string
  description?: string
  /** Shown instead of the description, e.g. the current value. */
  value?: string
  /** Show a chevron (the row opens something). */
  chevron?: boolean
  destructive?: boolean
  disabled?: boolean
  hidden?: boolean
  onClick?: () => void | Promise<void>
  /** Turns the row into a switch. */
  toggle?: ToggleControl
  /** Turns the row into a picker (a choice dialog). */
  select?: SelectControl
}

export type SettingsBlock =
  | { id: string; type: 'group'; rows: SettingsRowDef[]; hidden?: boolean }
  | { id: string; type: 'header'; title: string; hidden?: boolean }
  | { id: string; type: 'note'; text: string; hidden?: boolean }
  | { id: string; type: 'component'; component: Component; props?: Record<string, unknown>; hidden?: boolean }

export interface SettingsSection {
  id: string
  icon: string
  title: string
  description?: string
  hidden?: boolean
  /**
   * Where the section is listed. A plugin's sections go under Settings → Plugins; a plugin
   * that wants one next to Noctis's own (Appearance, Playback…) must say `'main'`. Noctis's
   * own sections are always in the main list.
   */
  placement?: 'main' | 'plugins'
}

/** Settings home: the list of sections, in order. */
export const Sections = shallowReactive<SettingsSection[]>([])

/** Every section's blocks, keyed by section id. */
export const Rows = shallowReactive<Record<string, SettingsBlock[]>>({})

const owners = new Map<string, string>()

/** A group block whose row list is reactive (plugins can push rows into it later). */
export function group(id: string, rows: SettingsRowDef[], extra: { readonly hidden?: boolean } = {}): SettingsBlock {
  const block: SettingsBlock = { id, type: 'group', rows: shallowReactive(rows) }
  // Copy descriptors, not values, so a `hidden` getter stays live.
  return Object.defineProperties(block, Object.getOwnPropertyDescriptors(extra))
}

/**
 * Add (or replace) a settings section and its blocks. `position` inserts it at an index
 * in the Settings list; by default it goes before "About".
 */
export function defineSection(section: SettingsSection, blocks: SettingsBlock[], owner = 'unknown', position?: number) {
  const previous = owners.get(section.id)
  if (previous !== undefined && previous !== owner) {
    writeLog(owner, 'warn', `Replacing settings section "${section.id}" (previously provided by ${previous})`)
  }
  owners.set(section.id, owner)

  Rows[section.id] = shallowReactive(blocks)
  const existing = Sections.findIndex((item) => item.id === section.id)
  if (existing !== -1) {
    Sections.splice(existing, 1, section)
    return
  }
  const about = Sections.findIndex((item) => item.id === 'about')
  const index = position ?? (about === -1 ? Sections.length : about)
  Sections.splice(index, 0, section)
}

/** Whether a section is listed on the Settings home (otherwise under Settings → Plugins). */
export function isMainSection(section: SettingsSection): boolean {
  if (section.placement) return section.placement === 'main'
  const owner = owners.get(section.id)
  return owner === undefined || owner === 'noctis'
}

export function removeSection(id: string) {
  const index = Sections.findIndex((item) => item.id === id)
  if (index !== -1) Sections.splice(index, 1)
  delete Rows[id]
  owners.delete(id)
}

export function findSection(id: string): SettingsSection | undefined {
  return Sections.find((item) => item.id === id)
}
