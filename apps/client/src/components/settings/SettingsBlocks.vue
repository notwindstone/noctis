<script setup lang="ts">
import { C } from '../../plugins/components'
import type { SettingsBlock, SettingsRowDef } from '../../plugins/rows'
import { notify } from '../../snackbar'
import { showChoice, showTextDialog } from '../../ui'

/** Renders a settings section described as data (src/plugins/rows.ts). */
defineProps<{ blocks: SettingsBlock[] }>()

function valueOf(row: SettingsRowDef): string | undefined {
  if (row.value !== undefined) return row.value
  if (!row.select) return undefined
  const current = row.select.value
  const label = row.select.options.find((option) => option.value === current)?.label
  return label ?? row.select.custom?.label(current) ?? current
}

const CUSTOM = '\u0000custom'


function activate(row: SettingsRowDef) {
  if (row.disabled) return
  if (row.select) {
    const select = row.select
    const custom = select.custom
    const isCustom = custom !== undefined && !select.options.some((option) => option.value === select.value)
    showChoice({
      title: select.title ?? row.title,
      options: custom
        ? [...select.options, { value: CUSTOM, label: 'Custom…', description: isCustom ? custom.label(select.value) : custom.description }]
        : select.options,
      value: isCustom ? CUSTOM : select.value,
      onSelect: (value) => {
        if (value !== CUSTOM || !custom) return select.set(value)
        showTextDialog({
          title: custom.title ?? select.title ?? row.title,
          description: custom.description,
          placeholder: custom.placeholder,
          confirmLabel: 'Set',
          onConfirm(text) {
            const parsed = custom.parse(text.trim())
            if (parsed === null) notify("That isn't a usable value")
            else select.set(parsed)
          },
        })
      },
    })
    return
  }
  // Switch rows flip through update:modelValue; onClick is for everything else.
  if (!row.toggle) void row.onClick?.()
}
</script>

<template>
  <template v-for="block in blocks" :key="block.id">
    <template v-if="!block.hidden">
      <div v-if="block.type === 'group'" class="settings-group">
        <template v-for="row in block.rows" :key="row.id">
          <component
            :is="C.SettingsRow"
            v-if="!row.hidden"
            :icon="row.icon"
            :title="row.title"
            :description="row.description"
            :value="valueOf(row)"
            :chevron="row.chevron"
            :destructive="row.destructive"
            :disabled="row.disabled"
            :model-value="row.toggle ? row.toggle.value : undefined"
            @update:model-value="(value: boolean) => row.toggle?.set(value)"
            @click="activate(row)"
          />
        </template>
      </div>
      <h2 v-else-if="block.type === 'header'" class="settings-subheader type-title-small">{{ block.title }}</h2>
      <p v-else-if="block.type === 'note'" class="settings-note type-body-small muted">{{ block.text }}</p>
      <component :is="block.component" v-else-if="block.type === 'component'" v-bind="block.props" />
    </template>
  </template>
</template>
