/**
 * 巡护任务域模型：任务 -> 执行记录 -> 火情提醒 三张表同库存放。
 * 状态权威在执行记录：任务表本身不存状态，列表/详情/台账一律从最新执行记录推导。
 */

// 任务状态只能沿 待执行 -> 执行中 -> 已完成 单向推进；已取消是 待执行 旁支上的终态。
export type TaskStatus = '待执行' | '执行中' | '已完成' | '已取消'

// 执行记录上的动作：前四项驱动任务状态机，「火情撤回」只核减火情数，不改变任务状态。
export type ExecAction = '登记' | '开始巡护' | '确认完成' | '取消任务' | '火情撤回'

export interface ExecRecord {
  id: number
  taskId: number
  action: ExecAction
  /** 动作落库后的任务状态：冲突时以执行记录为准。 */
  statusAfter: TaskStatus
  operatedAt: string
  operator: string
  note: string
  /** 仅「确认完成」记录携带：完成时录入的发现火情数快照。 */
  fireCount?: number
}

// 火情提醒状态复用火情报告口径，撤回是提醒自己的终态，不再计入任务火情数。
export type AlertStatus = '待核实' | '已确认' | '已出警' | '已扑灭' | '误报' | '已撤回'

export interface FireAlert {
  id: number
  /** 提醒编号，同时作为任务台账/火情报告页里的报告编号。 */
  code: string
  taskId: number
  location: string
  foundAt: string
  level: string
  status: AlertStatus
  /** 是否参与任务「发现火情数」回写：撤回后置为 false。 */
  active: boolean
  reporter: string
  createdAt: string
  withdrawnAt?: string
  withdrawNote?: string
}

export interface PatrolTask {
  id: number
  code: string
  area: string
  route: string
  ranger: string
  /** 历史任务迁移时保留原巡护日期，新任务取登记日期。 */
  patrolDate: string
  period: string
  /** 乐观锁：任何一次提交都校验并自增，两端并发时第二次写入被拒绝。 */
  version: number
}

export interface PatrolDomain {
  schemaVersion: 1
  migratedAt: string
  tasks: PatrolTask[]
  records: ExecRecord[]
  alerts: FireAlert[]
  taskSeq: number
  recordSeq: number
  alertSeq: number
}

/** 列表/详情统一视图：status 与 fireCount 都是从执行记录、火情提醒实时推导的。 */
export interface TaskView extends PatrolTask {
  status: TaskStatus
  fireCount: number
  pending: boolean
  abnormal: boolean
  records: ExecRecord[]
  alerts: FireAlert[]
}

/** 任务台账行：巡护火情提醒与人工火情报告合并后的统一口径。 */
export interface FireLedgerRow {
  /** `task-${alertId}` 或 `report-${entryId}`。 */
  rowId: string
  source: '巡护任务' | '人工登记'
  code: string
  location: string
  occurredAt: string
  level: string
  reporter: string
  status: string
  active: boolean
  /** 巡护提醒携带，供撤回动作做任务级并发校验。 */
  taskId?: number
  taskVersion?: number
  alertId?: number
}
