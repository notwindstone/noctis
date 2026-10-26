import { canonicalOption, chooseOption, pickOption, playbackOptions, playbackPreference, type PlaybackOption, type PlaybackPreference } from './playFrom'
import { currentSong, reloadCurrent } from './player'
import { enablePlugin } from './plugins/runtime'
import { approvedHashes } from './plugins/store'
import { handshake, installFromServer } from './server'
import { notify } from './snackbar'
import { confirm } from './ui'
import type { Song } from './models'

/**
 * What the Play from dialog does (kept out of the component, so a plugin replacing the
 * dialog can reuse it): change the choice for one song or the preference for all, and
 * switch the playing song over, where it is, when that changes where it plays from.
 */

const sameSong = (a: Song | null, b: Song) => a !== null && a.id === b.id && a.source === b.source

async function switchingCurrent(change: () => void) {
  const song = currentSong.value
  const options = song ? await playbackOptions(song) : []
  const before = song ? canonicalOption(options, pickOption(song, options)) : null
  change()
  if (!song || !sameSong(currentSong.value, song)) return
  const after = canonicalOption(options, pickOption(song, options))
  if (after === before) return
  void reloadCurrent()
  notify(`Playing from ${options.find((option) => option.id === after)?.label ?? 'another source'}`)
}

/** Play `song` from one option from now on; null follows the preference again. */
export function chooseForSong(song: Song, optionId: string | null) {
  return switchingCurrent(() => chooseOption(song, optionId))
}

/**
 * Where every song plays from. `song` (the one the dialog was opened for) drops its own
 * choice, so the new preference applies to it too.
 */
export function chooseForAll(preference: PlaybackPreference, song?: Song | null) {
  return switchingCurrent(() => {
    playbackPreference.value = preference
    if (song) chooseOption(song, null)
  })
}

/** An option needs a client plugin the server offers: install it (after asking), then play from it. */
export function installAndChoose(song: Song, option: PlaybackOption) {
  const requirement = handshake.value?.plugins.find((item) => item.id === option.install?.plugin)
  if (!requirement) {
    notify(option.description ?? 'Not available')
    return
  }
  confirm({
    title: `Install ${requirement.name}?`,
    message: `${requirement.name} ${requirement.version} plays this song with your own account. Plugins run with full access to Noctis; only install ones you trust.`,
    confirmLabel: 'Install',
    destructive: true,
    async onConfirm() {
      try {
        const { plugin } = await installFromServer(requirement)
        approvedHashes.value = { ...approvedHashes.value, [plugin.sha256]: true }
        if (!(await enablePlugin(plugin))) throw new Error(`${plugin.metadata.name} failed to start`)
        const fresh = (await playbackOptions(song)).find((item) => item.id === option.id)
        if (fresh?.available) await chooseForSong(song, fresh.id)
        else notify(`Installed ${plugin.metadata.name}; sign in to it to play from there`)
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error))
      }
    },
  })
}
