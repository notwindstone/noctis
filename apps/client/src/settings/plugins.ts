import { nextTick, shallowReactive, watch } from 'vue'
import { describePlatforms } from '@noctis/plugin-core'
import InstalledPlugins from '../components/settings/InstalledPlugins.vue'
import PluginHeader from '../components/settings/PluginHeader.vue'
import PluginLog from '../components/settings/PluginLog.vue'
import { goBack, navigate } from '../navigation'
import { addCollection, checkOnStart, collections, installEntry, refreshAll, refreshCollection, removeCollection, states, statusOf, updateAll, updates } from '../plugins/collections'
import { installFromArchive, installFromFile, installFromUrl, PluginInstallError, pickPluginFile, type InstallResult } from '../plugins/install'
import { writeLog } from '../plugins/log'
import { defineSection, findSection, group, isMainSection, removeSection, Rows, Sections, sectionsOwnedBy, type SettingsBlock, type SettingsRowDef } from '../plugins/rows'
import { blockersOf, disablePlugin, enablePlugin, removePlugin, runStates, setPluginsActive } from '../plugins/runtime'
import {
  approvedHashes,
  describeAuthors,
  findPlugin,
  installedPlugins,
  isEnabled,
  keepEnabledOnUpdate,
  pluginsActive,
  type InstalledPlugin,
} from '../plugins/store'
import { notify } from '../snackbar'
import { confirm, openLink, showTextDialog } from '../ui'

/**
 * Settings → Plugins, built with the same getter-based rows plugins use for their own
 * settings. Each installed plugin also gets its own (hidden) section, "plugin:<id>".
 */

const sectionId = (plugin: InstalledPlugin) => `plugin:${plugin.id}`

function stateLabel(plugin: InstalledPlugin): string {
  const state = runStates[plugin.sha256]
  if (!isEnabled(plugin)) return state === 'failed' ? 'Failed to start' : 'Off'
  if (!pluginsActive.value) return 'On (plugins are switched off)'
  if (state === 'running') return 'Running'
  if (state === 'failed') return 'Failed to start'
  return 'On'
}

/** Enable, asking first if this exact code hasn't been approved before. */
export function requestEnable(plugin: InstalledPlugin) {
  const blockers = blockersOf(plugin)
  if (blockers.length > 0) return notify(blockers[0])

  const run = async () => {
    approvedHashes.value = { ...approvedHashes.value, [plugin.sha256]: true }
    const ok = await enablePlugin(plugin)
    if (!ok) notify(`${plugin.metadata.name} failed to start. Its log has details.`)
  }

  if (approvedHashes.value[plugin.sha256]) {
    void run()
    return
  }

  confirm({
    title: `Enable ${plugin.metadata.name}?`,
    message:
      'Plugins run with full access to Noctis: they can change any screen, see your library and your signed-in accounts, and make network requests. Only enable plugins from people you trust.',
    // A warning, but not a destructive action: the red was the same as Delete and Remove.
    confirmLabel: 'Enable',
    onConfirm: run,
  })
}

/** Ask, then stop and delete a plugin. `done` runs after it's gone (the plugin's own page goes back). */
function confirmRemove(plugin: InstalledPlugin, done?: () => void) {
  confirm({
    title: `Remove ${plugin.metadata.name}?`,
    message: 'It will be stopped and deleted from this device.',
    confirmLabel: 'Remove',
    destructive: true,
    onConfirm: async () => {
      await removePlugin(plugin)
      notify(`Removed ${plugin.metadata.name}`)
      done?.()
    },
  })
}

function reportInstall(result: InstallResult) {
  const { plugin, replaced, sameCode, restarted } = result
  if (replaced && sameCode) notify(`${plugin.metadata.name} is already installed`)
  else if (replaced && restarted) notify(`Updated ${plugin.metadata.name} to ${plugin.metadata.version || 'the new version'}`)
  else if (replaced) notify(`Updated ${plugin.metadata.name}. Enable it again to run the new version.`)
  else notify(`Installed ${plugin.metadata.name}`)
}

function reportFailure(error: unknown) {
  const message = error instanceof PluginInstallError ? error.message : `Couldn't install: ${(error as Error).message}`
  writeLog('noctis', 'error', message)
  notify(message)
}

async function installFile() {
  const file = await pickPluginFile()
  if (!file) return
  try {
    reportInstall(await installFromFile(file))
  } catch (error) {
    reportFailure(error)
  }
}

/**
 * A plugin archive opened with Noctis (Android's "Open with"): install it, show its page
 * and offer to enable it.
 */
export async function installOpenedFile(name: string, bytes: Uint8Array) {
  // Downloading twice names the file "my-plugin (1).noctis"; the id is still "my-plugin".
  const fileName = name.replace(/\s*\(\d+\)(?=\.(noctis|zip)$)/i, '') || 'plugin.noctis'
  try {
    const result = await installFromArchive(fileName, bytes)
    reportInstall(result)
    await nextTick()
    void navigate({ name: 'settings-page', page: sectionId(result.plugin) })
    if (!isEnabled(result.plugin)) requestEnable(result.plugin)
  } catch (error) {
    reportFailure(error instanceof PluginInstallError ? new PluginInstallError(`${name || 'This file'} isn't a plugin Noctis can install: ${error.message}`) : error)
  }
}

function installUrl() {
  showTextDialog({
    title: 'Install from URL',
    description: 'A direct https link to a .zip or .noctis plugin archive.',
    placeholder: 'https://…/my-plugin.zip',
    confirmLabel: 'Install',
    async onConfirm(value) {
      try {
        reportInstall(await installFromUrl(value))
      } catch (error) {
        reportFailure(error)
      }
    },
  })
}

const withRange = (id: string, range: string) => (range === '*' ? id : `${id} ${range}`)

/** "youtube-music ^1.0.0 • plugin API ^1.0.0 • Noctis.libs.offline". */
function describeRequirements(plugin: InstalledPlugin): string {
  const { dependencies, requires } = plugin.metadata
  return [
    ...Object.entries(dependencies).map(([id, range]) => withRange(id, range)),
    requires?.api && `plugin API ${requires.api}`,
    ...(requires?.libs ?? []).map((name) => `Noctis.libs.${name}`),
  ]
    .filter(Boolean)
    .join(' • ')
}

function describeConflicts(plugin: InstalledPlugin): string {
  return Object.entries(plugin.metadata.incompatible ?? {}).map(([id, range]) => withRange(id, range)).join(' • ')
}

/* ------------------------------------------------------------------ *
 * One section per plugin
 * ------------------------------------------------------------------ */

function pluginBlocks(id: string): SettingsBlock[] {
  // Look the plugin up on every read: reinstalling replaces the object.
  const current = () => findPlugin(id)
  const ownSettingsRows = shallowReactive<SettingsRowDef[]>([])
  watch(
    () => sectionsOwnedBy(id).filter((section) => !section.hidden).map((section) => section.id),
    (ids) => ownSettingsRows.splice(0, ownSettingsRows.length, ...ids.map((sectionId) => sectionRow(sectionId))),
    { immediate: true },
  )

  return [
    { id: 'header', type: 'component', component: PluginHeader, props: { id } },
    group('state', [
      {
        id: 'enabled',
        icon: 'plugin',
        title: 'Enabled',
        get description() {
          const plugin = current()
          return plugin ? stateLabel(plugin) : ''
        },
        toggle: {
          get value() {
            const plugin = current()
            return plugin ? isEnabled(plugin) : false
          },
          set(value) {
            const plugin = current()
            if (!plugin) return
            if (value) requestEnable(plugin)
            else void disablePlugin(plugin)
          },
        },
      },
    ]),
    {
      id: 'description',
      type: 'note',
      get text() {
        return current()?.metadata.description ?? ''
      },
      get hidden() {
        return !current()?.metadata.description
      },
    },
    // The plugin's own settings, from its page (they're also listed under Settings → Plugins).
    group('own-settings', ownSettingsRows, {
      get hidden() {
        return ownSettingsRows.length === 0
      },
    }),
    group('details', [
      {
        id: 'version',
        icon: 'info',
        title: 'Version',
        get value() {
          return current()?.metadata.version || 'Not specified'
        },
      },
      {
        id: 'authors',
        icon: 'person',
        title: 'Authors',
        get value() {
          const plugin = current()
          return plugin ? describeAuthors(plugin.metadata) : ''
        },
      },
      {
        id: 'platforms',
        icon: 'devices',
        title: 'Platforms',
        get value() {
          const plugin = current()
          return plugin ? describePlatforms(plugin.metadata) : ''
        },
      },
      {
        id: 'requires',
        icon: 'extension',
        title: 'Needs',
        get value() {
          const plugin = current()
          return plugin ? describeRequirements(plugin) : ''
        },
        get hidden() {
          const plugin = current()
          return !plugin || describeRequirements(plugin) === ''
        },
      },
      {
        id: 'incompatible',
        icon: 'block',
        title: 'Doesn\'t work with',
        get value() {
          const plugin = current()
          return plugin ? describeConflicts(plugin) : ''
        },
        get hidden() {
          const plugin = current()
          return !plugin || describeConflicts(plugin) === ''
        },
      },
      {
        id: 'source',
        icon: 'link',
        title: 'Source',
        get value() {
          return current()?.metadata.source || 'Not specified'
        },
        get chevron() {
          return /^https?:\/\//.test(current()?.metadata.source ?? '')
        },
        onClick: () => openLink(current()?.metadata.source ?? ''),
      },
      {
        id: 'hash',
        icon: 'fingerprint',
        title: 'Code fingerprint (SHA-256)',
        get value() {
          return current()?.sha256.slice(0, 16) ?? ''
        },
      },
    ]),
    { id: 'log-header', type: 'header', title: 'Log' },
    { id: 'log', type: 'component', component: PluginLog, props: { source: id } },
    group('remove', [
      {
        id: 'remove',
        icon: 'delete',
        title: 'Remove plugin',
        destructive: true,
        onClick() {
          const plugin = current()
          if (plugin) confirmRemove(plugin, () => void goBack())
        },
      },
    ]),
  ]
}

/** A row opening a settings section. */
function sectionRow(id: string): SettingsRowDef {
  return {
    id,
    get icon() {
      return findSection(id)?.icon ?? 'plugin'
    },
    get title() {
      return findSection(id)?.title ?? id
    },
    get description() {
      return findSection(id)?.description
    },
    chevron: true,
    onClick: () => void navigate({ name: 'settings-page', page: id }),
  }
}

/* ------------------------------------------------------------------ *
 * The main section
 * ------------------------------------------------------------------ */

/** Settings sections that plugins added (and didn't ask to put on the main list). */
const pluginSectionRows: SettingsRowDef[] = []

export function definePluginSettings() {
  const pluginSectionsGroup = group('plugin-sections', pluginSectionRows)

  defineSection(
    {
      id: 'plugins',
      icon: 'plugin',
      title: 'Plugins',
      get description() {
        const count = installedPlugins.value.length
        return count === 0 ? 'Services and extensions' : `${count} installed`
      },
    },
    [
      group('controls', [
        {
          id: 'active',
          icon: 'plugin',
          title: 'Run plugins',
          description: 'Turn off to stop every installed plugin without removing them (safe mode).',
          toggle: {
            get value() {
              return pluginsActive.value
            },
            set(value) {
              void setPluginsActive(value)
            },
          },
        },
        {
          id: 'keep-enabled',
          icon: 'refresh',
          title: 'Keep plugins enabled when updating',
          description: 'A newer version of a plugin you turned on starts right away. Off: every update has to be enabled and approved again.',
          toggle: {
            get value() {
              return keepEnabledOnUpdate.value
            },
            set(value) {
              keepEnabledOnUpdate.value = value
            },
          },
        },
        {
          id: 'collections',
          icon: 'library',
          title: 'Collections',
          chevron: true,
          get description() {
            const count = collections.value.length
            const waiting = updates.value.length
            if (count === 0) return 'Install and update plugins from a list'
            return `${count} ${count === 1 ? 'collection' : 'collections'}${waiting > 0 ? ` • ${waiting} ${waiting === 1 ? 'update' : 'updates'}` : ''}`
          },
          onClick: () => void navigate({ name: 'settings-page', page: 'plugin-collections' }),
        },
        { id: 'install-file', icon: 'upload', title: 'Install from file', description: 'A .zip or .noctis archive', onClick: installFile },
        { id: 'install-url', icon: 'add-link', title: 'Install from URL', description: 'A link to a .zip or .noctis archive', onClick: installUrl },
      ]),
      { id: 'installed-header', type: 'header', title: 'Installed' },
      {
        id: 'installed',
        type: 'component',
        component: InstalledPlugins,
        props: {
          // Its settings' icon, so a plugin without an image isn't a column of identical puzzle pieces.
          icon: (plugin: InstalledPlugin) => sectionsOwnedBy(plugin.id).find((section) => !section.hidden)?.icon ?? 'plugin',
          description(plugin: InstalledPlugin) {
            const version = plugin.metadata.version ? `v${plugin.metadata.version} • ` : ''
            return `${version}${describeAuthors(plugin.metadata)} • ${stateLabel(plugin)}`
          },
          open: (plugin: InstalledPlugin) => void navigate({ name: 'settings-page', page: sectionId(plugin) }),
          toggle(plugin: InstalledPlugin, value: boolean) {
            if (value) requestEnable(plugin)
            else void disablePlugin(plugin)
          },
          remove: (plugin: InstalledPlugin) => confirmRemove(plugin),
        },
      },
      {
        id: 'empty',
        type: 'note',
        text: 'Plugins add services (YouTube Music, SoundCloud…) and features. Install one from a file or a link above, or add a collection to choose from a list.',
        get hidden() {
          return installedPlugins.value.length > 0
        },
      },
      { id: 'sections-header', type: 'header', title: 'Plugin settings', get hidden() { return pluginSectionRows.length === 0 } },
      pluginSectionsGroup,
      group('log', [
        { id: 'log', icon: 'terminal', title: 'Log', description: 'Messages from plugins and the plugin system', chevron: true, onClick: () => void navigate({ name: 'settings-page', page: 'plugins-log' }) },
      ]),
    ],
    'noctis',
  )

  defineCollectionsSection()

  defineSection({ id: 'plugins-log', icon: 'terminal', title: 'Plugin log', hidden: true }, [
    { id: 'log', type: 'component', component: PluginLog },
  ], 'noctis')

  // Plugins' own settings sections live here, unless they asked for the main list.
  watch(
    () => Sections.filter((section) => !section.hidden && !isMainSection(section)).map((section) => section.id),
    (ids) => {
      pluginSectionRows.splice(0, pluginSectionRows.length, ...ids.map((id) => sectionRow(id)))
    },
    { immediate: true },
  )

  // Keep the installed list and the per-plugin sections in step with what's installed.
  watch(
    installedPlugins,
    (plugins) => {
      const ids = new Set(plugins.map(sectionId))
      for (const id of Object.keys(Rows)) {
        if (id.startsWith('plugin:') && !ids.has(id)) removeSection(id)
      }
      for (const plugin of plugins) {
        if (findSection(sectionId(plugin))) continue
        defineSection({ id: sectionId(plugin), icon: 'plugin', title: plugin.metadata.name, hidden: true }, pluginBlocks(plugin.id), 'noctis')
      }
    },
    { immediate: true },
  )
}

/* ------------------------------------------------------------------ *
 * Collections
 * ------------------------------------------------------------------ */

function addCollectionDialog() {
  showTextDialog({
    title: 'Add a collection',
    description: 'The address of a plugin collection (plugins.json). On your own network, http works too: `bun run serve-plugins` serves one while you develop.',
    placeholder: 'https://…/plugins.json',
    confirmLabel: 'Add',
    async onConfirm(value) {
      try {
        await addCollection(value)
        notify('Collection added')
      } catch (error) {
        reportFailure(error)
      }
    },
  })
}

async function runUpdateAll() {
  const count = updates.value.length
  if (count === 0) return notify('Everything is up to date')
  const { updated, failed } = await updateAll()
  for (const message of failed) writeLog('noctis', 'error', message)
  notify(failed.length > 0 ? `Updated ${updated}, ${failed.length} failed: ${failed[0]}` : `Updated ${updated} ${updated === 1 ? 'plugin' : 'plugins'}`)
}

async function installListed(entry: Parameters<typeof installEntry>[0]) {
  try {
    reportInstall(await installEntry(entry))
  } catch (error) {
    reportFailure(error)
  }
}

/** The collections page: the head is fixed, the rest is rebuilt whenever a collection or an install changes. */
function defineCollectionsSection() {
  const id = 'plugin-collections'
  const head: SettingsBlock[] = [
    group('actions', [
      { id: 'add', icon: 'add-link', title: 'Add a collection', description: 'A link to a plugins.json list', onClick: addCollectionDialog },
      {
        id: 'update-all',
        icon: 'refresh',
        title: 'Update all',
        get description() {
          const count = updates.value.length
          return count === 0 ? 'Everything is up to date' : `${count} ${count === 1 ? 'plugin has' : 'plugins have'} a newer version`
        },
        get disabled() {
          return updates.value.length === 0
        },
        // Nothing to update from (and "Everything is up to date" said otherwise) until there's a collection.
        get hidden() {
          return collections.value.length === 0
        },
        onClick: () => void runUpdateAll(),
      },
      {
        id: 'check',
        icon: 'cached',
        title: 'Check for updates',
        description: 'Ask every collection for newer versions now',
        get hidden() {
          return collections.value.length === 0
        },
        onClick: () => void refreshAll(),
      },
      {
        id: 'check-on-start',
        icon: 'notifications',
        title: 'Check when Noctis starts',
        description: 'Say so when a collection has a newer version of a plugin you have',
        toggle: {
          get value() {
            return checkOnStart.value
          },
          set(value) {
            checkOnStart.value = value
          },
        },
      },
    ]),
    {
      id: 'empty',
      type: 'note',
      text: 'A collection is a link to a list of plugins (plugins.json). Add one, and its plugins can be installed, and updated when the list has a newer version, without downloading files by hand.',
      get hidden() {
        return collections.value.length > 0
      },
    },
  ]

  defineSection({ id, icon: 'library', title: 'Collections', hidden: true }, [...head], 'noctis')

  const rebuild = () => {
    const blocks = Rows[id]
    if (!blocks) return
    const dynamic: SettingsBlock[] = []
    for (const saved of collections.value) {
      const url = saved.url
      const state = () => states[url]
      dynamic.push({ id: `header:${url}`, type: 'header', title: saved.name })
      const rows: SettingsRowDef[] = []
      const ready = state()
      if (ready?.status === 'ready') {
        for (const entry of ready.plugins) {
          rows.push({
            id: entry.id,
            icon: 'plugin',
            title: entry.name,
            get description() {
              return [entry.version && `v${entry.version}`, entry.description].filter(Boolean).join(' • ')
            },
            get value() {
              const status = statusOf(entry)
              return status === 'current' ? 'Installed' : status === 'update' ? 'Update' : 'Install'
            },
            onClick: () => (statusOf(entry) === 'current' ? undefined : installListed(entry)),
          })
        }
      } else {
        rows.push({
          id: 'status',
          icon: ready?.status === 'error' ? 'warning' : 'cached',
          title: ready?.status === 'error' ? "Couldn't read this collection" : 'Loading…',
          description: ready?.status === 'error' ? ready.message : undefined,
          onClick: () => void refreshCollection(url),
        })
      }
      rows.push(
        { id: 'copy', icon: 'link', title: 'Address', value: url },
        {
          id: 'remove',
          icon: 'delete',
          title: 'Remove this collection',
          description: 'The plugins you installed from it stay',
          destructive: true,
          onClick: () => removeCollection(url),
        },
      )
      dynamic.push(group(`plugins:${url}`, rows))
    }
    blocks.splice(head.length, blocks.length - head.length, ...dynamic)
  }

  // Which collections there are and whether their lists are loaded decide the shape; installs only change row values (getters).
  watch(
    () => [collections.value.map((item) => `${item.url}\n${item.name}`).join(), Object.entries(states).map(([url, state]) => `${url}:${state.status}`).join()],
    rebuild,
    { immediate: true },
  )

  // Lists load when the page first needs them.
  watch(
    collections,
    (list) => {
      for (const { url } of list) if (!states[url]) void refreshCollection(url)
    },
    { immediate: true },
  )
}
