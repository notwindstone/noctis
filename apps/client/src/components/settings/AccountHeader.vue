<script setup lang="ts">
import { computed } from 'vue'
import { accountEntries } from '../../accounts'
import { C } from '../../plugins/components'

/** One account on Settings → Accounts: its picture, who's signed in, and where. */
const props = defineProps<{ entryId: string }>()

const entry = computed(() => accountEntries.value.find(([id]) => id === props.entryId)?.[1] ?? null)
const account = computed(() => entry.value?.account ?? null)
const info = computed(() => (account.value?.signedIn ? account.value.info : null))
</script>

<template>
  <div v-if="entry" class="account-header">
    <C.Thumb v-if="info?.photo" :src="info.photo" :size="48" shape="circle" icon="account" />
    <span v-else class="account-card-icon"><C.MIcon :name="(entry.icon as never) ?? 'account'" :size="28" /></span>
    <span class="account-card-text">
      <strong class="type-title-medium">{{ entry.name }}</strong>
      <span class="type-body-medium muted">
        {{ account?.signedIn ? `Signed in${info?.name ? ` as ${info.name}` : ''}${info?.handle ? ` · ${info.handle}` : ''}` : (account?.signInDescription ?? 'Not signed in') }}
      </span>
    </span>
  </div>
</template>
