import { computed, shallowReactive } from 'vue'
import { DEFAULT_SOURCE } from '../models'
import { writeLog } from '../plugins/log'
import { persisted } from '../storage'
import type { ServiceDefinition } from './types'

/**
 * Defined services, by id. Each comes from a plugin (YouTube Music's is
 * examples/plugins/youtube-music); the app itself defines none.
 */
export const services = shallowReactive<Record<string, ServiceDefinition>>({})
const owners = new Map<string, string>()

const SERVICE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function defineService(id: string, definition: ServiceDefinition, owner = 'noctis') {
  if (!SERVICE_ID.test(id)) throw new Error(`Invalid service id "${id}" (use lowercase letters, digits, ".", "_" and "-")`)
  if (!definition || typeof definition.name !== 'string') throw new Error(`Service "${id}" needs a name`)
  const previous = owners.get(id)
  if (previous && previous !== owner) {
    writeLog(owner, 'warn', `Replaced service "${id}" (it was defined by ${previous})`)
  }
  owners.set(id, owner)
  services[id] = definition
}

export function removeService(id: string) {
  owners.delete(id)
  delete services[id]
}

/** The service for home, search and the account library (Settings → Content). */
export const activeServiceId = persisted('noctis:service', DEFAULT_SOURCE, (value) => typeof value === 'string')

/** The chosen service, or any defined one if it's gone (e.g. its plugin was disabled). */
export const activeService = computed<{ id: string; service: ServiceDefinition } | null>(() => {
  const chosen = services[activeServiceId.value]
  if (chosen) return { id: activeServiceId.value, service: chosen }
  const id = Object.keys(services)[0]
  return id ? { id, service: services[id] } : null
})

/* ------------------------------------------------------------------ *
 * Startup: screens ask for content before plugins have run
 * ------------------------------------------------------------------ */

let markReady: () => void = () => {}
const ready = new Promise<void>((resolve) => {
  markReady = resolve
})
let isReady = false

/**
 * Resolves once startup plugins ran (or after a few seconds, whatever comes first), so
 * the first calls wait for the services instead of failing.
 */
export function servicesReady(): Promise<void> {
  return isReady ? Promise.resolve() : ready
}

export function areServicesReady(): boolean {
  return isReady
}

export function setServicesReady() {
  isReady = true
  markReady()
}

window.setTimeout(setServicesReady, 8000)
