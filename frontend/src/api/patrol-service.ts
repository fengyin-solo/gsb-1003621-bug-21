import { commit, draftPatrolStore, getPatrolStore } from '@/data/patrol/patrol-store'
import type {
  ExecutionEventType,
  FireAlert,
  PatrolActionResult,
  PatrolExecution,
  PatrolStatus,
  PatrolStoreData,
  PatrolTask,
  PatrolTaskView,
} from '@/data/patrol/types'

/**
 * 巡护任务领域服务：唯一允许做业务判断的地方，页面组件只调用、不判断。
 *
 * 状态来源：执行记录（append-only）。任务表只存基础信息和乐观锁版本号，
 * 任何「当前状态 / 火情数」都在这里现算，保证班组列表、执行详情、任务台账永远一致。
 */

/** 合法的单向推进：待执行 -> 执行中 -> 已完成；取消仅允许从待执行进入终态。 */
const NEXT_STATUS: Record<ExecutionEventType, PatrolStatus | null> = {
  START: '执行中',
  COMPLETE: '已完成',
  CANCEL: '已取消',
  ALERT: null, // 不改变任务状态
  WITHDRAW: null, // 不改变任务状态
}

export function listTasks(): PatrolTaskView[] {
  return deriveViews(getPatrolStore()).sort((a, b) => a.id - b.id)
}

export function getTask(id: number): PatrolTaskView | undefined {
  return deriveViews(getPatrolStore()).find((task) => task.id === id)
}

export function listExecutions(taskId?: number): PatrolExecution[] {
  const store = getPatrolStore()
  return store.executions
    .filter((execution) => taskId === undefined || execution.taskId === taskId)
    .sort((a, b) => (a.at === b.at ? a.id - b.id : a.at - b.at))
}

export function listAlerts(taskId?: number): FireAlert[] {
  return getPatrolStore()
    .alerts.filter((alert) => taskId === undefined || alert.taskId === taskId)
    .sort((a, b) => a.id - b.id)
}

/** 班组列表：按班组聚合任务与火情。 */
export interface CrewSummary {
  crew: string
  taskTotal: number
  pending: number
  running: number
  completed: number
  canceled: number
  fireCount: number
}

export function listCrews(): CrewSummary[] {
  const views = deriveViews(getPatrolStore())
  const map = new Map<string, CrewSummary>()
  for (const view of views) {
    const crew = view.班组 || '未分班班组'
    let summary = map.get(crew)
    if (!summary) {
      summary = {
        crew,
        taskTotal: 0,
        pending: 0,
        running: 0,
        completed: 0,
        canceled: 0,
        fireCount: 0,
      }
      map.set(crew, summary)
    }
    summary.taskTotal += 1
    summary.fireCount += view.fireCount
    if (view.status === '待执行') summary.pending += 1
    if (view.status === '执行中') summary.running += 1
    if (view.status === '已完成') summary.completed += 1
    if (view.status === '已取消') summary.canceled += 1
  }
  return [...map.values()].sort((a, b) => a.crew.localeCompare(b.crew, 'zh-Hans-CN'))
}

/** 由执行记录推导单个任务状态（冲突时以执行记录为准）。 */
function deriveStatus(store: PatrolStoreData, taskId: number): PatrolStatus {
  const events = store.executions
    .filter((execution) => execution.taskId === taskId)
    .sort((a, b) => (a.at === b.at ? a.id - b.id : a.at - b.id))

  let status: PatrolStatus = '待执行'
  for (const event of events) {
    const target = NEXT_STATUS[event.type]
    if (target === null) continue
    // 只接受合法的单向推进；任何「往回走」事件都忽略，绝不回退状态。
    if (isForward(status, target)) {
      status = target
    }
  }
  return status
}

/** 单向推进规则：待执行->执行中->已完成；待执行->已取消。其余一律非法。 */
function isForward(from: PatrolStatus, to: PatrolStatus): boolean {
  if (from === to) return false
  if (to === '已取消') return from === '待执行'
  if (from === '已取消') return false
  if (to === '执行中') return from === '待执行'
  if (to === '已完成') return from === '执行中'
  return false
}

function deriveFireCount(store: PatrolStoreData, taskId: number): number {
  return store.alerts.filter((alert) => alert.taskId === taskId && alert.withdrawnAt === null).length
}

function deriveViews(store: PatrolStoreData): PatrolTaskView[] {
  return store.tasks.map((task) => {
    const events = store.executions.filter((execution) => execution.taskId === task.id)
    const last = events.reduce<PatrolExecution | null>(
      (max, event) => (max === null || event.at > max.at ? event : max),
      null,
    )
    return {
      ...task,
      status: deriveStatus(store, task.id),
      fireCount: deriveFireCount(store, task.id),
      lastActiveAt: last?.at ?? task.createdAt,
    }
  })
}

interface ApplyContext {
  store: PatrolStoreData
  task: PatrolTask
  expectedVersion: number
  operator: string
}

/**
 * 执行一次动作的通用骨架：
 * 1) 校验任务存在；
 * 2) 乐观锁校验版本（两端并发提交时，版本对不上的第二次写入直接拒绝）；
 * 3) 调用 mutate 在草稿上追加执行记录/火情；
 * 4) 整体 commit，落库失败则抛出、保留旧数据（一起退回）。
 */
function apply(
  taskId: number,
  expectedVersion: number,
  operator: string,
  mutate: (context: ApplyContext) => PatrolActionResult,
): PatrolActionResult {
  const store = getPatrolStore()
  const task = store.tasks.find((item) => item.id === taskId)
  if (!task) {
    return { ok: false, message: `没有找到编号为 ${taskId} 的巡护任务` }
  }
  if (task.version !== expectedVersion) {
    return {
      ok: false,
      message: `任务已被其他人更新（当前版本 ${task.version}，提交基于版本 ${expectedVersion}），请刷新后重试`,
    }
  }
  const result = mutate({ store, task, expectedVersion, operator })
  return result
}

/** 追加一条执行记录并推进版本（调用方已保证迁移合法）。 */
function appendExecution(
  store: PatrolStoreData,
  taskId: number,
  type: ExecutionEventType,
  operator: string,
  extra?: Partial<PatrolExecution>,
): PatrolExecution {
  store.seq.execution += 1
  const task = store.tasks.find((item) => item.id === taskId)
  const nextVersion = (task?.version ?? 0) + 1
  if (task) task.version = nextVersion
  const execution: PatrolExecution = {
    id: store.seq.execution,
    taskId,
    type,
    at: Date.now(),
    operator,
    version: nextVersion,
    ...extra,
  }
  store.executions.push(execution)
  return execution
}

function commitOrFail(draft: PatrolStoreData): PatrolActionResult {
  try {
    commit(draft)
    return { ok: true, message: '' }
  } catch {
    // commit 失败时不会替换内存数据，调用方拿到失败，任务与火情都不会落库。
    return { ok: false, message: '数据落库失败，本次任务与火情变更已全部退回，请重试' }
  }
}

/** 开始巡护：待执行 -> 执行中。 */
export function startTask(taskId: number, expectedVersion: number, operator = '值班管理员'): PatrolActionResult {
  return apply(taskId, expectedVersion, operator, ({ store, task }) => {
    const current = deriveStatus(store, task.id)
    if (current !== '待执行') {
      return { ok: false, message: `任务当前为「${current}」，只有待执行任务能开始巡护` }
    }
    const draft = draftPatrolStore()
    appendExecution(draft, task.id, 'START', operator)
    const saved = commitOrFail(draft)
    return saved.ok
      ? { ok: true, message: '巡护已开始，状态推进为「执行中」', version: expectedVersion + 1 }
      : saved
  })
}

/** 确认完成时可选携带的火情信息（与完成动作同次落库）。 */
export interface CompletePayload {
  fires?: { 起火地点: string; 火势等级: string; 备注?: string }[]
}

/**
 * 确认完成：执行中 -> 已完成。
 * 任务执行记录与本次发现的火情提醒在同一份草稿上构建、一次 commit 落库；
 * 任一失败整体退回，绝不出现「任务完成了但火情没写」或反之。
 */
export function completeTask(
  taskId: number,
  expectedVersion: number,
  payload: CompletePayload = {},
  operator = '值班管理员',
): PatrolActionResult {
  return apply(taskId, expectedVersion, operator, ({ store, task }) => {
    const current = deriveStatus(store, task.id)
    // 已取消是终态：取消后不能再确认完成。
    if (current === '已取消') {
      return { ok: false, message: '任务已取消，不能再确认完成' }
    }
    if (current === '已完成') {
      return { ok: false, message: '任务已完成，无需重复确认' }
    }
    if (current !== '执行中') {
      return { ok: false, message: `任务当前为「${current}」，只有执行中的任务能确认完成` }
    }

    const draft = draftPatrolStore()
    const completion = appendExecution(draft, task.id, 'COMPLETE', operator, {
      note: payload.fires?.length ? `确认完成，同次上报 ${payload.fires.length} 起火情` : '确认完成',
    })

    // 火情提醒与完成动作同次构建、同次落库。
    for (const fire of payload.fires ?? []) {
      draft.seq.alert += 1
      const alert: FireAlert = {
        id: draft.seq.alert,
        taskId: task.id,
        executionId: completion.id,
        起火地点: fire.起火地点,
        火势等级: fire.火势等级,
        备注: fire.备注 ?? '',
        createdAt: completion.at,
        withdrawnAt: null,
      }
      draft.alerts.push(alert)
      appendExecution(draft, task.id, 'ALERT', operator, {
        alertId: alert.id,
        note: `上报火情：${fire.起火地点}（${fire.火势等级}）`,
      })
    }

    const saved = commitOrFail(draft)
    const finalVersion = draft.tasks.find((item) => item.id === task.id)?.version
    return saved.ok
      ? { ok: true, message: '任务已确认完成，发现火情数已同步回写', version: finalVersion }
      : saved
  })
}

/** 取消任务：仅允许待执行 -> 已取消（终态）。 */
export function cancelTask(taskId: number, expectedVersion: number, operator = '值班管理员'): PatrolActionResult {
  return apply(taskId, expectedVersion, operator, ({ store, task }) => {
    const current = deriveStatus(store, task.id)
    if (current === '已取消') {
      return { ok: false, message: '任务已是取消状态' }
    }
    if (current !== '待执行') {
      return { ok: false, message: `任务当前为「${current}」，执行中或已完成的任务不能取消` }
    }
    const draft = draftPatrolStore()
    appendExecution(draft, task.id, 'CANCEL', operator, { note: '任务取消，终态' })
    const saved = commitOrFail(draft)
    const finalVersion = draft.tasks.find((item) => item.id === task.id)?.version
    return saved.ok
      ? { ok: true, message: '任务已取消（终态），不可再开始或完成', version: finalVersion }
      : saved
  })
}

/**
 * 执行中补报火情：同次落库任务火情数（append ALERT 执行记录 + 火情提醒）。
 */
export function reportFire(
  taskId: number,
  expectedVersion: number,
  fire: { 起火地点: string; 火势等级: string; 备注?: string },
  operator = '值班管理员',
): PatrolActionResult {
  return apply(taskId, expectedVersion, operator, ({ store, task }) => {
    const current = deriveStatus(store, task.id)
    if (current !== '执行中' && current !== '已完成') {
      return { ok: false, message: `任务当前为「${current}」，无法上报火情` }
    }
    const draft = draftPatrolStore()
    const event = appendExecution(draft, task.id, 'ALERT', operator, {
      note: `上报火情：${fire.起火地点}（${fire.火势等级}）`,
    })
    draft.seq.alert += 1
    const alert: FireAlert = {
      id: draft.seq.alert,
      taskId: task.id,
      executionId: event.id,
      起火地点: fire.起火地点,
      火势等级: fire.火势等级,
      备注: fire.备注 ?? '',
      createdAt: event.at,
      withdrawnAt: null,
    }
    draft.alerts.push(alert)
    event.alertId = alert.id
    const saved = commitOrFail(draft)
    const finalVersion = draft.tasks.find((item) => item.id === task.id)?.version
    return saved.ok
      ? { ok: true, message: '火情已上报，任务发现火情数已回写', version: finalVersion }
      : saved
  })
}

/**
 * 撤回火情提醒：火情标记撤回 + 追加 WITHDRAW 执行记录，同次落库。
 * 撤回后执行记录里留下痕迹（不删数据），任务火情数立即回写，杜绝「状态残留」。
 */
export function withdrawFire(
  alertId: number,
  expectedVersion: number,
  operator = '值班管理员',
): PatrolActionResult {
  const store = getPatrolStore()
  const alert = store.alerts.find((item) => item.id === alertId)
  if (!alert) {
    return { ok: false, message: `没有找到编号为 ${alertId} 的火情提醒` }
  }
  if (alert.withdrawnAt !== null) {
    return { ok: false, message: '该火情提醒已撤回，不能重复撤回' }
  }
  const task = store.tasks.find((item) => item.id === alert.taskId)
  if (!task) {
    return { ok: false, message: '火情提醒对应的任务不存在' }
  }
  if (task.version !== expectedVersion) {
    return {
      ok: false,
      message: `任务已被其他人更新（当前版本 ${task.version}，提交基于版本 ${expectedVersion}），请刷新后重试`,
    }
  }

  const draft = draftPatrolStore()
  const draftAlert = draft.alerts.find((item) => item.id === alertId)
  if (draftAlert) draftAlert.withdrawnAt = Date.now()
  appendExecution(draft, task.id, 'WITHDRAW', operator, {
    alertId,
    note: `撤回火情提醒 #${alertId}，火情数回写`,
  })
  const saved = commitOrFail(draft)
  const finalVersion = draft.tasks.find((item) => item.id === task.id)?.version
  return saved.ok
    ? { ok: true, message: '火情提醒已撤回，任务火情数已回写', version: finalVersion }
    : saved
}
