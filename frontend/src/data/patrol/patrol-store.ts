import { SEED_ROWS } from '@/data/seed'
import type { EntryRow } from '@/data/types'

import type {
  ExecutionEventType,
  PatrolStatus,
  PatrolStoreData,
  PatrolTask,
} from './types'

/**
 * 巡护领域独立存储：任务、执行记录、火情提醒放在同一份数据里，
 * 每次业务写入整体提交到 localStorage（天然原子，失败则不替换内存数据，一起退回）。
 */
const STORAGE_KEY = 'forest-fire-patrol:patrol'
const LEGACY_KEY = 'forest-fire-patrol:entries'
const SCHEMA_VERSION = 1

function dayStart(value: string): number {
  // 历史任务按「原巡护日期」补齐执行时间；解析不出来就用播种时间兜底。
  const parsed = new Date(`${value}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? new Date('2026-09-01T00:00:00').getTime() : parsed.getTime()
}

function clampStatus(raw: string): PatrolStatus {
  return raw === '执行中' || raw === '已完成' || raw === '已取消' ? raw : '待执行'
}

/** 班组名由巡护员补齐：历史数据没有班组，按巡护员归并成「XX 班组」。 */
function crewOf(row: EntryRow): string {
  const patroller = String(row['巡护员'] ?? '').trim()
  return patroller ? `${patroller.replace(/巡护任务样例\d*/, '').trim() || patroller}班组` : '未分班班组'
}

/**
 * 从旧的通用巡护数据迁移：严格按执行记录重建状态（冲突时以执行记录为准）。
 * 每个历史任务按「原巡护日期」补一条或多条执行记录，保证刷新、重进后状态一致。
 */
function migrateLegacyRows(rows: EntryRow[]): PatrolStoreData {
  const data: PatrolStoreData = {
    schemaVersion: SCHEMA_VERSION,
    tasks: [],
    executions: [],
    alerts: [],
    seq: { task: 0, execution: 0, alert: 0 },
  }

  for (const row of rows) {
    data.seq.task += 1
    const taskId = data.seq.task
    const date = String(row['巡护日期'] ?? '2026-09-01')
    const base = dayStart(date)
    const status = clampStatus(String(row.status))
    const task: PatrolTask = {
      id: taskId,
      // version 由追加的执行记录数量决定，最后统一回填。
      version: 0,
      任务编号: String(row['任务编号'] ?? `PATR-${String(taskId).padStart(4, '0')}`),
      巡护区域: String(row['巡护区域'] ?? ''),
      巡护路线: String(row['巡护路线'] ?? ''),
      巡护员: String(row['巡护员'] ?? ''),
      班组: crewOf(row),
      巡护日期: date,
      巡护时段: String(row['巡护时段'] ?? ''),
      createdAt: base,
    }
    data.tasks.push(task)

    const append = (type: ExecutionEventType, at: number, note?: string) => {
      data.seq.execution += 1
      const version = data.seq.execution // 占位，下面按任务覆盖
      data.executions.push({
        id: data.seq.execution,
        taskId,
        type,
        at,
        operator: '系统迁移',
        version,
        note,
      })
    }

    // 按原巡护日期补执行链：旧状态终态是什么，就补到哪一步。
    if (status === '执行中' || status === '已完成') {
      append('START', base, '历史任务按原巡护日期迁移')
    }
    if (status === '已完成') {
      append('COMPLETE', base + 60 * 60 * 1000, '历史任务按原巡护日期迁移')
    }
    if (status === '已取消') {
      append('CANCEL', base, '历史任务按原巡护日期迁移')
    }
  }

  // 回填每个任务的 version（该任务执行记录的序号从 1 递增）。
  const perTask = new Map<number, number>()
  for (const execution of data.executions) {
    const v = (perTask.get(execution.taskId) ?? 0) + 1
    perTask.set(execution.taskId, v)
    execution.version = v
  }
  for (const task of data.tasks) {
    task.version = perTask.get(task.id) ?? 0
  }
  return data
}

function seedData(): PatrolStoreData {
  return migrateLegacyRows(SEED_ROWS.patrol ?? [])
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): PatrolStoreData {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedData()
  }

  // 1) 已经有新版巡护数据：直接读取。
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PatrolStoreData
      if (parsed && Array.isArray(parsed.tasks) && Array.isArray(parsed.executions)) {
        return normalize(parsed)
      }
    } catch {
      // 数据损坏，落到迁移分支重建。
    }
  }

  // 2) 首次升级：把旧通用存储里的巡护任务按原巡护日期迁移成执行记录。
  const legacyRaw = window.localStorage.getItem(LEGACY_KEY)
  if (legacyRaw) {
    try {
      const legacy = JSON.parse(legacyRaw) as Record<string, EntryRow[]>
      if (Array.isArray(legacy.patrol)) {
        const migrated = migrateLegacyRows(legacy.patrol)
        commit(migrated)
        return migrated
      }
    } catch {
      // 旧数据解析失败则回落到种子数据。
    }
  }

  const seeded = seedData()
  commit(seeded)
  return seeded
}

/** 补齐字段，防止历史脏数据导致运行时报错。 */
function normalize(data: PatrolStoreData): PatrolStoreData {
  const base: PatrolStoreData = {
    schemaVersion: SCHEMA_VERSION,
    tasks: [],
    executions: [],
    alerts: [],
    seq: { task: 0, execution: 0, alert: 0 },
  }
  const merged = { ...base, ...data, seq: { ...base.seq, ...(data.seq ?? {}) } }
  merged.tasks = merged.tasks.map((task) => ({ ...task, version: task.version ?? 0 }))
  merged.alerts = merged.alerts ?? []
  return merged
}

let cache: PatrolStoreData | null = null

export function getPatrolStore(): PatrolStoreData {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

/**
 * 唯一写入入口：一次性写入整份领域数据。
 * 业务层先在内存草稿上完成「任务版本 + 执行记录 + 火情提醒」的全部改动，
 * 再调用 commit；localStorage 写入抛错时不替换 cache，实现失败一起退回。
 */
export function commit(next: PatrolStoreData): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    // 先写持久层，成功后再切换内存；抛错则不会执行到下一行，旧 cache 保持不变（一起退回）。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  cache = next
}

/** 深拷贝当前数据，业务在草稿上做原子修改，成功后 commit。 */
export function draftPatrolStore(): PatrolStoreData {
  return clone(getPatrolStore())
}

/** 重置回种子数据（页面上的「重置示例数据」入口用）。 */
export function resetPatrolStore(): PatrolStoreData {
  const seeded = seedData()
  commit(seeded)
  return seeded
}

export function patrolStorageKey(): string {
  return STORAGE_KEY
}
