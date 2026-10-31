import { describePlatforms } from '@noctis/plugin-core'
import { shallowReactive, watch } from 'vue'
import { defineSection, group, type SettingsRowDef } from '../plugins/rows'
import { enablePlugin } from '../plugins/runtime'
import { approvedHashes, findPlugin } from '../plugins/store'
import { connect, disconnect, handshake, installFromServer, missingPlugins, otherServerName, serverError, serverKind, serverStatus, serverUrl } from '../server'
import { registerAccount } from '../accounts'
import { serverAccount } from '../subsonic/account'
import { credentials, guestAccess } from '../subsonic/client'
import { notify } from '../snackbar'
import { confirm, showTextDialog } from '../ui'

/**
 * Settings → Server: connect to a Noctis or OpenSubsonic server, sign in, choose where
 * songs play from, and install the plugins a Noctis server requires.
 *
 * Connecting never pops up a sign-in: on servers with guest access it's optional, and
 * elsewhere the "Sign in" row (and Home) say it's needed — when to do it is up to you.
 */

const STATUS: Record<string, string> = {
  none: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  // Connected, and most things work; some server features wait for the plugins it asks for.
  'needs-plugins': 'Connected, missing plugins',
  error: "Couldn't connect",
}

function promptAddress() {
  showTextDialog({
    title: 'Connect to a server',
    description: 'A Noctis server, or any OpenSubsonic server (Navidrome, Gonic…): https://music.example.com, 192.168.1.10:4747…',
    placeholder: 'https://',
    confirmLabel: 'Connect',
    async onConfirm(value) {
      try {
        const response = await connect(value)
        if (response && !response.result.ok) notify(`${response.server.name} needs plugins to connect`)
        else notify(connectedMessage())
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
        notify(!response || response.result.ok ? connectedMessage() : 'Some plugins are still missing')
      } catch {
        /* status shows the error */
      }
    },
  })
}

/** A version range in words: "^1.2.0" → "1.2 or newer". */
function versionsLabel(range: string): string {
  const caret = /^[\^~>=]*\s*(\d+)\.(\d+)/.exec(range.trim())
  if (range.trim() === '*' || range.trim() === '') return 'any version'
  return caret ? `${caret[1]}.${caret[2]} or newer` : range
}

const serverName = () => handshake.value?.server.name ?? (otherServerName.value || serverUrl.value)

/** What connecting got you: everything, guest access, or a server to sign in to. */
function connectedMessage(): string {
  if (credentials.value) return `Connected to ${serverName()}`
  if (guestAccess.value) return `Connected to ${serverName()} as a guest`
  return `Connected to ${serverName()}. Sign in to use it`
}

const pluginRows = shallowReactive<SettingsRowDef[]>([])

export function defineServerSettings() {
  // The server's account is there even before signing in (when it isn't a service yet).
  registerAccount('noctis-server', {
    get name() {
      return serverName()
    },
    icon: 'server',
    account: serverAccount,
    get hidden() {
      return serverStatus.value === 'none' || serverStatus.value === 'error'
    },
  })

  defineSection(
    {
      id: 'server',
      icon: 'server',
      title: 'Server',
      get description() {
        return serverStatus.value === 'none' ? 'Noctis or OpenSubsonic' : `${STATUS[serverStatus.value]} • ${serverName()}`
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
            const name = handshake.value ? ` • ${handshake.value.server.name} ${handshake.value.server.version}` : serverKind.value === 'opensubsonic' ? ` • ${otherServerName.value} (OpenSubsonic)` : ''
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
        text: 'A song on a Noctis server can have several sources: "Play from" (Settings → Playback, or the player\'s menu) chooses between the server\'s streams, your own services and copies on this device. A server can also ask for client plugins; they\'re downloaded from it and checked against the fingerprints it announces before they\'re installed.',
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
      const unsupported = new Set(response?.result.unsupported?.map((item) => item.id))
      pluginRows.splice(
        0,
        pluginRows.length,
        ...(response?.plugins ?? []).map((requirement): SettingsRowDef => ({
          id: requirement.id,
          icon: 'plugin',
          title: requirement.name,
          get value() {
            if (unsupported.has(requirement.id)) return `Not needed here • made for ${describePlatforms(requirement)}`
            if (missing.has(requirement.id)) return `${requirement.required ? 'Required' : 'Optional'}, not installed • ${versionsLabel(requirement.versions)}`
            if (outdated.has(requirement.id)) return `Version ${outdated.get(requirement.id)} installed, needs ${versionsLabel(requirement.versions)}`
            const installed = findPlugin(requirement.id)
            return installed ? `Installed • ${installed.metadata.version}` : `Optional • ${versionsLabel(requirement.versions)}`
          },
        })),
      )
    },
    { immediate: true },
  )
}
