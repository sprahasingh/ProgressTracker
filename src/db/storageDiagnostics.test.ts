import { describe, expect, it } from 'vitest'
import { classifyStorageFailure, findStorageDiagnostic, reportBlockedDatabaseOpen, reportStorageFailure, storageDiagnosticEventName, storageFailureMessage } from './storageDiagnostics'
import { LocalStorageFailure, openDatabase, ProgressTrackerDatabase } from './database'
import { getLastStorageDiagnostic } from './storageDiagnostics'

describe('privacy-safe storage diagnostics', () => {
  it.each([
    [{ name: 'QuotaExceededError', message: 'private record text' }, 'transaction', 'quota'],
    [{ name: 'UpgradeError', inner: { name: 'ConstraintError' } }, 'open', 'version-upgrade'],
    [{ name: 'SecurityError' }, 'open', 'browser-restricted'],
    [{ name: 'ZodError' }, 'transaction', 'record-validation'],
    [{ name: 'AbortError' }, 'transaction', 'transaction'],
    [new Error('operation'), 'open', 'database-open'],
  ] as const)('classifies %s without including exception text', (error, stage, category) => {
    expect(classifyStorageFailure(error, stage)).toBe(category)
    expect(storageFailureMessage(category)).not.toContain('private record text')
  })

  it('emits safe error identity without exception text', () => {
    let detail: unknown
    window.addEventListener(storageDiagnosticEventName(), ((event: CustomEvent) => { detail = event.detail }) as EventListener, { once: true })
    const diagnostic = reportStorageFailure('Today.snapshot.read', 'transaction', new Error('private tracker name'))
    expect(detail).toEqual(diagnostic)
    expect(diagnostic).toMatchObject({ errorName: 'Error', operation: 'Today.snapshot.read', stage: 'transaction' })
    expect(JSON.stringify(diagnostic)).not.toContain('private tracker name')
  })

  it('preserves the first low-level diagnostic when higher layers catch the wrapped failure', () => {
    const lowLevel = reportStorageFailure('ProgressTrackerDatabase.transaction:trackers', 'transaction', Object.assign(new Error('private tracker text'), { name: 'AbortError', code: '23' }))
    const wrapped = new LocalStorageFailure(lowLevel.category, lowLevel.stage, new Error('wrapper text'), lowLevel)
    const higherLevel = reportStorageFailure('AuthProvider.workspace.initialize', 'transaction', wrapped)
    expect(higherLevel).toBe(lowLevel)
    expect(findStorageDiagnostic(wrapped)).toBe(lowLevel)
    expect(higherLevel).toMatchObject({ operation: 'ProgressTrackerDatabase.transaction:trackers', errorName: 'AbortError', errorCode: '23' })
    expect(JSON.stringify(higherLevel)).not.toMatch(/private tracker text|wrapper text/)
  })

  it('does not label an unrelated generic exception as an IndexedDB transaction failure', () => {
    expect(classifyStorageFailure(new Error('private detail'), 'transaction')).toBe('unknown')
  })

  it('reports a blocked open without exposing database or account names', () => {
    const diagnostic = reportBlockedDatabaseOpen()
    expect(diagnostic.category).toBe('blocked-connection')
    expect(diagnostic.operation).toBe('openDatabase')
  })

  it('returns a categorized initial-open failure when IndexedDB is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined })
    try {
      await expect(openDatabase()).rejects.toMatchObject({ name: 'LocalStorageFailure', category: 'browser-restricted', stage: 'initialize' } satisfies Partial<LocalStorageFailure>)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor)
      else Reflect.deleteProperty(globalThis, 'indexedDB')
    }
  })

  it('records transaction failures with table-operation metadata but no error payload', async () => {
    const database = new ProgressTrackerDatabase(`storage-diagnostic-${crypto.randomUUID()}`)
    await database.open()
    try {
      await expect(database.transaction('rw', [database.trackers], () => { throw new Error('private tracker data') })).rejects.toMatchObject({ name: 'Error', message: 'private tracker data' })
      expect(getLastStorageDiagnostic()).toMatchObject({ operation: 'ProgressTrackerDatabase.transaction:trackers', stage: 'transaction', category: 'transaction' })
      expect(getLastStorageDiagnostic()).toMatchObject({ errorName: 'Error' })
      expect(JSON.stringify(getLastStorageDiagnostic())).not.toContain('private tracker data')
    } finally {
      database.close()
      await database.delete()
    }
  })

  it('detects a blocked schema upgrade and continues without resetting the older database', async () => {
    const name = `storage-blocked-upgrade-${crypto.randomUUID()}`
    const legacyRequest = indexedDB.open(name, 1)
    legacyRequest.onupgradeneeded = () => {
      const database = legacyRequest.result
      const addStore = (storeName: string, indexes: string[]) => {
        const store = database.createObjectStore(storeName, { keyPath: 'id' })
        for (const index of indexes) {
          const unique = index.startsWith('&')
          const name = index.replace(/^&/, '')
          const keyPath = name.startsWith('[') ? name.slice(1, -1).split('+') : name
          store.createIndex(name, keyPath, { unique })
        }
      }
      addStore('categories', ['name', 'position', 'archivedAt'])
      addStore('dailyEntries', ['categoryId', 'date', 'status', 'updatedAt', 'deletedAt', '&[categoryId+date]'])
      addStore('goals', ['categoryId', 'status', 'targetDate'])
      addStore('goalMetrics', ['goalId', 'name', 'position'])
      addStore('goalProgressLogs', ['metricId', 'date', 'recordedAt'])
      database.createObjectStore('settings', { keyPath: 'id' })
    }
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      legacyRequest.onsuccess = () => resolve(legacyRequest.result)
      legacyRequest.onerror = () => reject(legacyRequest.error)
    })
    const legacyWrite = legacy.transaction('categories', 'readwrite')
    legacyWrite.objectStore('categories').put({ id: 'preserved-category', name: 'Preserve me', icon: '', description: '', accent: '', schedule: { kind: 'every-day' }, position: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null })
    await new Promise<void>((resolve, reject) => { legacyWrite.oncomplete = () => resolve(); legacyWrite.onerror = () => reject(legacyWrite.error) })
    const upgraded = new ProgressTrackerDatabase(name)
    const blocked = new Promise<void>((resolve) => window.addEventListener(storageDiagnosticEventName(), ((event: CustomEvent) => {
      if (event.detail?.category === 'blocked-connection') resolve()
    }) as EventListener, { once: true }))
    try {
      const opening = upgraded.open()
      await blocked
      expect(getLastStorageDiagnostic()).toMatchObject({ category: 'blocked-connection', stage: 'open' })
      legacy.close()
      await opening
      expect(upgraded.isOpen()).toBe(true)
      await expect(upgraded.categories.get('preserved-category')).resolves.toMatchObject({ name: 'Preserve me' })
    } finally {
      legacy.close()
      upgraded.close()
      await upgraded.delete()
    }
  })
})
