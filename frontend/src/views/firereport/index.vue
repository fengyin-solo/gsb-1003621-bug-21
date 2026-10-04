<template>
  <section class="page" data-module="firereport">
    <header class="page-head">
      <div>
        <h2>火情报告管理</h2>
        <p class="page-desc">人工火情报告与巡护任务发现的火情提醒同台账展示；巡护火情撤回后自动核减任务火情数，撤回记录留在执行详情里。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记火情报告</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">台账总量</span>
        <strong class="stat-value">{{ rows.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">有效火情（未撤回/非误报）</span>
        <strong class="stat-value">{{ activeCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">巡护发现待核实</span>
        <strong class="stat-value">{{ pendingTaskAlerts }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>关键字</span>
        <input v-model="keyword" placeholder="按编号/地点检索" />
      </label>
      <label class="filter-item">
        <span>来源</span>
        <select v-model="sourceFilter">
          <option value="">全部</option>
          <option value="巡护任务">巡护任务</option>
          <option value="人工登记">人工登记</option>
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
        <tr v-for="row in filteredRows" :key="row.rowId">
          <td>{{ row.code }}</td>
          <td>{{ row.source }}</td>
          <td>{{ row.location }}</td>
          <td>{{ row.occurredAt }}</td>
          <td>{{ row.level }}</td>
          <td>{{ row.reporter }}</td>
          <td>
            <span class="status-tag" :class="{ withdrawn: row.status === '已撤回' }">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button
              v-if="row.source === '巡护任务' && canWithdraw(row.status)"
              class="link"
              type="button"
              :disabled="busyKey === `alert:${row.alertId}`"
              @click="withdraw(Number(row.alertId))"
            >
              撤回火情
            </button>
            <span v-else class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td :colspan="columns.length + 1" class="empty-state">暂无火情台账记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ filteredRows.length }} 条火情记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { listFireLedger, withdrawFireAlert } from '@/api/patrol-service'
import type { FireLedgerRow } from '@/data/patrol-types'

const columns = ['报告编号', '来源', '起火地点', '发现/起火时间', '火势等级', '报告人', '当前状态']
const WITHDRAWABLE = new Set(['待核实', '已确认', '已出警', '已扑灭'])

const rows = ref<FireLedgerRow[]>([])
const keyword = ref('')
const sourceFilter = ref('')
const errorMessage = ref('')
const busyKey = ref('')
const tick = ref(0)

const filteredRows = computed(() => {
  void tick.value
  const word = keyword.value.trim()
  return rows.value.filter((row) => {
    if (sourceFilter.value && row.source !== sourceFilter.value) {
      return false
    }
    if (word && !`${row.code} ${row.location}`.includes(word)) {
      return false
    }
    return true
  })
})

const activeCount = computed(() => {
  void tick.value
  return rows.value.filter((row) => row.active).length
})

const pendingTaskAlerts = computed(() => {
  void tick.value
  return rows.value.filter((row) => row.source === '巡护任务' && row.status === '待核实').length
})

function canWithdraw(status: string): boolean {
  return WITHDRAWABLE.has(status)
}

function openCreate() {
  errorMessage.value = '火情报告登记入口尚未接入审批流'
}

function resetFilters() {
  keyword.value = ''
  sourceFilter.value = ''
}

function withdraw(alertId: number) {
  const row = rows.value.find((item) => Number(item.alertId) === alertId)
  const expectedVersion = Number(row?.taskVersion)
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
}

function reload() {
  errorMessage.value = ''
  rows.value = listFireLedger()
}

function handleExternalChange() {
  tick.value += 1
  reload()
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
.status-tag { border-radius: 999px; padding: 2px 10px; font-size: 12px; background: #fef3c7; color: #92400e; }
.status-tag.withdrawn { background: #e2e8f0; color: #475569; }
.muted-text { color: var(--muted); }
.link:disabled { color: #94a3b8; cursor: not-allowed; }
</style>
