<script setup lang="ts">
import { C } from '../../plugins/components'
import type { SettingsBlock, SettingsRowDef } from '../../plugins/rows'
import { showChoice } from '../../ui'

/** Renders a settings section described as data (src/plugins/rows.ts). */
defineProps<{ blocks: SettingsBlock[] }>()

function valueOf(row: SettingsRowDef): string | undefined {
  if (row.value !== undefined) return row.value
  if (!row.select) return undefined
  const current = row.select.value
  return row.select.options.find((option) => option.value === current)?.label ?? current
}

function activate(row: SettingsRowDef) {
  if (row.disabled) return
  if (row.select) {
    const select = row.select
    showChoice({
      title: select.title ?? row.title,
      options: select.options,
      value: select.value,
      onSelect: (value) => select.set(value),
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
