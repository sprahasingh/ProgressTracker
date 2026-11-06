export type StorageFailureCategory = 'database-open' | 'version-upgrade' | 'blocked-connection' | 'transaction' | 'quota' | 'record-validation' | 'browser-restricted' | 'unknown'
export type StorageFailureStage = 'initialize' | 'open' | 'upgrade' | 'transaction' | 'deserialize' | 'validate'
export type StorageDiagnostic = {
  operation: string
  stage: StorageFailureStage
  category: StorageFailureCategory
  browser: string
  occurredAt: string
  errorName?: string
  errorCode?: number | string
}

const diagnosticEvent = 'progress-tracker:storage-diagnostic'
let lastDiagnostic: StorageDiagnostic | null = null

function errorChain(error: unknown): Array<{ name: string; code?: number | string; category?: unknown; diagnostic?: StorageDiagnostic }> {
  const chain: Array<{ name: string; code?: number | string; category?: unknown }> = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const item = current as { name?: unknown; code?: unknown; category?: unknown; diagnostic?: unknown; cause?: unknown; inner?: unknown }
    chain.push({
      name: typeof item.name === 'string' ? item.name : '',
      ...(typeof item.code === 'number' || typeof item.code === 'string' ? { code: item.code } : {}),
      ...(item.category ? { category: item.category } : {}),
      ...(isStorageDiagnostic(item.diagnostic) ? { diagnostic: item.diagnostic } : {}),
    })
    current = item.cause ?? item.inner
  }
  return chain
}

function isStorageDiagnostic(value: unknown): value is StorageDiagnostic {
  if (!value || typeof value !== 'object') return false
  const diagnostic = value as Partial<StorageDiagnostic>
  return typeof diagnostic.operation === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,100}$/.test(diagnostic.operation)
    && ['initialize', 'open', 'upgrade', 'transaction', 'deserialize', 'validate'].includes(String(diagnostic.stage))
    && ['database-open', 'version-upgrade', 'blocked-connection', 'transaction', 'quota', 'record-validation', 'browser-restricted', 'unknown'].includes(String(diagnostic.category))
    && ['firefox', 'edge', 'chromium', 'safari', 'other', 'unknown'].includes(String(diagnostic.browser))
    && typeof diagnostic.occurredAt === 'string' && !Number.isNaN(Date.parse(diagnostic.occurredAt))
    && (diagnostic.errorName === undefined || (typeof diagnostic.errorName === 'string' && safeErrorName(diagnostic.errorName) === diagnostic.errorName))
    && (diagnostic.errorCode === undefined || safeErrorCode(diagnostic.errorCode) === diagnostic.errorCode)
}

function safeErrorName(value: string): string | undefined {
  const known = new Set(['Error', 'TypeError', 'RangeError', 'AbortError', 'ConstraintError', 'DataError', 'QuotaExceededError', 'UpgradeError', 'VersionError', 'VersionchangeError', 'SecurityError', 'NotAllowedError', 'NotSupportedError', 'InvalidStateError', 'ValidationError', 'ZodError', 'UnknownError', 'TimeoutError', 'NotFoundError', 'TransactionInactiveError', 'ReadOnlyError', 'DataCloneError', 'LocalStorageFailure'])
  return known.has(value) ? value : undefined
}

function safeErrorCode(value: number | string | undefined): number | string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && (/^\d{1,5}$/.test(value) || /^[0-9A-Z]{5}$/.test(value) || /^ERR_[A-Z0-9_]{1,18}$/.test(value))) return value
  return undefined
}

export function findStorageDiagnostic(error: unknown): StorageDiagnostic | null {
  return errorChain(error).find((item) => item.diagnostic)?.diagnostic ?? null
}

function browserEnvironment(): string {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Edg\//.test(ua)) return 'edge'
  if (/Chrome\//.test(ua)) return 'chromium'
  if (/Safari\//.test(ua)) return 'safari'
  return 'other'
}

export function classifyStorageFailure(error: unknown, stage: StorageFailureStage): StorageFailureCategory {
  const chain = errorChain(error)
  const names = chain.map((item) => item.name)
  const wrappedCategory = chain.find((item) => item.name === 'LocalStorageFailure')?.category
  if (typeof wrappedCategory === 'string' && ['database-open', 'version-upgrade', 'blocked-connection', 'transaction', 'quota', 'record-validation', 'browser-restricted', 'unknown'].includes(wrappedCategory)) return wrappedCategory as StorageFailureCategory
  if (names.includes('QuotaExceededError') || chain.some((item) => item.code === 22 || item.code === 1014)) return 'quota'
  if (names.some((name) => /UpgradeError|VersionError|VersionchangeError/.test(name)) || stage === 'upgrade') return 'version-upgrade'
  if (names.includes('SecurityError') || names.includes('NotAllowedError') || names.includes('NotSupportedError') || names.includes('InvalidStateError')) return 'browser-restricted'
  if (names.some((name) => /ValidationError|ZodError/.test(name)) || stage === 'validate' || stage === 'deserialize') return 'record-validation'
  if (names.some((name) => /Transaction|AbortError|ConstraintError|DataError/.test(name))) return 'transaction'
  if (stage === 'open' || stage === 'initialize') return 'database-open'
  return 'unknown'
}

export function reportStorageFailure(operation: string, stage: StorageFailureStage, error: unknown, knownCategory?: StorageFailureCategory): StorageDiagnostic {
  const existing = findStorageDiagnostic(error)
  if (existing) return existing
  const chain = errorChain(error)
  const original = chain[0]
  const diagnostic: StorageDiagnostic = {
    operation,
    stage,
    category: knownCategory ?? classifyStorageFailure(error, stage),
    browser: browserEnvironment(),
    occurredAt: new Date().toISOString(),
    ...(original?.name && safeErrorName(original.name) ? { errorName: safeErrorName(original.name) } : {}),
    ...(safeErrorCode(original?.code) !== undefined ? { errorCode: safeErrorCode(original?.code) } : {}),
  }
  lastDiagnostic = diagnostic
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(diagnosticEvent, { detail: diagnostic }))
  return diagnostic
}

export function reportBlockedDatabaseOpen(operation = 'openDatabase'): StorageDiagnostic {
  const diagnostic: StorageDiagnostic = {
    operation,
    stage: 'open',
    category: 'blocked-connection',
    browser: browserEnvironment(),
    occurredAt: new Date().toISOString(),
  }
  lastDiagnostic = diagnostic
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(diagnosticEvent, { detail: diagnostic }))
  return diagnostic
}

export function getLastStorageDiagnostic(): StorageDiagnostic | null { return lastDiagnostic }
export function storageDiagnosticEventName(): string { return diagnosticEvent }

export function storageFailureMessage(category: StorageFailureCategory): string {
  switch (category) {
    case 'database-open': return 'The local database could not be opened.'
    case 'version-upgrade': return 'The local database could not be upgraded. Existing data was left in place.'
    case 'blocked-connection': return 'Another open ProgressTracker tab is blocking the database upgrade. Close other app tabs, then retry.'
    case 'transaction': return 'A local database operation failed. Existing records were not reset.'
    case 'quota': return 'The browser reports that local storage is full. Existing records were not cleared.'
    case 'record-validation': return 'A saved record could not be interpreted. It was not changed.'
    case 'browser-restricted': return 'This browser context is restricting local storage. Existing records were not cleared.'
    default: return 'The workspace could not be loaded. The underlying failure is not yet identified.'
  }
}
