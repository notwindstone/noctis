<script setup lang="ts">
import { C } from '../plugins/components'
import { computed, nextTick, ref, watch } from 'vue'
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
  return visibleEntries(collection, request).map((entry, index, shown) => ({
    entry,
    ...resolveEntry(entry, request),
    // A divider where the group changes (plugins' entries, with none, get their own section).
    divider: index > 0 && entry.group !== shown[index - 1].group,
  }))
})

/** Opened with a mouse: a menu at the pointer instead of the bottom sheet. */
const at = computed(() => itemMenu.value?.at ?? null)

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
/** One of the options is the current value: a setting, with radio buttons. Otherwise a list of actions. */
const choiceIsSetting = computed(() => choiceDialog.value?.options.some((option) => option.value === choiceDialog.value?.value) ?? false)

function choose(value: string) {
  const dialog = choiceDialog.value
  choiceDialog.value = null
  dialog?.onSelect(value)
}

/* Text dialog */
const text = ref('')
const textBusy = ref(false)
const textField = ref<HTMLInputElement | HTMLTextAreaElement | null>(null)
watch(textDialog, async (dialog) => {
  text.value = dialog?.initial ?? ''
  textBusy.value = false
  if (!dialog) return
  // Ready to type, keyboard up, without tapping the field first; a name being edited is selected.
  await nextTick()
  textField.value?.focus()
  if (dialog.initial) textField.value?.select()
})

async function submitText() {
  const dialog = textDialog.value
  if (!dialog || !text.value.trim()) return
  textBusy.value = true
  try {
    await dialog.onConfirm(text.value)
    // Close only this dialog: onConfirm may have opened the next one (sign-in asks for
    // the username, then the password).
    if (textDialog.value === dialog) textDialog.value = null
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
  <C.ContextMenu :open="item !== null && at !== null" :at="at" :label="item ? `Options for ${item.type === 'artist' ? item.name : item.title}` : undefined" @close="close">
    <template v-if="item">
      <template v-for="{ entry, icon, label, filled, disabled, divider } in entries" :key="entry.id">
        <hr v-if="divider" class="context-menu-divider" />
        <button class="context-menu-item" type="button" role="menuitem" :disabled="disabled" @click="run(entry)">
          <C.MIcon :name="icon" :filled="filled" :size="20" />
          <span>{{ label }}</span>
        </button>
      </template>
    </template>
  </C.ContextMenu>

  <C.BottomSheet :open="item !== null && at === null" :label="item ? `Options` : undefined" @close="close">
    <template v-if="item">
      <div class="menu-header">
        <!-- Eager: a lazy image in a sheet that's still sliding in waited until well after it settled. -->
        <C.Thumb
          :src="item.thumbnail"
          :size="56"
          :shape="item.type === 'artist' ? 'circle' : 'rounded'"
          :icon="item.type === 'artist' ? 'artist' : item.type === 'album' ? 'album' : item.type === 'playlist' ? 'playlist' : 'music'"
          eager
        />
        <div class="menu-header-text">
          <strong class="type-title-medium">{{ item.type === 'artist' ? item.name : item.title }}</strong>
          <span class="type-body-medium muted">{{ subtitle }}</span>
        </div>
      </div>
      <div class="sheet-scroll">
        <template v-for="{ entry, icon, label, filled, disabled, divider } in entries" :key="entry.id">
          <hr v-if="divider" class="menu-divider" />
          <button class="menu-item" type="button" :disabled="disabled" @click="run(entry)">
            <C.MIcon :name="icon" :filled="filled" />
            <span class="type-body-large">{{ label }}</span>
          </button>
        </template>
      </div>
    </template>
  </C.BottomSheet>

  <C.DialogShell :open="choiceDialog !== null" :title="choiceDialog?.title ?? ''" @close="choiceDialog = null">
    <div class="choice-list" :role="choiceIsSetting ? 'radiogroup' : 'menu'">
      <button
        v-for="option in choiceDialog?.options ?? []"
        :key="option.value"
        class="choice-option"
        type="button"
        :role="choiceIsSetting ? 'radio' : 'menuitem'"
        :aria-checked="choiceIsSetting ? option.value === choiceDialog?.value : undefined"
        @click="choose(option.value)"
      >
        <span v-if="choiceIsSetting" class="radio" aria-hidden="true" />
        <C.MIcon v-else-if="option.icon" class="choice-icon" :name="option.icon" />
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

  <C.PlayFromDialog />

  <C.DialogShell :open="textDialog !== null" :title="textDialog?.title ?? ''" @close="textDialog = null">
    <p v-if="textDialog?.description" class="type-body-medium muted dialog-description">{{ textDialog.description }}</p>
    <textarea
      v-if="textDialog?.multiline"
      ref="textField"
      v-model="text"
      class="text-field"
      rows="5"
      :placeholder="textDialog?.placeholder"
      spellcheck="false"
      autocomplete="off"
    />
    <input
      v-else
      :key="textDialog?.title"
      ref="textField"
      v-model="text"
      class="text-field"
      :type="textDialog?.password ? 'password' : 'text'"
      :placeholder="textDialog?.placeholder"
      :autocomplete="textDialog?.password ? 'current-password' : 'off'"
      :autocapitalize="textDialog?.capitalize ? 'sentences' : 'off'"
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
