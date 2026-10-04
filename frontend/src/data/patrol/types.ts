/**
 * 巡护任务领域模型。
 *
 * 设计要点：执行记录（PatrolExecution）是任务状态的唯一事实来源（source of truth）。
 * 班组列表、执行详情、任务台账三处展示的「任务状态 / 发现火情数」全部由执行记录推导，
 * 任何页面都不缓存、不自造状态，避免各说一套。
 */

/** 任务的生命周期状态：只允许 待执行 -> 执行中 -> 已完成 单向推进；已取消为终态。 */
export type PatrolStatus = '待执行' | '执行中' | '已完成' | '已取消'

/** 允许任务停留的全部状态（已取消是终态，不允许再回到执行流程）。 */
export const PATROL_STATUSES: PatrolStatus[] = ['待执行', '执行中', '已完成', '已取消']

/**
 * 执行记录事件类型（append-only，只追加不改写、不删除）。
 * - START    开始巡护：待执行 -> 执行中
 * - COMPLETE 确认完成：执行中 -> 已完成（可同次携带火情提醒）
 * - CANCEL   取消任务：待执行 -> 已取消（终态）
 * - ALERT    上报火情提醒：执行中/已完成 任务上追加火情
 * - WITHDRAW 撤回火情提醒：撤销一条火情提醒，并回写任务火情数
 */
export type ExecutionEventType = 'START' | 'COMPLETE' | 'CANCEL' | 'ALERT' | 'WITHDRAW'

export const EXECUTION_EVENT_LABEL: Record<ExecutionEventType, string> = {
  START: '开始巡护',
  COMPLETE: '确认完成',
  CANCEL: '取消任务',
  ALERT: '上报火情',
  WITHDRAW: '撤回火情',
}

/** 巡护任务（基础信息 + 乐观锁版本号；动态状态不存这里）。 */
export interface PatrolTask {
  id: number
  /** 乐观锁版本：每成功写入一条执行记录 +1，并发提交靠它拒绝第二次写入。 */
  version: number
  任务编号: string
  巡护区域: string
  巡护路线: string
  巡护员: string
  班组: string
  巡护日期: string
  巡护时段: string
  /** 创建时间（ms）。 */
  createdAt: number
}

/** 火情提醒：与确认完成/上报火情同次落库，撤回只做软撤销。 */
export interface FireAlert {
  id: number
  taskId: number
  /** 产生该提醒的执行记录 id，撤回时据此回写执行记录。 */
  executionId: number
  起火地点: string
  火势等级: string
  备注: string
  /** 提醒生成时间（ms）。 */
  createdAt: number
  /** 撤回时间；null 表示仍有效。 */
  withdrawnAt: number | null
}

/** 执行记录：append-only 事件日志，是任务状态与火情数的唯一事实来源。 */
export interface PatrolExecution {
  id: number
  taskId: number
  type: ExecutionEventType
  /** 该次事件发生时间（ms）。历史任务迁移时取原巡护日期。 */
  at: number
  operator: string
  /** 该次事件落库后任务的版本号（= 任务 version），用于审计与排查并发冲突。 */
  version: number
  /** ALERT 事件关联的火情提醒 id；WITHDRAW 事件记录被撤回的提醒 id。 */
  alertId?: number
  note?: string
}

/** 巡护领域整体持久化结构（任务、执行记录、火情提醒同库同写）。 */
export interface PatrolStoreData {
  /** 数据结构版本，便于以后再迁移。 */
  schemaVersion: number
  tasks: PatrolTask[]
  executions: PatrolExecution[]
  alerts: FireAlert[]
  /** 各表自增主键。 */
  seq: {
    task: number
    execution: number
    alert: number
  }
}

/** 提交动作时的结果：失败带明确原因，成功返回最新版本。 */
export interface PatrolActionResult {
  ok: boolean
  message: string
  /** 成功后的任务版本；失败时不返回。 */
  version?: number
}

/** 由执行记录推导出的任务实时视图。 */
export interface PatrolTaskView extends PatrolTask {
  status: PatrolStatus
  /** 有效（未撤回）火情数：由火情提醒推导。 */
  fireCount: number
  /** 最近一次执行记录时间，没有则取创建时间。 */
  lastActiveAt: number
}
