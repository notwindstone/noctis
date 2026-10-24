<script setup lang="ts">
import { ref } from 'vue'
import { notify } from '../../snackbar'
import MIcon from '../../components/MIcon.vue'
import Thumb from '../../components/Thumb.vue'
import { account, canSignInNatively, signedIn, signInWithGoogle } from './client'

const signingIn = ref(false)

async function googleSignIn() {
  signingIn.value = true
  try {
    const ok = await signInWithGoogle()
    notify(ok ? `Signed in${account.value ? ` as ${account.value.name}` : ''}` : 'Sign-in did not complete.')
  } catch {
    /* cancelled */
  } finally {
    signingIn.value = false
  }
}
</script>

<template>
  <div v-if="signedIn" class="account-hero">
    <Thumb :src="account?.photo" :size="88" shape="circle" icon="account" />
    <strong class="type-title-large">{{ account?.name ?? 'Signed in' }}</strong>
    <span v-if="account?.handle" class="type-body-medium muted">{{ account.handle }}</span>
  </div>
  <div v-else class="account-hero">
    <span class="account-card-icon large"><MIcon name="account" :size="48" /></span>
    <strong class="type-title-large">Not signed in</strong>
    <span class="type-body-medium muted account-hero-note">
      Sign in to bring your YouTube Music library, liked songs and personal mixes. Without an account, Noctis still
      works: likes, history and downloads stay on this device.
    </span>
    <button v-if="canSignInNatively" class="filled-button large" type="button" :disabled="signingIn" @click="googleSignIn">
      <MIcon name="login" />
      Sign in with Google
    </button>
    <p v-else class="type-body-small muted account-hero-note">
      Google sign-in opens a native window and is available in the Android app. In the browser preview, use a cookie instead.
    </p>
  </div>
</template>
