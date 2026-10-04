import { SEED_ROWS } from './seed'
import { isPatrolMigrated, PATROL_MIGRATED_KEY, PATROL_STORAGE_KEY } from './patrol-store'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 巡护域独立成表后，旧 patrol 表只作迁移来源，不再参与通用列表/概览，避免状态各说一套。
function withoutPatrol(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  if (!isPatrolMigrated()) {
    return data
  }
  const { patrol: _omitted, ...rest } = data
  return rest
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = withoutPatrol(clone(SEED_ROWS))
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...withoutPatrol(parsed) }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

// 跨标签页：任一存储变更（含巡护域事务提交）后丢弃内存缓存，重新进入时口径一致。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === PATROL_STORAGE_KEY || event.key === PATROL_MIGRATED_KEY) {
      cache = null
    }
  })
  window.addEventListener('patrol-domain:changed', () => {
    cache = null
  })
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
