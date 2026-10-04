<template>
  <section class="page" data-module="patrol-crew">
    <header class="page-head">
      <div>
        <h2>巡护任务 · 班组列表</h2>
        <p class="page-desc">
          按班组查看巡护任务。当前状态与发现火情数都由执行记录实时推导，刷新或重新进入保持一致。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" type="button" to="/patrol/ledger">任务台账</RouterLink>
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
        <span>任务编号 / 区域 / 巡护员</span>
        <input v-model="keyword" placeholder="按关键字检索" />
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
          <th>班组</th>
          <th>任务编号</th>
          <th>巡护区域</th>
          <th>巡护员</th>
          <th>巡护日期</th>
          <th>发现火情数</th>
          <th>当前状态</th>
          <th>版本</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredTasks" :key="row.id">
          <td>{{ row.班组 }}</td>
          <td>
            <RouterLink class="link" :to="`/patrol/tasks/${row.id}`">{{ row.任务编号 }}</RouterLink>
          </td>
          <td>{{ row.巡护区域 }}</td>
          <td>{{ row.巡护员 }}</td>
          <td>{{ row.巡护日期 }}</td>
          <td>{{ row.fireCount }}</td>
          <td>{{ row.status }}</td>
          <td>v{{ row.version }}</td>
          <td class="row-actions">
            <button
              v-if="row.status === '待执行'"
              class="link"
              type="button"
              @click="start(row)"
            >
              开始巡护
            </button>
            <button
              v-if="row.status === '待执行'"
              class="link"
              type="button"
              @click="cancel(row)"
            >
              取消任务
            </button>
            <button
              v-if="row.status === '执行中'"
              class="link"
              type="button"
              @click="openComplete(row)"
            >
              确认完成
            </button>
            <button
              v-if="row.status === '执行中'"
              class="link"
              type="button"
              @click="openReport(row)"
            >
              上报火情
            </button>
            <RouterLink class="link" :to="`/patrol/tasks/${row.id}`">执行详情</RouterLink>
          </td>
        </tr>
        <tr v-if="!filteredTasks.length">
          <td colspan="9" class="empty-state">暂无符合条件的巡护任务</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">班组汇总</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>班组</th>
          <th>任务总数</th>
          <th>待执行</th>
          <th>执行中</th>
          <th>已完成</th>
          <th>已取消</th>
          <th>有效火情数</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="crew in crews" :key="crew.crew">
          <td>{{ crew.crew }}</td>
          <td>{{ crew.taskTotal }}</td>
          <td>{{ crew.pending }}</td>
          <td>{{ crew.running }}</td>
          <td>{{ crew.completed }}</td>
          <td>{{ crew.canceled }}</td>
          <td>{{ crew.fireCount }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 确认完成弹窗：可同次登记发现的火情，任务与火情一起落库 -->
    <div v-if="completing" class="modal-mask" @click.self="closeComplete">
      <div class="modal">
        <h3>确认完成 · {{ completing.任务编号 }}</h3>
        <p class="modal-tip">确认后状态推进为「已完成」，下列火情提醒与任务完成同次落库，失败一起退回。</p>
        <div v-for="(fire, index) in completeFires" :key="index" class="form-grid">
          <label>
            <span>起火地点</span>
            <input v-model="fire.起火地点" placeholder="如：北坡三号沟" />
          </label>
          <label>
            <span>火势等级</span>
            <select v-model="fire.火势等级">
              <option value="一般">一般</option>
              <option value="较大">较大</option>
              <option value="重大">重大</option>
            </select>
          </label>
          <label class="form-wide">
            <span>备注</span>
            <input v-model="fire.备注" placeholder="可选" />
          </label>
          <button class="btn ghost" type="button" @click="completeFires.splice(index, 1)">移除</button>
        </div>
        <p v-if="!completeFires.length" class="empty-state">本次未发现火情，可直接确认完成。</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="addFire">加一条火情</button>
          <button class="btn" type="button" @click="closeComplete">取消</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="submitComplete">
            确认完成
          </button>
        </div>
        <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
      </div>
    </div>

    <!-- 执行中补报火情 -->
    <div v-if="reporting" class="modal-mask" @click.self="closeReport">
      <div class="modal">
        <h3>上报火情 · {{ reporting.任务编号 }}</h3>
        <div class="form-grid">
          <label>
            <span>起火地点</span>
            <input v-model="reportFireForm.起火地点" />
          </label>
          <label>
            <span>火势等级</span>
            <select v-model="reportFireForm.火势等级">
              <option value="一般">一般</option>
              <option value="较大">较大</option>
              <option value="重大">重大</option>
            </select>
          </label>
          <label class="form-wide">
            <span>备注</span>
            <input v-model="reportFireForm.备注" />
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeReport">取消</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="submitReport">提交火情</button>
        </div>
        <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ filteredTasks.length }} 条巡护任务</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  cancelTask,
  completeTask,
  listCrews,
  listTasks,
  reportFire,
  startTask,
  type CrewSummary,
} from '@/api/patrol-service'
import type { PatrolTaskView } from '@/data/patrol/types'

const statuses = ['待执行', '执行中', '已完成', '已取消']

const tasks = ref<PatrolTaskView[]>([])
const crews = ref<CrewSummary[]>([])
const keyword = ref('')
const statusFilter = ref('')
const errorMessage = ref('')
const submitting = ref(false)

const completing = ref<PatrolTaskView | null>(null)
const completeFires = ref<{ 起火地点: string; 火势等级: string; 备注: string }[]>([])
const reporting = ref<PatrolTaskView | null>(null)
const reportFireForm = ref({ 起火地点: '', 火势等级: '一般', 备注: '' })

const filteredTasks = computed(() => {
  const key = keyword.value.trim()
  return tasks.value.filter((row) => {
    const hitStatus = statusFilter.value === '' || row.status === statusFilter.value
    const hitKey =
      key === '' ||
      [row.任务编号, row.巡护区域, row.巡护员, row.班组].some((value) => String(value).includes(key))
    return hitStatus && hitKey
  })
})

const stats = computed(() => [
  { label: '任务总数', value: tasks.value.length },
  { label: '执行中', value: tasks.value.filter((row) => row.status === '执行中').length },
  { label: '已完成', value: tasks.value.filter((row) => row.status === '已完成').length },
  { label: '有效火情', value: tasks.value.reduce((sum, row) => sum + row.fireCount, 0) },
])

function reload() {
  errorMessage.value = ''
  tasks.value = listTasks()
  crews.value = listCrews()
}

function resetFilters() {
  keyword.value = ''
  statusFilter.value = ''
}

function start(row: PatrolTaskView) {
  const result = startTask(row.id, row.version)
  if (!result.ok) errorMessage.value = result.message
  reload()
}

function cancel(row: PatrolTaskView) {
  const result = cancelTask(row.id, row.version)
  if (!result.ok) errorMessage.value = result.message
  reload()
}

function openComplete(row: PatrolTaskView) {
  completing.value = row
  completeFires.value = []
  errorMessage.value = ''
}

function closeComplete() {
  completing.value = null
}

function addFire() {
  completeFires.value.push({ 起火地点: '', 火势等级: '一般', 备注: '' })
}

function submitComplete() {
  if (!completing.value) return
  const validFires = completeFires.value.filter((fire) => fire.起火地点.trim() !== '')
  submitting.value = true
  const result = completeTask(completing.value.id, completing.value.version, { fires: validFires })
  submitting.value = false
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  closeComplete()
  reload()
}

function openReport(row: PatrolTaskView) {
  reporting.value = row
  reportFireForm.value = { 起火地点: '', 火势等级: '一般', 备注: '' }
  errorMessage.value = ''
}

function closeReport() {
  reporting.value = null
}

function submitReport() {
  if (!reporting.value) return
  if (reportFireForm.value.起火地点.trim() === '') {
    errorMessage.value = '请填写起火地点'
    return
  }
  submitting.value = true
  const result = reportFire(reporting.value.id, reporting.value.version, { ...reportFireForm.value })
  submitting.value = false
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  closeReport()
  reload()
}

onMounted(reload)
</script>
