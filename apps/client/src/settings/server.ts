import { shallowReactive, watch } from 'vue'
import { defineSection, group, type SettingsRowDef } from '../plugins/rows'
import { enablePlugin } from '../plugins/runtime'
import { approvedHashes, findPlugin } from '../plugins/store'
import { connect, disconnect, handshake, installFromServer, missingPlugins, serverError, serverStatus, serverUrl } from '../server'
import { notify } from '../snackbar'
import { confirm, showTextDialog } from '../ui'

/** Settings → Server: connect to a Noctis server and install the plugins it requires. */

const STATUS: Record<string, string> = {
  none: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  'needs-plugins': 'Needs plugins to connect',
  error: "Couldn't connect",
}

function promptAddress() {
  showTextDialog({
    title: 'Connect to a server',
    description: 'The address of a Noctis server, like https://music.example.com or http://192.168.1.10:4747.',
    placeholder: 'https://',
    confirmLabel: 'Connect',
    async onConfirm(value) {
      try {
        const response = await connect(value)
        notify(response.result.ok ? `Connected to ${response.server.name}` : `${response.server.name} needs plugins to connect`)
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error))
      }
    },
  })
}

/** Install and enable every missing required plugin, after one confirmation. */
function installRequired() {
  const needed = missingPlugins.value
  if (needed.length === 0) return
  const names = needed.map((item) => `${item.name} ${item.version}`).join(', ')
  confirm({
    title: `Install ${needed.length === 1 ? 'a plugin' : `${needed.length} plugins`} from the server?`,
    message: `${handshake.value?.server.name ?? 'The server'} requires: ${names}. Plugins run with full access to Noctis; only connect to servers you trust.`,
    confirmLabel: 'Install',
    destructive: true,
    async onConfirm() {
      for (const requirement of needed) {
        try {
          const { plugin } = await installFromServer(requirement)
          approvedHashes.value = { ...approvedHashes.value, [plugin.sha256]: true }
          if (!(await enablePlugin(plugin))) notify(`${plugin.metadata.name} failed to start. Its log has details.`)
        } catch (error) {
          notify(error instanceof Error ? error.message : String(error))
          return
        }
      }
      try {
        const response = await connect()
        notify(response.result.ok ? `Connected to ${response.server.name}` : 'Some plugins are still missing')
      } catch {
        /* status shows the error */
      }
    },
  })
}

const pluginRows = shallowReactive<SettingsRowDef[]>([])

export function defineServerSettings() {
  defineSection(
    {
      id: 'server',
      icon: 'server',
      title: 'Server',
      get description() {
        return serverStatus.value === 'none' ? 'Connect to a Noctis server' : `${STATUS[serverStatus.value]} · ${handshake.value?.server.name ?? serverUrl.value}`
      },
    },
    [
      group('connection', [
        {
          id: 'address',
          icon: 'server',
          title: 'Server',
          get value() {
            return serverUrl.value || 'Not connected'
          },
          chevron: true,
          onClick: promptAddress,
        },
        {
          id: 'status',
          icon: 'sync',
          title: 'Status',
          get value() {
            const name = handshake.value ? ` · ${handshake.value.server.name} ${handshake.value.server.version}` : ''
            return serverStatus.value === 'error' ? `${STATUS.error}: ${serverError.value}` : `${STATUS[serverStatus.value]}${name}`
          },
          get hidden() {
            return serverStatus.value === 'none'
          },
          onClick: () => void connect().catch(() => {}),
        },
      ]),
      { id: 'plugins-header', type: 'header', title: 'Plugins the server uses', get hidden() { return pluginRows.length === 0 } },
      group('plugins', pluginRows),
      group('install', [
        {
          id: 'install',
          icon: 'download',
          title: 'Install required plugins',
          get description() {
            return missingPlugins.value.map((item) => item.name).join(', ')
          },
          onClick: installRequired,
        },
      ], {
        get hidden() {
          return missingPlugins.value.length === 0
        },
      }),
      group('disconnect', [{ id: 'disconnect', icon: 'logout', title: 'Disconnect', destructive: true, onClick: disconnect }], {
        get hidden() {
          return serverStatus.value === 'none'
        },
      }),
      {
        id: 'note',
        type: 'note',
        text: 'Like a modded Minecraft server, a Noctis server can require client plugins. They are downloaded from the server and checked against the hashes it announces before installing.',
      },
    ],
    'noctis',
  )

  // One row per client plugin the server announces, with whether this client has it.
  watch(
    handshake,
    (response) => {
      const missing = new Set(response?.result.missing.map((item) => item.id))
      const outdated = new Map(response?.result.outdated.map((item) => [item.requirement.id, item.installed]))
      pluginRows.splice(
        0,
        pluginRows.length,
        ...(response?.plugins ?? []).map((requirement): SettingsRowDef => ({
          id: requirement.id,
          icon: 'plugin',
          title: requirement.name,
          get value() {
            if (missing.has(requirement.id)) return `Missing · ${requirement.versions}${requirement.required ? ' · required' : ''}`
            if (outdated.has(requirement.id)) return `Version ${outdated.get(requirement.id)} installed, needs ${requirement.versions}`
            const installed = findPlugin(requirement.id)
            return installed ? `Installed · ${installed.metadata.version}` : `Optional · ${requirement.versions}`
          },
        })),
      )
    },
    { immediate: true },
  )
}
