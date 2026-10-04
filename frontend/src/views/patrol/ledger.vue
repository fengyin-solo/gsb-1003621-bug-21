<template>
  <section class="page" data-module="patrol-ledger">
    <header class="page-head">
      <div>
        <h2>巡护任务 · 任务台账</h2>
        <p class="page-desc">
          只读台账，状态与火情数以执行记录、火情提醒为准汇总，用于审计核对，不提供直接改状态入口。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/patrol">班组列表</RouterLink>
        <button class="btn" type="button" @click="reload">刷新核对</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>关键字</span>
        <input v-model="keyword" placeholder="任务编号 / 班组 / 区域" />
      </label>
      <label class="filter-item">
        <span>巡护日期起</span>
        <input v-model="dateFrom" type="date" />
      </label>
      <label class="filter-item">
        <span>巡护日期止</span>
        <input v-model="dateTo" type="date" />
      </label>
      <label class="filter-item">
        <span>状态</span>
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
          <th>任务编号</th>
          <th>班组</th>
          <th>巡护区域</th>
          <th>巡护员</th>
          <th>原巡护日期</th>
          <th>当前状态</th>
          <th>发现火情数</th>
          <th>执行记录数</th>
          <th>开始时间</th>
          <th>完成/取消时间</th>
          <th>详情</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="row.task.id">
          <td>{{ row.task.任务编号 }}</td>
          <td>{{ row.task.班组 }}</td>
          <td>{{ row.task.巡护区域 }}</td>
          <td>{{ row.task.巡护员 }}</td>
          <td>{{ row.task.巡护日期 }}</td>
          <td>{{ row.task.status }}</td>
          <td>{{ row.task.fireCount }}</td>
          <td>{{ row.task.version }}</td>
          <td>{{ row.startedAt ? formatTime(row.startedAt) : '—' }}</td>
          <td>{{ row.endedAt ? formatTime(row.endedAt) : '—' }}</td>
          <td><RouterLink class="link" :to="`/patrol/tasks/${row.task.id}`">查看</RouterLink></td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td colspan="11" class="empty-state">台账暂无符合条件的记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ filteredRows.length }} 条台账记录</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listExecutions, listTasks } from '@/api/patrol-service'
import type { PatrolTaskView } from '@/data/patrol/types'

const statuses = ['待执行', '执行中', '已完成', '已取消']

const tasks = ref<PatrolTaskView[]>([])
const keyword = ref('')
const dateFrom = ref('')
const dateTo = ref('')
const statusFilter = ref('')

interface LedgerRow {
  task: PatrolTaskView
  startedAt: number | null
  endedAt: number | null
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

const filteredRows = computed<LedgerRow[]>(() => {
  const key = keyword.value.trim()
  return tasks.value
    .filter((task) => {
      const hitKey =
        key === '' ||
        [task.任务编号, task.班组, task.巡护区域].some((value) => String(value).includes(key))
      const hitStatus = statusFilter.value === '' || task.status === statusFilter.value
      const hitFrom = dateFrom.value === '' || task.巡护日期 >= dateFrom.value
      const hitTo = dateTo.value === '' || task.巡护日期 <= dateTo.value
      return hitKey && hitStatus && hitFrom && hitTo
    })
    .map((task) => {
      const events = listExecutions(task.id)
      const start = events.find((event) => event.type === 'START')
      const end = events.find((event) => event.type === 'COMPLETE' || event.type === 'CANCEL')
      return { task, startedAt: start?.at ?? null, endedAt: end?.at ?? null }
    })
})

const stats = computed(() => [
  { label: '台账任务', value: tasks.value.length },
  { label: '已完成', value: tasks.value.filter((row) => row.status === '已完成').length },
  { label: '已取消', value: tasks.value.filter((row) => row.status === '已取消').length },
  { label: '有效火情', value: tasks.value.reduce((sum, row) => sum + row.fireCount, 0) },
])

function reload() {
  tasks.value = listTasks()
}

function resetFilters() {
  keyword.value = ''
  dateFrom.value = ''
  dateTo.value = ''
  statusFilter.value = ''
}

onMounted(reload)
</script>
