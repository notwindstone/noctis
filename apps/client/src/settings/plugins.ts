import { nextTick, watch } from 'vue'
import { describePlatforms } from '@noctis/plugin-core'
import PluginLog from '../components/settings/PluginLog.vue'
import { goBack, navigate } from '../navigation'
import { installFromArchive, installFromFile, installFromUrl, PluginInstallError, pickPluginFile, type InstallResult } from '../plugins/install'
import { writeLog } from '../plugins/log'
import { defineSection, findSection, group, isMainSection, removeSection, Rows, Sections, type SettingsBlock, type SettingsRowDef } from '../plugins/rows'
import { disablePlugin, enablePlugin, removePlugin, runStates, setPluginsActive } from '../plugins/runtime'
import {
  approvedHashes,
  describeAuthors,
  findPlugin,
  installedPlugins,
  isEnabled,
  pluginsActive,
  type InstalledPlugin,
} from '../plugins/store'
import { notify } from '../snackbar'
import { confirm, showTextDialog } from '../ui'

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
    confirmLabel: 'Enable',
    destructive: true,
    onConfirm: run,
  })
}

function reportInstall(result: InstallResult) {
  const { plugin, replaced, sameCode } = result
  if (replaced && sameCode) notify(`${plugin.metadata.name} is already installed`)
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

/* ------------------------------------------------------------------ *
 * One section per plugin
 * ------------------------------------------------------------------ */

function pluginBlocks(id: string): SettingsBlock[] {
  // Look the plugin up on every read: reinstalling replaces the object.
  const current = () => findPlugin(id)

  return [
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
        id: 'source',
        icon: 'link',
        title: 'Source',
        get value() {
          return current()?.metadata.source || 'Not specified'
        },
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
          if (!plugin) return
          confirm({
            title: `Remove ${plugin.metadata.name}?`,
            message: 'It will be stopped and deleted from this device.',
            confirmLabel: 'Remove',
            destructive: true,
            onConfirm: async () => {
              await removePlugin(plugin)
              notify(`Removed ${plugin.metadata.name}`)
              void goBack()
            },
          })
        },
      },
    ]),
  ]
}

/* ------------------------------------------------------------------ *
 * The main section
 * ------------------------------------------------------------------ */

const installedRows: SettingsRowDef[] = []
/** Settings sections that plugins added (and didn't ask to put on the main list). */
const pluginSectionRows: SettingsRowDef[] = []

export function definePluginSettings() {
  const installedGroup = group('installed', installedRows)
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
        { id: 'install-file', icon: 'upload', title: 'Install from file', description: 'A .zip or .noctis archive', onClick: installFile },
        { id: 'install-url', icon: 'add-link', title: 'Install from URL', onClick: installUrl },
      ]),
      { id: 'installed-header', type: 'header', title: 'Installed' },
      installedGroup,
      {
        id: 'empty',
        type: 'note',
        text: 'Add services and features with plugins: a .zip or .noctis archive with index.js and metadata.json. See docs/PLUGINS.md.',
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

  defineSection({ id: 'plugins-log', icon: 'terminal', title: 'Plugin log', hidden: true }, [
    { id: 'log', type: 'component', component: PluginLog },
  ], 'noctis')

  // Plugins' own settings sections live here, unless they asked for the main list.
  watch(
    () => Sections.filter((section) => !section.hidden && !isMainSection(section)).map((section) => section.id),
    (ids) => {
      pluginSectionRows.splice(
        0,
        pluginSectionRows.length,
        ...ids.map((id): SettingsRowDef => ({
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
        })),
      )
    },
    { immediate: true },
  )

  // Keep the installed list and the per-plugin sections in step with what's installed.
  watch(
    installedPlugins,
    (plugins) => {
      const rows = (installedGroup as { rows: SettingsRowDef[] }).rows
      rows.splice(
        0,
        rows.length,
        ...plugins.map((plugin): SettingsRowDef => {
          const id = plugin.id
          return {
            id,
            icon: 'plugin',
            get title() {
              return findPlugin(id)?.metadata.name ?? id
            },
            get description() {
              const current = findPlugin(id)
              if (!current) return ''
              const version = current.metadata.version ? `v${current.metadata.version} · ` : ''
              return `${version}${describeAuthors(current.metadata)} · ${stateLabel(current)}`
            },
            chevron: true,
            onClick: () => void navigate({ name: 'settings-page', page: sectionId(plugin) }),
          }
        }),
      )

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
