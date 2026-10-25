/**
 * A tiny key/value store in IndexedDB: the local library's index, artwork and (in the
 * browser) folder handles, which don't fit in localStorage.
 */

const DB = 'noctis-local'
const STORE = 'kv'

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return opening
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const request = work(db.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export const idbGet = <T>(key: string) => run<T | undefined>('readonly', (store) => store.get(key))
export const idbSet = (key: string, value: unknown) => run('readwrite', (store) => store.put(value, key))
export const idbDelete = (key: string) => run('readwrite', (store) => store.delete(key))
