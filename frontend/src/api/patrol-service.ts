import { listRows } from '../data/local-store'
import {
  loadDomain,
  mutateDomain,
  stampFromDate,
} from '../data/patrol-store'
import type { ActionResult, EntryRow } from '../data/types'
import type {
  ExecAction,
  ExecRecord,
  FireAlert,
  FireLedgerRow,
  PatrolDomain,
  TaskStatus,
  TaskView,
} from '../data/patrol-types'

const DEFAULT_OPERATOR = '值班管理员'

export type PatrolAction = '开始巡护' | '确认完成' | '取消任务'

/**
 * 单向状态机：只允许沿 待执行 -> 执行中 -> 已完成 推进；
 * 取消仅在 待执行 时允许，已取消是终态。任何回退/跳跃（含取消后确认完成）一律拒绝。
 */
const ALLOWED_TRANSITIONS: Record<PatrolAction, Partial<Record<TaskStatus, TaskStatus>>> = {
  开始巡护: { 待执行: '执行中' },
  确认完成: { 执行中: '已完成' },
  取消任务: { 待执行: '已取消' },
}

const ACTIVE_ALERT_STATUSES = new Set(['待核实', '已确认', '已出警', '已扑灭'])

function latestRecord(domain: PatrolDomain, taskId: number): ExecRecord | undefined {
  let latest: ExecRecord | undefined
  for (const record of domain.records) {
    if (record.taskId === taskId && (!latest || record.operatedAt >= latest.operatedAt || record.id > latest.id)) {
      latest = record
    }
  }
  return latest
}

/** 冲突时以执行记录为准：任务状态只从最新执行记录推导。 */
export function statusOf(domain: PatrolDomain, taskId: number): TaskStatus {
  return latestRecord(domain, taskId)?.statusAfter ?? '待执行'
}

export function fireCountOf(domain: PatrolDomain, taskId: number): number {
  return domain.alerts.filter((alert) => alert.taskId === taskId && alert.active).length
}

function toView(domain: PatrolDomain, taskId: number): TaskView {
  const task = domain.tasks.find((item) => item.id === taskId)
  if (!task) {
    throw new Error(`没有找到编号为 ${taskId} 的巡护任务`)
  }
  const status = statusOf(domain, taskId)
  const records = domain.records
    .filter((record) => record.taskId === taskId)
    .sort((a, b) => (a.operatedAt === b.operatedAt ? a.id - b.id : a.operatedAt < b.operatedAt ? -1 : 1))
  const alerts = domain.alerts
    .filter((alert) => alert.taskId === taskId)
    .sort((a, b) => (a.foundAt === b.foundAt ? a.id - b.id : a.foundAt < b.foundAt ? -1 : 1))
  return {
    ...task,
    status,
    fireCount: alerts.filter((alert) => alert.active).length,
    pending: status === '待执行' || status === '执行中',
    abnormal: status === '已取消',
    records,
    alerts,
  }
}

export interface TaskQuery {
  keyword?: string
  status?: string
}

export function listTasks(query: TaskQuery = {}): TaskView[] {
  const domain = loadDomain()
  const keyword = query.keyword?.trim() ?? ''
  const views = domain.tasks
    .map((task) => toView(domain, task.id))
    .sort((a, b) => (a.patrolDate === b.patrolDate ? a.id - b.id : a.patrolDate < b.patrolDate ? 1 : -1))
  return views.filter((view) => {
    if (query.status && view.status !== query.status) {
      return false
    }
    if (keyword) {
      const haystack = [view.code, view.area, view.route, view.ranger].join(' ')
      if (!haystack.includes(keyword)) {
        return false
      }
    }
    return true
  })
}

export function getTask(taskId: number): TaskView {
  const domain = loadDomain()
  return toView(domain, taskId)
}

/** 该状态下页面允许出现的动作，杜绝「取消后仍能确认完成」之类的入口。 */
export function availableActions(status: TaskStatus): PatrolAction[] {
  if (status === '待执行') {
    return ['开始巡护', '取消任务']
  }
  if (status === '执行中') {
    return ['确认完成']
  }
  return []
}

class ConflictError extends Error {}

function findTaskOrThrow(domain: PatrolDomain, taskId: number) {
  const task = domain.tasks.find((item) => item.id === taskId)
  if (!task) {
    throw new Error(`没有找到编号为 ${taskId} 的巡护任务`)
  }
  return task
}

function appendRecord(
  domain: PatrolDomain,
  taskId: number,
  action: ExecAction,
  statusAfter: TaskStatus,
  note: string,
  operator: string,
  extra?: Partial<ExecRecord>,
): void {
  domain.recordSeq += 1
  domain.records.push({
    id: domain.recordSeq,
    taskId,
    action,
    statusAfter,
    operatedAt: stampFromDate(new Date()),
    operator,
    note,
    ...extra,
  })
}

/**
 * 巡护动作提交：
 * - expectedVersion 与落库版本不一致 -> 拒绝第二次写入（两端并发 / 重复提交）；
 * - 状态机不允许 -> 拒绝；
 * - 「确认完成」时火情提醒与任务状态同事务生成，任何一步失败整体退回。
 */
export function submitTaskAction(input: {
  taskId: number
  action: PatrolAction
  expectedVersion: number
  fireCount?: number
  operator?: string
}): ActionResult & { task?: TaskView } {
  const { taskId, action, expectedVersion } = input
  try {
    const view = mutateDomain((domain) => {
      const task = findTaskOrThrow(domain, taskId)
      if (task.version !== expectedVersion) {
        throw new ConflictError('任务已被另一端提交，请刷新后按最新状态操作')
      }
      const current = statusOf(domain, taskId)
      const target = ALLOWED_TRANSITIONS[action][current]
      if (!target) {
        throw new Error(`巡护任务当前为「${current}」，不能执行「${action}」，状态只能由待执行、执行中向已完成单向推进`)
      }

      const operator = input.operator ?? DEFAULT_OPERATOR
      if (action === '确认完成') {
        const fireCount = input.fireCount
        if (typeof fireCount !== 'number' || !Number.isInteger(fireCount) || fireCount < 0) {
          throw new Error('发现火情数必须是不小于 0 的整数')
        }
        // 先在事务里把提醒全部建好；构造过程出错（数量非法等）会直接中断、任务也不落完成态。
        for (let index = 1; index <= fireCount; index += 1) {
          domain.alertSeq += 1
          const now = stampFromDate(new Date())
          const alert: FireAlert = {
            id: domain.alertSeq,
            code: `${task.code}-火${domain.alerts.filter((item) => item.taskId === task.id).length + index}`,
            taskId: task.id,
            location: task.area,
            foundAt: now,
            level: '一般火情',
            status: '待核实',
            active: true,
            reporter: task.ranger,
            createdAt: now,
          }
          domain.alerts.push(alert)
        }
        appendRecord(domain, task.id, action, target, `巡护完成，录入发现火情 ${fireCount} 起`, operator, { fireCount })
      } else {
        const note = action === '开始巡护' ? '班组开始巡护' : '任务在待执行阶段取消'
        appendRecord(domain, task.id, action, target, note, operator)
      }

      task.version += 1
      return toView(domain, task.id)
    })
    return { ok: true, message: `巡护任务已${action}，当前状态「${view.status}」`, task: view }
  } catch (error) {
    if (error instanceof ConflictError) {
      return { ok: false, message: error.message }
    }
    return { ok: false, message: error instanceof Error ? error.message : '巡护任务提交失败，已全部退回' }
  }
}

/**
 * 撤回火情提醒：提醒置终态「已撤回」并退出火情数回写，
 * 同时在同一事务里为任务补一条「火情撤回」执行记录并自增版本；
 * 任务状态（执行中/已完成）不变，不会有状态残留。
 */
export function withdrawFireAlert(input: {
  alertId: number
  expectedTaskVersion: number
  note?: string
  operator?: string
}): ActionResult {
  try {
    mutateDomain((domain) => {
      const alert = domain.alerts.find((item) => item.id === input.alertId)
      if (!alert) {
        throw new Error('没有找到对应的火情提醒')
      }
      if (!alert.active) {
        throw new Error(`火情提醒已是「${alert.status}」，不能重复撤回`)
      }
      const task = findTaskOrThrow(domain, alert.taskId)
      if (task.version !== input.expectedTaskVersion) {
        throw new ConflictError('任务已被另一端提交，请刷新后再撤回')
      }
      alert.status = '已撤回'
      alert.active = false
      alert.withdrawnAt = stampFromDate(new Date())
      alert.withdrawNote = input.note?.trim() || '现场复核后撤回该火情提醒'
      appendRecord(
        domain,
        task.id,
        '火情撤回',
        statusOf(domain, task.id),
        `${alert.code} 撤回：${alert.withdrawNote}`,
        input.operator ?? DEFAULT_OPERATOR,
      )
      task.version += 1
    })
    return { ok: true, message: '火情提醒已撤回，任务火情数已核减' }
  } catch (error) {
    if (error instanceof ConflictError) {
      return { ok: false, message: error.message }
    }
    return { ok: false, message: error instanceof Error ? error.message : '火情提醒撤回失败，已全部退回' }
  }
}

/** 任务台账：巡护火情提醒 + 人工火情报告并表，撤回的提醒保留可见但不参与统计。 */
export function listFireLedger(): FireLedgerRow[] {
  const domain = loadDomain()
  const rows: FireLedgerRow[] = domain.alerts
    .slice()
    .sort((a, b) => (a.foundAt === b.foundAt ? a.id - b.id : a.foundAt < b.foundAt ? 1 : -1))
    .map((alert) => {
      const task = domain.tasks.find((item) => item.id === alert.taskId)
      return {
        rowId: `task-${alert.id}`,
        source: '巡护任务',
        code: alert.code,
        location: alert.location,
        occurredAt: alert.foundAt,
        level: alert.level,
        reporter: alert.reporter,
        status: alert.status,
        active: alert.active,
        taskId: alert.taskId,
        taskVersion: task?.version,
        alertId: alert.id,
      }
    })
  for (const entry of listRows('firereport') as EntryRow[]) {
    rows.push({
      rowId: `report-${entry.id}`,
      source: '人工登记',
      code: String(entry['报告编号'] ?? `REPORT-${entry.id}`),
      location: String(entry['起火地点'] ?? ''),
      occurredAt: String(entry['起火时间'] ?? ''),
      level: String(entry['火势等级'] ?? ''),
      reporter: String(entry['报告人'] ?? ''),
      status: String(entry.status),
      active: ACTIVE_ALERT_STATUSES.has(String(entry.status)),
    })
  }
  return rows.sort((a, b) => (a.occurredAt === b.occurredAt ? 0 : a.occurredAt < b.occurredAt ? 1 : -1))
}

export function patrolOverview(): {
  todayCount: number
  finishedCount: number
  activeFireCount: number
  pendingCount: number
  cancelledCount: number
  total: number
} {
  const domain = loadDomain()
  const views = domain.tasks.map((task) => toView(domain, task.id))
  const today = stampFromDate(new Date()).slice(0, 10)
  return {
    todayCount: views.filter((view) => view.patrolDate === today).length,
    finishedCount: views.filter((view) => view.status === '已完成').length,
    activeFireCount: views.reduce((sum, view) => sum + view.fireCount, 0),
    pendingCount: views.filter((view) => view.pending).length,
    cancelledCount: views.filter((view) => view.status === '已取消').length,
    total: views.length,
  }
}

/** 巡护任务清单导出：状态列同样取自执行记录，杜绝导出旧状态。 */
export function exportTasksCsv(): { filename: string; content: string } {
  const header = ['任务编号', '巡护区域', '巡护路线', '巡护员', '巡护日期', '巡护时段', '发现火情数', '当前状态']
  const lines = [header.join(',')]
  for (const view of listTasks()) {
    lines.push([
      view.code,
      view.area,
      view.route,
      view.ranger,
      view.patrolDate,
      view.period,
      view.fireCount,
      view.status,
    ].join(','))
  }
  return { filename: '巡护任务-清单.csv', content: `﻿${lines.join('\n')}` }
}

export function downloadTasksCsv(): void {
  const { filename, content } = exportTasksCsv()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
