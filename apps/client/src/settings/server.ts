import { shallowReactive, watch } from 'vue'
import { defineSection, group, type SettingsRowDef } from '../plugins/rows'
import { enablePlugin } from '../plugins/runtime'
import { approvedHashes, findPlugin } from '../plugins/store'
import { connect, disconnect, handshake, installFromServer, missingPlugins, otherServerName, serverError, serverKind, serverStatus, serverUrl, signIn, signInWithApiKey, signOut } from '../server'
import { credentials } from '../subsonic/client'
import { notify } from '../snackbar'
import { confirm, showTextDialog } from '../ui'

/**
 * Settings → Server: connect to a Noctis or OpenSubsonic server, sign in, choose where
 * songs play from, and install the plugins a Noctis server requires.
 */

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
    description: 'A Noctis server, or any OpenSubsonic server (Navidrome, Gonic…): https://music.example.com, 192.168.1.10:4747…',
    placeholder: 'https://',
    confirmLabel: 'Connect',
    async onConfirm(value) {
      try {
        const response = await connect(value)
        if (!response) notify(`Connected to ${otherServerName.value}`)
        else notify(response.result.ok ? `Connected to ${response.server.name}` : `${response.server.name} needs plugins to connect`)
        if (!credentials.value && (!response || response.result.ok)) promptSignIn()
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
        notify(!response || response.result.ok ? 'Connected' : 'Some plugins are still missing')
        if (!credentials.value) promptSignIn()
      } catch {
        /* status shows the error */
      }
    },
  })
}

/** Noctis servers: username, then password (the text dialog has one field). Others: an API key. */
function promptSignIn() {
  if (serverKind.value !== 'noctis') {
    showTextDialog({
      title: 'Sign in with an API key',
      description: `Create an API key in ${serverName()}'s settings and paste it here. Noctis only uses API keys (OpenSubsonic apiKeyAuthentication), never your password.`,
      placeholder: 'API key',
      confirmLabel: 'Sign in',
      async onConfirm(key) {
        try {
          await signInWithApiKey(key)
          notify(`Signed in to ${serverName()}`)
        } catch (error) {
          notify(error instanceof Error ? error.message : String(error))
        }
      },
    })
    return
  }
  showTextDialog({
    title: 'Sign in',
    description: `Your account on ${serverName()}.`,
    placeholder: 'Username',
    confirmLabel: 'Next',
    onConfirm(username) {
      if (!username.trim()) return
      showTextDialog({
        title: `Password for ${username.trim()}`,
        description: 'Exchanged for a session; the password isn\'t kept on this device.',
        placeholder: 'Password',
        confirmLabel: 'Sign in',
        async onConfirm(password) {
          try {
            await signIn(username.trim(), password)
            notify(`Signed in as ${username.trim()}`)
          } catch (error) {
            notify(error instanceof Error ? error.message : String(error))
          }
        },
      })
    },
  })
}

const serverName = () => handshake.value?.server.name ?? (otherServerName.value || serverUrl.value)

const pluginRows = shallowReactive<SettingsRowDef[]>([])

export function defineServerSettings() {
  defineSection(
    {
      id: 'server',
      icon: 'server',
      title: 'Server',
      get description() {
        return serverStatus.value === 'none' ? 'Noctis or OpenSubsonic' : `${STATUS[serverStatus.value]} · ${serverName()}`
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
            const name = handshake.value ? ` · ${handshake.value.server.name} ${handshake.value.server.version}` : serverKind.value === 'opensubsonic' ? ` · ${otherServerName.value} (OpenSubsonic)` : ''
            return serverStatus.value === 'error' ? `${STATUS.error}: ${serverError.value}` : `${STATUS[serverStatus.value]}${name}`
          },
          get hidden() {
            return serverStatus.value === 'none'
          },
          onClick: () => void connect().catch(() => {}),
        },
      ]),
      group('account', [
        {
          id: 'sign-in',
          icon: 'login',
          title: 'Sign in',
          description: 'Your library, playlists and recommendations',
          get hidden() {
            return credentials.value !== null
          },
          onClick: promptSignIn,
        },
        {
          id: 'signed-in',
          icon: 'account',
          title: 'Signed in',
          get value() {
            return credentials.value ? `${credentials.value.username} · ${serverKind.value === 'noctis' ? 'session' : 'API key'}` : ''
          },
          get hidden() {
            return credentials.value === null
          },
        },
        {
          id: 'sign-out',
          icon: 'logout',
          title: 'Sign out',
          destructive: true,
          get hidden() {
            return credentials.value === null
          },
          onClick: () => void signOut().then(() => notify('Signed out')),
        },
      ], {
        get hidden() {
          return serverStatus.value !== 'connected'
        },
      }),
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
        text: 'Songs on a Noctis server can have several sources; "Play from" (Settings → Playback, or the player\'s menu) chooses between the server\'s streams, your own services and copies on this device. Like a modded Minecraft server, a Noctis server can also require client plugins: they\'re downloaded from the server and checked against the hashes it announces before installing.',
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
