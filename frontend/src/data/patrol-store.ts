import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'
import type {
  AlertStatus,
  ExecAction,
  ExecRecord,
  FireAlert,
  PatrolDomain,
  PatrolTask,
  TaskStatus,
} from './patrol-types'

/**
 * 巡护域独立存储：任务、执行记录、火情提醒共用一个键、一次写入，
 * 保证「任务与火情提醒同次落库，失败一起退回」。
 */
export const PATROL_STORAGE_KEY = 'forest-fire-patrol:patrol-domain'
/** 已迁入巡护域的旧表标记，local-store 读到后不再把旧 patrol 表喂给通用模块。 */
export const PATROL_MIGRATED_KEY = 'forest-fire-patrol:patrol-migrated'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_OPERATOR = '值班管理员'
let cache: PatrolDomain | null = null

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isDateLike(value: unknown): value is string {
  return typeof value === 'string' && DATE_RE.test(value)
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 巡护域内统一时间戳：本地时区，秒精度，可直接用于排序与展示。 */
export function stampFromDate(date: Date): string {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('-') + ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

function atTime(dateText: string, hour: number, minute = 0): string {
  return `${dateText} ${pad2(hour)}:${pad2(minute)}:00`
}

/** 历史数据补值：巡护时段只有日期时按当日白班 08:00-17:00 处理。 */
function parsePeriod(raw: unknown, patrolDate: string): { period: string; start: string; end: string } {
  const text = typeof raw === 'string' ? raw.trim() : ''
  const match = text.match(/(\d{1,2}):(\d{2})[^0-9]+(\d{1,2}):(\d{2})/)
  if (match) {
    const startH = Number(match[1])
    const startM = Number(match[2])
    const endH = Number(match[3])
    const endM = Number(match[4])
    return {
      period: `${pad2(startH)}:${pad2(startM)}-${pad2(endH)}:${pad2(endM)}`,
      start: atTime(patrolDate, startH, startM),
      end: atTime(patrolDate, endH, endM),
    }
  }
  return { period: '08:00-17:00', start: atTime(patrolDate, 8), end: atTime(patrolDate, 17) }
}

/** 历史数据补值：火情数解析为非负整数，占位文本等脏数据一律补 0。 */
function parseFireCount(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.trunc(raw)
  }
  if (typeof raw === 'string') {
    const match = raw.trim().match(/^\d+/)
    if (match) {
      return Number(match[0])
    }
  }
  return 0
}

function normalizeLegacyStatus(raw: unknown): TaskStatus {
  return raw === '执行中' || raw === '已完成' || raw === '已取消' ? raw : '待执行'
}

/** 从旧的通用 patrol 表（localStorage 里的，没有则退回示例数据）迁移出巡护域。 */
function migrateLegacy(): PatrolDomain {
  let legacy: EntryRow[] | undefined
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem('forest-fire-patrol:entries')
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
        if (Array.isArray(parsed.patrol) && parsed.patrol.length > 0) {
          legacy = parsed.patrol
        }
      } catch {
        // 旧表损坏时退回示例数据，避免一次坏数据让整个巡护域起不来。
        legacy = undefined
      }
    }
  }
  const rows = legacy ?? clone(SEED_ROWS.patrol ?? [])
  const now = stampFromDate(new Date())

  const tasks: PatrolTask[] = []
  const records: ExecRecord[] = []
  const alerts: FireAlert[] = []
  let recordSeq = 0
  let alertSeq = 0

  // 按原编号顺序迁移，执行记录时间也沿用原巡护日期，历史数据不被「搬家」。
  const ordered = [...rows].sort((a, b) => Number(a.id) - Number(b.id))
  for (const row of ordered) {
    const id = Number(row.id)
    const code = String(row['任务编号'] ?? `PATR-${String(id).padStart(4, '0')}`)
    const patrolDate = isDateLike(row['巡护日期'])
      ? row['巡护日期']
      : now.slice(0, 10)
    const { period, start, end } = parsePeriod(row['巡护时段'], patrolDate)
    const status = normalizeLegacyStatus(row.status)
    const ranger = String(row['巡护员'] ?? DEFAULT_OPERATOR)
    const area = String(row['巡护区域'] ?? '未划分区域')
    const route = String(row['巡护路线'] ?? '未登记路线')
    const fireCount = parseFireCount(row['发现火情数'])

    tasks.push({ id, code, area, route, ranger, patrolDate, period, version: 1 })

    const pushRecord = (action: ExecAction, statusAfter: TaskStatus, operatedAt: string, note: string, extra?: Partial<ExecRecord>) => {
      recordSeq += 1
      records.push({
        id: recordSeq,
        taskId: id,
        action,
        statusAfter,
        operatedAt,
        operator: ranger,
        note,
        ...extra,
      })
    }

    pushRecord('登记', '待执行', atTime(patrolDate, 7, 50), '历史任务迁移：按原巡护日期补建登记记录')

    if (status === '执行中') {
      pushRecord('开始巡护', '执行中', start, '历史任务迁移：补建开始巡护记录')
    } else if (status === '已完成') {
      pushRecord('开始巡护', '执行中', start, '历史任务迁移：补建开始巡护记录')
      pushRecord('确认完成', '已完成', end, '历史任务迁移：按执行记录补建完成记录', { fireCount })
      // 历史完成任务按原火情数补齐提醒，使任务表与火情台账从第一天起就对得上。
      for (let index = 1; index <= fireCount; index += 1) {
        alertSeq += 1
        alerts.push({
          id: alertSeq,
          code: `${code}-火${index}`,
          taskId: id,
          location: area,
          foundAt: end,
          level: '一般火情',
          status: '待核实',
          active: true,
          reporter: ranger,
          createdAt: end,
        })
      }
    } else if (status === '已取消') {
      pushRecord('取消任务', '已取消', atTime(patrolDate, 8, 30), '历史任务迁移：补建取消记录')
    }
  }

  return {
    schemaVersion: 1,
    migratedAt: now,
    tasks,
    records,
    alerts,
    taskSeq: tasks.reduce((max, task) => Math.max(max, task.id), 0),
    recordSeq,
    alertSeq,
  }
}

function rawRead(): PatrolDomain | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(PATROL_STORAGE_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as PatrolDomain
  } catch {
    return null
  }
}

/** 取巡护域：首次访问时一次性迁移旧表并落库；之后以存储里的数据为准（跨标签页也一致）。 */
export function loadDomain(): PatrolDomain {
  if (cache) {
    return cache
  }
  let domain = rawRead()
  if (!domain) {
    domain = migrateLegacy()
    persist(domain)
  }
  cache = domain
  return domain
}

function persist(domain: PatrolDomain): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(PATROL_STORAGE_KEY, JSON.stringify(domain))
    // 通知同页其他存储（通用表缓存）与已打开的视图：数据已换版本。
    window.localStorage.setItem(PATROL_MIGRATED_KEY, stampFromDate(new Date()))
    window.dispatchEvent(new CustomEvent('patrol-domain:changed'))
  }
}

/**
 * 事务入口：先重读持久化数据（防止另一标签页已先提交），再在副本上执行改动。
 * mutate 抛错则整体退回，绝不落库；正常返回时一次写入三张表。
 */
export function mutateDomain<T>(mutate: (domain: PatrolDomain) => T): T {
  const persisted = rawRead() ?? loadDomain()
  const draft = clone(persisted)
  const result = mutate(draft)
  cache = draft
  persist(draft)
  return result
}

/** 跨标签页写入后丢弃内存缓存，刷新/重新进入都以最新落库数据为准。 */
export function invalidateDomainCache(): void {
  cache = null
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === PATROL_STORAGE_KEY) {
      cache = null
    }
  })
}

/** 兼容层：通用表首次读取时若巡护已迁移，旧 patrol 表不再透出，避免两边各说一套。 */
export function isPatrolMigrated(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) {
    return true
  }
  return Boolean(window.localStorage.getItem(PATROL_STORAGE_KEY)
    || window.localStorage.getItem(PATROL_MIGRATED_KEY))
}

export type { AlertStatus }
