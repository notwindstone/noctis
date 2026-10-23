<script setup lang="ts">
import { haptic } from '../haptics'
import type { IconName } from '../icons'
import MIcon from './MIcon.vue'

/**
 * A Material list item for settings. With `modelValue` it renders a trailing switch;
 * otherwise it's a plain row (optionally with a chevron when it opens a screen).
 */
const props = withDefaults(
  defineProps<{
    icon?: IconName
    title: string
    description?: string
    value?: string
    chevron?: boolean
    modelValue?: boolean
    disabled?: boolean
    destructive?: boolean
  }>(),
  { icon: undefined, description: '', value: '', chevron: false, modelValue: undefined, disabled: false, destructive: false },
)

const emit = defineEmits<{ click: []; 'update:modelValue': [value: boolean] }>()

function activate() {
  if (props.disabled) return
  if (props.modelValue !== undefined) {
    haptic(props.modelValue ? 'toggleOff' : 'toggleOn')
    emit('update:modelValue', !props.modelValue)
  } else {
    haptic('tap')
  }
  emit('click')
}
</script>

<template>
  <button
    class="settings-row"
    :class="{ 'is-destructive': destructive }"
    type="button"
    :disabled="disabled"
    :role="modelValue !== undefined ? 'switch' : undefined"
    :aria-checked="modelValue !== undefined ? modelValue : undefined"
    @click="activate"
  >
    <span v-if="icon" class="settings-row-icon"><MIcon :name="icon" /></span>
    <span class="settings-row-text">
      <span class="type-body-large">{{ title }}</span>
      <span v-if="description || value" class="type-body-medium muted">{{ value || description }}</span>
    </span>
    <span v-if="modelValue !== undefined" class="switch" :class="{ 'is-on': modelValue }" aria-hidden="true">
      <span><MIcon v-if="modelValue" name="check" :size="16" /></span>
    </span>
    <MIcon v-else-if="chevron" class="settings-row-chevron" name="chevron-right" />
  </button>
</template>
