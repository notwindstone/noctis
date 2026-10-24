<script setup lang="ts">
import { C } from '../plugins/components'
import type { IconName } from '../icons'

withDefaults(
  defineProps<{
    kind?: 'loading' | 'error' | 'empty'
    icon?: IconName
    title?: string
    message?: string
    action?: string
  }>(),
  { kind: 'empty', icon: 'music', title: '', message: '', action: '' },
)

defineEmits<{ action: [] }>()
</script>

<template>
  <div class="state-view" :class="`state-${kind}`" :role="kind === 'error' ? 'alert' : undefined">
    <span v-if="kind === 'loading'" class="loading-indicator" aria-label="Loading" />
    <span v-else class="state-icon"><C.MIcon :name="kind === 'error' ? 'error' : icon" :size="28" /></span>
    <p v-if="title" class="type-title-medium">{{ title }}</p>
    <p v-if="message" class="type-body-medium muted">{{ message }}</p>
    <button v-if="action" class="tonal-button" type="button" @click="$emit('action')">{{ action }}</button>
  </div>
</template>
