<template>
  <section class="page" data-module="patrol-detail">
    <header class="page-head">
      <div>
        <h2>巡护任务 · 执行详情</h2>
        <p class="page-desc">
          当前状态以执行记录为准实时推导；火情提醒可撤回，撤回后火情数立即回写，不留状态残留。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/patrol">返回班组列表</RouterLink>
        <RouterLink class="btn" to="/patrol/ledger">任务台账</RouterLink>
      </div>
    </header>

    <div v-if="!task" class="empty-state">未找到该巡护任务，可能已被重置。</div>

    <template v-else>
      <article class="detail-card">
        <div class="detail-head">
          <h3>{{ task.任务编号 }}</h3>
          <span class="status-tag" :data-status="task.status">{{ task.status }}</span>
          <span class="version-tag">版本 v{{ task.version }}</span>
        </div>
        <dl class="detail-grid">
          <div><dt>班组</dt><dd>{{ task.班组 }}</dd></div>
          <div><dt>巡护员</dt><dd>{{ task.巡护员 }}</dd></div>
          <div><dt>巡护区域</dt><dd>{{ task.巡护区域 }}</dd></div>
          <div><dt>巡护路线</dt><dd>{{ task.巡护路线 }}</dd></div>
          <div><dt>巡护日期</dt><dd>{{ task.巡护日期 }}</dd></div>
          <div><dt>巡护时段</dt><dd>{{ task.巡护时段 }}</dd></div>
          <div><dt>发现火情数</dt><dd class="fire-count">{{ task.fireCount }}</dd></div>
          <div><dt>最近活动</dt><dd>{{ formatTime(task.lastActiveAt) }}</dd></div>
        </dl>
        <div class="detail-actions">
          <button v-if="task.status === '待执行'" class="btn" type="button" @click="start">开始巡护</button>
          <button v-if="task.status === '待执行'" class="btn ghost" type="button" @click="cancel">取消任务</button>
        </div>
      </article>

      <div class="detail-columns">
        <article class="detail-card">
          <h3 class="section-title">执行记录（状态来源）</h3>
          <ol class="timeline">
            <li v-for="execution in executions" :key="execution.id" class="timeline-item">
              <div class="timeline-dot" :data-type="execution.type"></div>
              <div class="timeline-body">
                <strong>{{ eventLabel(execution.type) }}</strong>
                <span class="timeline-meta">
                  {{ formatTime(execution.at) }} · {{ execution.operator }} · 落库版本 v{{ execution.version }}
                </span>
                <p v-if="execution.note" class="timeline-note">{{ execution.note }}</p>
              </div>
            </li>
            <li v-if="!executions.length" class="empty-state">暂无执行记录，任务处于待执行。</li>
          </ol>
        </article>

        <article class="detail-card">
          <h3 class="section-title">火情提醒（{{ activeAlerts.length }} 起有效）</h3>
          <table class="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>起火地点</th>
                <th>火势等级</th>
                <th>状态</th>
                <th>时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="alert in alerts" :key="alert.id" :class="{ withdrawn: alert.withdrawnAt !== null }">
                <td>{{ alert.id }}</td>
                <td>{{ alert.起火地点 }}</td>
                <td>{{ alert.火势等级 }}</td>
                <td>{{ alert.withdrawnAt === null ? '有效' : '已撤回' }}</td>
                <td>{{ formatTime(alert.createdAt) }}</td>
                <td>
                  <button
                    v-if="alert.withdrawnAt === null"
                    class="link"
                    type="button"
                    @click="withdraw(alert.id)"
                  >
                    撤回
                  </button>
                  <span v-else class="timeline-meta">{{ formatTime(alert.withdrawnAt) }}</span>
                </td>
              </tr>
              <tr v-if="!alerts.length">
                <td colspan="6" class="empty-state">暂无火情提醒</td>
              </tr>
            </tbody>
          </table>
        </article>
      </div>

      <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  cancelTask,
  getTask,
  listAlerts,
  listExecutions,
  startTask,
  withdrawFire,
} from '@/api/patrol-service'
import {
  EXECUTION_EVENT_LABEL,
  type ExecutionEventType,
  type FireAlert,
  type PatrolExecution,
  type PatrolTaskView,
} from '@/data/patrol/types'

const route = useRoute()
const taskId = Number(route.params.id)

const task = ref<PatrolTaskView | undefined>(undefined)
const executions = ref<PatrolExecution[]>([])
const alerts = ref<FireAlert[]>([])
const errorMessage = ref('')

const activeAlerts = computed(() => alerts.value.filter((alert) => alert.withdrawnAt === null))

function eventLabel(type: ExecutionEventType): string {
  return EXECUTION_EVENT_LABEL[type]
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

// 每次进入/操作后都从执行记录重新推导，保证执行详情与班组列表、台账一致。
function reload() {
  errorMessage.value = ''
  task.value = getTask(taskId)
  executions.value = listExecutions(taskId)
  alerts.value = listAlerts(taskId)
}

function start() {
  if (!task.value) return
  const result = startTask(task.value.id, task.value.version)
  if (!result.ok) errorMessage.value = result.message
  reload()
}

function cancel() {
  if (!task.value) return
  const result = cancelTask(task.value.id, task.value.version)
  if (!result.ok) errorMessage.value = result.message
  reload()
}

function withdraw(alertId: number) {
  if (!task.value) return
  // 携带任务当前版本：若另一端已经写过，第二次写入会被拒绝。
  const result = withdrawFire(alertId, task.value.version)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
}

onMounted(reload)
</script>

<style scoped>
.detail-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 18px;
  margin-bottom: 18px;
}
.detail-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.detail-head h3 {
  margin: 0;
}
.status-tag {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  background: #eef2f7;
}
.version-tag {
  font-size: 12px;
  color: #8a94a6;
}
.detail-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin: 0;
}
.detail-grid dt {
  font-size: 12px;
  color: #8a94a6;
}
.detail-grid dd {
  margin: 2px 0 0;
}
.fire-count {
  font-size: 18px;
  font-weight: 700;
  color: #d9534f;
}
.detail-actions {
  margin-top: 14px;
  display: flex;
  gap: 10px;
}
.detail-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.section-title {
  margin: 0 0 12px;
}
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
}
.timeline-item {
  position: relative;
  padding: 0 0 16px 22px;
  border-left: 2px solid #e3e6eb;
}
.timeline-dot {
  position: absolute;
  left: -7px;
  top: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #6b7a90;
}
.timeline-dot[data-type='START'] { background: #2f7ed8; }
.timeline-dot[data-type='COMPLETE'] { background: #3aa76d; }
.timeline-dot[data-type='CANCEL'] { background: #b0b6c0; }
.timeline-dot[data-type='ALERT'] { background: #e08a1e; }
.timeline-dot[data-type='WITHDRAW'] { background: #d9534f; }
.timeline-meta {
  display: block;
  font-size: 12px;
  color: #8a94a6;
  margin-top: 2px;
}
.timeline-note {
  margin: 4px 0 0;
  font-size: 13px;
}
tr.withdrawn td {
  color: #aab1bd;
  text-decoration: line-through;
}
</style>
