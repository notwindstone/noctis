import { shallowReactive, watch } from 'vue'
import {
  addLocalFolder,
  browserMusic,
  canAddFolders,
  DEVICE_FOLDER,
  localFolders,
  localTracks,
  musicPermission,
  hasMediaStore,
  nativeMusic,
  removeLocalFolder,
  requestMusicAccess,
  scanCount,
  scanLocalLibrary,
  scanning,
  scanWholeDevice,
} from '../local/library'
import { defineSection, group, type SettingsRowDef } from '../plugins/rows'
import { navigate } from '../navigation'
import { notify } from '../snackbar'
import { confirm } from '../ui'

/**
 * Settings → Local music. On Android: the whole device (Android's media index, with the
 * music permission), plus extra folders for music it misses. In browsers: folders.
 * Songs show up under "On this device", and count as copies for "Play from".
 */

const deviceCount = () => localTracks.value.filter((track) => track.folderId === DEVICE_FOLDER).length

const PERMISSION_TEXT: Record<string, string> = {
  granted: 'Allowed',
  denied: 'Not allowed: allow "Music and audio" for Noctis in Android settings',
  prompt: 'Noctis needs permission to read music',
  'prompt-with-rationale': 'Noctis needs permission to read music',
}

const folderRows = shallowReactive<SettingsRowDef[]>([])

async function add() {
  try {
    const added = await addLocalFolder()
    if (!added) return
    const { folder, merged } = added
    const songs = localTracks.value.filter((track) => track.folderId === folder.id).length
    notify(`Added "${folder.name}": ${songs} songs${merged.length > 0 ? `, including ${merged.map((item) => `"${item.name}"`).join(', ')}` : ''}`)
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error))
  }
}

export function defineLocalSettings() {
  defineSection(
    {
      id: 'local-music',
      icon: 'folder',
      title: 'Local music',
      get description() {
        const count = localTracks.value.length
        if (count === 0) return nativeMusic ? 'Play the music on this device' : 'Play music from folders on this device'
        return `${count} ${count === 1 ? 'song' : 'songs'} on this device`
      },
    },
    [
      group('view', [
        {
          id: 'view',
          icon: 'device-music',
          title: 'View local music',
          description: 'Open it in the Library',
          chevron: true,
          get hidden() {
            return localTracks.value.length === 0
          },
          onClick: () => void navigate({ name: 'collection', id: 'local' }),
        },
      ]),
      // Android: the whole device.
      group('device', [
        {
          id: 'whole-device',
          icon: 'device-music',
          title: 'Scan the whole device',
          get description() {
            if (musicPermission.value !== 'granted') return PERMISSION_TEXT[musicPermission.value] ?? PERMISSION_TEXT.prompt
            return scanning.value ? `Scanning… ${scanCount.value} songs` : `${deviceCount()} songs found by Android's media index`
          },
          toggle: {
            get value() {
              return scanWholeDevice.value && musicPermission.value === 'granted'
            },
            async set(value: boolean) {
              if (value && musicPermission.value !== 'granted') {
                const state = await requestMusicAccess()
                if (state !== 'granted') notify('Allow "Music and audio" for Noctis in Android settings to scan the device')
                return
              }
              scanWholeDevice.value = value
              void scanLocalLibrary()
            },
          },
        },
      ], {
        get hidden() {
          return !hasMediaStore
        },
      }),
      { id: 'folders-header', type: 'header', get title() { return hasMediaStore ? 'Extra folders' : 'Folders' }, get hidden() { return folderRows.length === 0 } },
      group('folders', folderRows),
      group('actions', [
        {
          id: 'add',
          icon: 'add-link',
          get title() {
            return hasMediaStore ? 'Add a folder the scan missed' : 'Add a folder'
          },
          description: hasMediaStore ? 'For music Android doesn\'t index, like folders with a .nomedia file' : nativeMusic ? 'Pick a folder in Files' : 'Your browser asks which folder',
          get disabled() {
            return !canAddFolders || scanning.value
          },
          onClick: add,
        },
        {
          id: 'rescan',
          icon: 'sync',
          title: 'Rescan',
          get description() {
            return scanning.value ? `Scanning… ${scanCount.value} songs` : 'Pick up new, changed and removed files'
          },
          get hidden() {
            return localFolders.value.length === 0 && !(hasMediaStore && scanWholeDevice.value && musicPermission.value === 'granted')
          },
          get disabled() {
            return scanning.value
          },
          onClick: () => void scanLocalLibrary().then((count) => notify(`${count} songs on this device`)),
        },
      ]),
      {
        id: 'note',
        type: 'note',
        get text() {
          if (!canAddFolders) return "This browser can't open folders (the File System Access API is missing). Use the Android app, or a Chromium-based browser."
          return `Songs show up under "On this device", and as a copy in "Play from" when the same song comes from a server or a service.${hasMediaStore ? ' A song found both by the scan and in an extra folder is listed once.' : ''}${browserMusic ? ' Browsers ask again for access to a folder after a restart.' : ''}`
        },
      },
    ],
    'noctis',
  )

  watch(
    localFolders,
    (folders) => {
      folderRows.splice(
        0,
        folderRows.length,
        ...folders.map((folder): SettingsRowDef => ({
          id: folder.id,
          icon: 'folder',
          title: folder.name,
          get description() {
            const count = localTracks.value.filter((track) => track.folderId === folder.id).length
            return `${count} ${count === 1 ? 'song' : 'songs'}${folder.scanned ? ` · scanned ${new Date(folder.scanned).toLocaleDateString()}` : ''}`
          },
          onClick: () =>
            confirm({
              title: `Remove "${folder.name}"?`,
              message: 'Its songs leave Noctis; the files stay where they are.',
              confirmLabel: 'Remove',
              destructive: true,
              onConfirm: () => removeLocalFolder(folder.id),
            }),
        })),
      )
    },
    { immediate: true },
  )
}
