<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, ref, watch } from 'vue'
import { tap } from '../haptics'
import { executeAction, resolveEntry, visibleEntries, type ActionEntry } from '../plugins/actions'
import { menuCollection, notifyHandlers } from '../plugins/builtins'
import { choiceDialog, confirmDialog, itemMenu, textDialog, type ItemMenuRequest } from '../ui'
import { artistNames, type Item } from '../models'

const item = computed<Item | null>(() => itemMenu.value?.item ?? null)

function close() {
  itemMenu.value = null
}

/** Menu entries come from the item type's action collection (src/plugins/actions.ts). */
const entries = computed(() => {
  const request = itemMenu.value
  if (!request) return []
  const collection = menuCollection(request.item) as ActionEntry<ItemMenuRequest>[]
  return visibleEntries(collection, request).map((entry) => ({ entry, ...resolveEntry(entry, request) }))
})

const subtitle = computed(() => {
  const target = item.value
  if (!target) return ''
  if (target.type === 'song') return artistNames(target.artists)
  if (target.type === 'album') return [target.kind ?? 'Album', artistNames(target.artists)].filter(Boolean).join(' • ')
  if (target.type === 'playlist') return target.subtitle ?? 'Playlist'
  return target.subtitle ?? 'Artist'
})

function run(entry: ActionEntry<ItemMenuRequest>) {
  const request = itemMenu.value
  if (!request) return
  tap()
  close()
  void executeAction(entry.action, request, notifyHandlers())
}

/* Choice dialog */
function choose(value: string) {
  const dialog = choiceDialog.value
  choiceDialog.value = null
  dialog?.onSelect(value)
}

/* Text dialog */
const text = ref('')
const textBusy = ref(false)
watch(textDialog, () => {
  text.value = ''
  textBusy.value = false
})

async function submitText() {
  const dialog = textDialog.value
  if (!dialog || !text.value.trim()) return
  textBusy.value = true
  try {
    await dialog.onConfirm(text.value)
    textDialog.value = null
  } finally {
    textBusy.value = false
  }
}

/* Confirm dialog */
async function confirmAction() {
  const dialog = confirmDialog.value
  confirmDialog.value = null
  await dialog?.onConfirm()
}
</script>

<template>
  <C.BottomSheet :open="item !== null" :label="item ? `Options` : undefined" @close="close">
    <template v-if="item">
      <div class="menu-header">
        <C.Thumb
          :src="item.thumbnail"
          :size="56"
          :shape="item.type === 'artist' ? 'circle' : 'rounded'"
          :icon="item.type === 'artist' ? 'artist' : 'music'"
        />
        <div class="menu-header-text">
          <strong class="type-title-medium">{{ item.type === 'artist' ? item.name : item.title }}</strong>
          <span class="type-body-medium muted">{{ subtitle }}</span>
        </div>
      </div>
      <div class="sheet-scroll">
        <button
          v-for="{ entry, icon, label, filled, disabled } in entries"
          :key="entry.id"
          class="menu-item"
          type="button"
          :disabled="disabled"
          @click="run(entry)"
        >
          <C.MIcon :name="icon" :filled="filled" />
          <span class="type-body-large">{{ label }}</span>
        </button>
      </div>
    </template>
  </C.BottomSheet>

  <C.DialogShell :open="choiceDialog !== null" :title="choiceDialog?.title ?? ''" @close="choiceDialog = null">
    <div class="choice-list" role="radiogroup">
      <button
        v-for="option in choiceDialog?.options ?? []"
        :key="option.value"
        class="choice-option"
        type="button"
        role="radio"
        :aria-checked="option.value === choiceDialog?.value"
        @click="choose(option.value)"
      >
        <span class="radio" aria-hidden="true" />
        <span class="choice-text">
          <span class="type-body-large">{{ option.label }}</span>
          <span v-if="option.description" class="type-body-medium muted">{{ option.description }}</span>
        </span>
      </button>
    </div>
    <template #actions>
      <button class="text-button" type="button" @click="choiceDialog = null">Cancel</button>
    </template>
  </C.DialogShell>

  <C.DialogShell :open="textDialog !== null" :title="textDialog?.title ?? ''" @close="textDialog = null">
    <p v-if="textDialog?.description" class="type-body-medium muted dialog-description">{{ textDialog.description }}</p>
    <textarea
      v-if="textDialog?.multiline"
      v-model="text"
      class="text-field"
      rows="5"
      :placeholder="textDialog?.placeholder"
      spellcheck="false"
      autocomplete="off"
    />
    <input
      v-else
      v-model="text"
      class="text-field"
      :placeholder="textDialog?.placeholder"
      autocomplete="off"
      @keydown.enter="submitText"
    />
    <template #actions>
      <button class="text-button" type="button" @click="textDialog = null">Cancel</button>
      <button class="text-button" type="button" :disabled="!text.trim() || textBusy" @click="submitText">
        {{ textDialog?.confirmLabel ?? 'OK' }}
      </button>
    </template>
  </C.DialogShell>

  <C.DialogShell :open="confirmDialog !== null" :title="confirmDialog?.title ?? ''" @close="confirmDialog = null">
    <p class="type-body-medium muted dialog-description">{{ confirmDialog?.message }}</p>
    <template #actions>
      <button class="text-button" type="button" @click="confirmDialog = null">Cancel</button>
      <button
        class="text-button"
        :class="{ 'is-destructive': confirmDialog?.destructive }"
        type="button"
        @click="confirmAction"
      >
        {{ confirmDialog?.confirmLabel }}
      </button>
    </template>
  </C.DialogShell>
</template>
