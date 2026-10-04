<template>
  <section class="page" data-module="patrol">
    <header class="page-head">
      <div>
        <h2>巡护任务管理</h2>
        <p class="page-desc">围绕任务编号、巡护区域、巡护路线、巡护员做调度与状态流转；状态以执行记录为准，只能由待执行、执行中向已完成单向推进。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出巡护任务清单</button>
      </div>
    </header>

    <nav class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-item"
        :class="{ active: activeTab === tab.key }"
        type="button"
        @click="switchTab(tab.key)"
      >
        {{ tab.label }}
      </button>
    </nav>

    <span class="hidden-tick">{{ tick }}</span>

    <!-- 班组列表 -->
    <div v-if="activeTab === 'list'">
      <div class="stat-row">
        <article v-for="item in stats" :key="item.label" class="stat-card">
          <span class="stat-label">{{ item.label }}</span>
          <strong class="stat-value">{{ item.value }}</strong>
        </article>
      </div>

      <p class="status-legend">
        <span v-for="item in statusSummary" :key="item.status" class="legend-item">
          {{ item.status }}：{{ item.count }}
        </span>
      </p>

      <form class="filter-bar" @submit.prevent="reload">
        <label class="filter-item">
          <span>关键字</span>
          <input v-model="keyword" placeholder="按编号/区域/路线/巡护员检索" />
        </label>
        <label class="filter-item">
          <span>任务状态</span>
          <select v-model="statusFilter">
            <option value="">全部</option>
            <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
          </select>
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td>{{ row.code }}</td>
            <td>{{ row.area }}</td>
            <td>{{ row.route }}</td>
            <td>{{ row.ranger }}</td>
            <td>{{ row.patrolDate }}</td>
            <td>{{ row.period }}</td>
            <td>{{ row.fireCount }}</td>
            <td>
              <span class="status-tag" :class="statusClass(row.status)">{{ row.status }}</span>
            </td>
            <td class="row-actions">
              <button class="link" type="button" @click="openDetail(row.id)">执行详情</button>
              <button
                v-for="action in availableActions(row.status)"
                :key="action"
                class="link"
                type="button"
                :disabled="busyKey === `${row.id}:${action}`"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 1" class="empty-state">暂无符合条件的巡护任务</td>
          </tr>
        </tbody>
      </table>

      <footer class="page-foot">
        <span>共 {{ total }} 条巡护任务记录</span>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      </footer>
    </div>

    <!-- 执行详情 -->
    <div v-else-if="activeTab === 'detail'">
      <div v-if="!detail" class="empty-state detail-empty">
        请先在班组列表里选择一条巡护任务查看执行详情
        <div style="margin-top: 10px">
          <button class="btn" type="button" @click="switchTab('list')">返回班组列表</button>
        </div>
      </div>
      <div v-else class="detail-wrap">
        <div class="detail-head">
          <div>
            <h3>{{ detail.code }} · {{ detail.area }}</h3>
            <p class="page-desc">巡护员：{{ detail.ranger }} ｜ 路线：{{ detail.route }} ｜ 日期：{{ detail.patrolDate }} ｜ 时段：{{ detail.period }}</p>
          </div>
          <div class="detail-side">
            <span class="status-tag" :class="statusClass(detail.status)">{{ detail.status }}</span>
            <span class="fire-badge">发现火情 {{ detail.fireCount }} 起</span>
            <span class="version-tag">数据版本 v{{ detail.version }}</span>
          </div>
        </div>

        <h4 class="detail-title">执行记录（状态权威）</h4>
        <table class="data-table">
          <thead>
            <tr><th>时间</th><th>动作</th><th>执行后状态</th><th>操作人</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="record in [...detail.records].reverse()" :key="record.id">
              <td>{{ record.operatedAt }}</td>
              <td>{{ record.action }}</td>
              <td>
                <span class="status-tag" :class="statusClass(record.statusAfter)">{{ record.statusAfter }}</span>
              </td>
              <td>{{ record.operator }}</td>
              <td>{{ record.note }}<template v-if="typeof record.fireCount === 'number'">（录入火情 {{ record.fireCount }} 起）</template></td>
            </tr>
          </tbody>
        </table>

        <h4 class="detail-title">关联火情提醒</h4>
        <table class="data-table">
          <thead>
            <tr><th>提醒编号</th><th>发现时间</th><th>火势</th><th>状态</th><th>报告人</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="alert in [...detail.alerts].reverse()" :key="alert.id">
              <td>{{ alert.code }}</td>
              <td>{{ alert.foundAt }}</td>
              <td>{{ alert.level }}</td>
              <td>{{ alert.status }}</td>
              <td>{{ alert.reporter }}</td>
              <td class="row-actions">
                <button
                  v-if="canWithdraw(alert.status)"
                  class="link"
                  type="button"
                  :disabled="busyKey === `alert:${alert.id}`"
                  @click="withdrawAlert(alert.id)"
                >
                  撤回火情
                </button>
                <span v-else class="muted-text">—</span>
              </td>
            </tr>
            <tr v-if="!detail.alerts.length">
              <td colspan="6" class="empty-state">该任务暂无火情提醒</td>
            </tr>
          </tbody>
        </table>

        <footer class="page-foot">
          <button class="btn" type="button" @click="switchTab('list')">返回班组列表</button>
          <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
        </footer>
      </div>
    </div>

    <!-- 任务台账 -->
    <div v-else>
      <p class="page-desc ledger-tip">巡护发现的火情与人工火情报告同台账展示；撤回的提醒保留痕迹但不再计入任务火情数。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in ledgerColumns" :key="column">{{ column }}</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in ledgerRows" :key="row.rowId">
            <td>{{ row.code }}</td>
            <td>{{ row.source }}</td>
            <td>{{ row.location }}</td>
            <td>{{ row.occurredAt }}</td>
            <td>{{ row.level }}</td>
            <td>{{ row.reporter }}</td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button
                v-if="row.source === '巡护任务' && canWithdraw(row.status)"
                class="link"
                type="button"
                :disabled="busyKey === `alert:${row.alertId}`"
                @click="withdrawAlert(Number(row.alertId))"
              >
                撤回火情
              </button>
              <span v-else class="muted-text">—</span>
            </td>
          </tr>
          <tr v-if="!ledgerRows.length">
            <td :colspan="ledgerColumns.length + 1" class="empty-state">暂无火情台账记录</td>
          </tr>
        </tbody>
      </table>
      <footer class="page-foot">
        <span>共 {{ ledgerRows.length }} 条台账记录，其中有效火情 {{ activeLedgerCount }} 起</span>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      </footer>
    </div>

    <!-- 确认完成：录入火情数，提交即与任务状态同事务落库 -->
    <div v-if="completionTask" class="modal-mask" @click.self="closeCompletion">
      <div class="modal-card">
        <h3>确认完成 {{ completionTask.code }}</h3>
        <p class="page-desc">任务完成后状态不可回退；填写本次巡护发现的火情数量，将同步生成火情提醒。</p>
        <label class="filter-item">
          <span>发现火情数（非负整数）</span>
          <input v-model.number="completionFireCount" type="number" min="0" step="1" />
        </label>
        <footer class="modal-foot">
          <button class="btn ghost" type="button" @click="closeCompletion">取消</button>
          <button class="btn primary" type="button" :disabled="completing" @click="confirmComplete">
            {{ completing ? '提交中…' : '确认完成并提交' }}
          </button>
        </footer>
        <p v-if="completionError" class="error-text">{{ completionError }}</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import {
  availableActions,
  downloadTasksCsv,
  getTask,
  listFireLedger,
  listTasks,
  patrolOverview,
  submitTaskAction,
  withdrawFireAlert,
} from '@/api/patrol-service'
import type { PatrolAction } from '@/api/patrol-service'
import type { AlertStatus, FireLedgerRow, TaskView } from '@/data/patrol-types'

type TabKey = 'list' | 'detail' | 'ledger'

const tabs: { key: TabKey; label: string }[] = [
  { key: 'list', label: '班组列表' },
  { key: 'detail', label: '执行详情' },
  { key: 'ledger', label: '任务台账' },
]

const columns = ['任务编号', '巡护区域', '巡护路线', '巡护员', '巡护日期', '巡护时段', '发现火情数', '当前状态']
const ledgerColumns = ['报告编号', '来源', '起火地点', '发现/起火时间', '火势等级', '报告人', '当前状态']
const statuses = ['待执行', '执行中', '已完成', '已取消']
const WITHDRAWABLE: AlertStatus[] = ['待核实', '已确认', '已出警', '已扑灭']

const activeTab = ref<TabKey>('list')
const rows = ref<TaskView[]>([])
const total = ref(0)
const errorMessage = ref('')
const keyword = ref('')
const statusFilter = ref('')
const detail = ref<TaskView | null>(null)
const detailTaskId = ref<number | null>(null)
const ledgerRows = ref<FireLedgerRow[]>([])
const busyKey = ref('')
const tick = ref(0)

const completionTask = ref<TaskView | null>(null)
const completionFireCount = ref<number | null>(0)
const completionError = ref('')
const completing = ref(false)

const stats = computed(() => {
  void tick.value
  const overview = patrolOverview()
  return [
    { label: '今日任务数', value: overview.todayCount },
    { label: '待执行/执行中', value: overview.pendingCount },
    { label: '已完成任务', value: overview.finishedCount },
    { label: '有效火情提醒', value: overview.activeFireCount },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)

const activeLedgerCount = computed(() => ledgerRows.value.filter((row) => row.active).length)

function statusClass(status: string): string {
  return {
    待执行: 'st-pending',
    执行中: 'st-doing',
    已完成: 'st-done',
    已取消: 'st-cancel',
  }[status] ?? ''
}

function canWithdraw(status: string): boolean {
  return (WITHDRAWABLE as string[]).includes(status)
}

function reload() {
  errorMessage.value = ''
  rows.value = listTasks({ keyword: keyword.value, status: statusFilter.value })
  total.value = rows.value.length
}

function reloadDetail() {
  if (detailTaskId.value !== null) {
    detail.value = getTask(detailTaskId.value)
  }
}

function reloadLedger() {
  ledgerRows.value = listFireLedger()
}

function switchTab(tab: TabKey) {
  activeTab.value = tab
  if (tab === 'list') {
    reload()
  } else if (tab === 'detail') {
    reloadDetail()
  } else {
    reloadLedger()
  }
}

function resetFilters() {
  keyword.value = ''
  statusFilter.value = ''
  reload()
}

function exportRows() {
  downloadTasksCsv()
}

function openDetail(taskId: number) {
  detailTaskId.value = taskId
  detail.value = getTask(taskId)
  activeTab.value = 'detail'
  errorMessage.value = ''
}

function runAction(action: PatrolAction, row: TaskView) {
  if (action === '确认完成') {
    completionTask.value = row
    completionFireCount.value = 0
    completionError.value = ''
    return
  }
  errorMessage.value = ''
  busyKey.value = `${row.id}:${action}`
  const result = submitTaskAction({
    taskId: row.id,
    action,
    expectedVersion: row.version,
  })
  busyKey.value = ''
  if (!result.ok) {
    errorMessage.value = result.message
    if (activeTab.value === 'detail') {
      reloadDetail()
    }
    return
  }
  reload()
  reloadDetail()
}

function closeCompletion() {
  if (completing.value) {
    return
  }
  completionTask.value = null
  completionError.value = ''
}

function confirmComplete() {
  const task = completionTask.value
  if (!task) {
    return
  }
  const fireCount = completionFireCount.value
  if (typeof fireCount !== 'number' || !Number.isInteger(fireCount) || fireCount < 0) {
    completionError.value = '发现火情数必须是不小于 0 的整数'
    return
  }
  completionError.value = ''
  completing.value = true
  busyKey.value = `${task.id}:确认完成`
  const result = submitTaskAction({
    taskId: task.id,
    action: '确认完成',
    expectedVersion: task.version,
    fireCount,
  })
  busyKey.value = ''
  completing.value = false
  if (!result.ok) {
    completionError.value = result.message
    // 可能是另一端已先提交：重读详情与列表，让页面回到最新状态。
    reload()
    reloadDetail()
    if (result.task) {
      completionTask.value = result.task
    }
    return
  }
  completionTask.value = null
  reload()
  reloadDetail()
}

function withdrawAlert(alertId: number) {
  const row = ledgerRows.value.find((item) => Number(item.alertId) === alertId)
  const expectedVersion = Number(row?.taskVersion ?? detail.value?.version ?? NaN)
  if (!Number.isFinite(expectedVersion)) {
    errorMessage.value = '缺少任务版本信息，请刷新后重试'
    return
  }
  errorMessage.value = ''
  busyKey.value = `alert:${alertId}`
  const result = withdrawFireAlert({ alertId, expectedTaskVersion: expectedVersion })
  busyKey.value = ''
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
  reloadDetail()
  reloadLedger()
}

// 跨标签页提交后，本标签页重新进入/切换时已通过重读存储保证一致；这里再兜一次实时刷新。
function handleExternalChange() {
  tick.value += 1
  reload()
  reloadDetail()
  reloadLedger()
}

onMounted(() => {
  reload()
  window.addEventListener('storage', handleExternalChange)
  window.addEventListener('patrol-domain:changed', handleExternalChange)
})

onBeforeUnmount(() => {
  window.removeEventListener('storage', handleExternalChange)
  window.removeEventListener('patrol-domain:changed', handleExternalChange)
})
</script>

<style scoped>
.hidden-tick { display: none; }
.tab-bar { display: flex; gap: 8px; margin: 10px 0 14px; }
.tab-item { border: 1px solid var(--border); background: #fff; border-radius: 6px 6px 0 0; padding: 6px 16px; cursor: pointer; font-size: 13px; }
.tab-item.active { background: var(--brand); border-color: var(--brand); color: #fff; }
.status-tag { border-radius: 999px; padding: 2px 10px; font-size: 12px; white-space: nowrap; }
.st-pending { background: #eef2f7; color: #475569; }
.st-doing { background: #fef3c7; color: #92400e; }
.st-done { background: #dcfce7; color: #166534; }
.st-cancel { background: #fee2e2; color: #991b1b; }
.detail-empty { text-align: center; padding: 40px 0; color: var(--muted); }
.detail-wrap { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
.detail-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.detail-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.fire-badge { font-size: 12px; color: #b42318; background: #fee2e2; border-radius: 999px; padding: 2px 10px; }
.version-tag { font-size: 12px; color: var(--muted); }
.detail-title { margin: 16px 0 8px; font-size: 14px; }
.muted-text { color: var(--muted); }
.ledger-tip { margin: 0 0 10px; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 20; }
.modal-card { background: #fff; border-radius: 10px; padding: 18px 20px; width: 420px; max-width: calc(100vw - 40px); }
.modal-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 14px; }
.link:disabled { color: #94a3b8; cursor: not-allowed; }
</style>
