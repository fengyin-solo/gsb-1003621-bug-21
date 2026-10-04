import assert from 'node:assert/strict'
import { build } from 'esbuild'

// ---- 最小 localStorage / window 桩 ----
class MemoryStorage {
  constructor() { this.map = new Map() }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(key, String(value)) }
  removeItem(key) { this.map.delete(key) }
  clear() { this.map.clear() }
}

function makeWindow() {
  return {
    localStorage: new MemoryStorage(),
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) },
    removeEventListener() {},
    dispatchEvent(event) {
      ;(this.listeners[event.type] || []).forEach((fn) => fn(event))
    },
  }
}

let bundleCache = null
async function bundleCode() {
  if (bundleCache) return bundleCache
  const result = await build({
    entryPoints: ['src/api/patrol-service.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  })
  bundleCache = result.outputFiles[0].text
  return bundleCache
}

// 每次导入都是全新模块实例（模拟页面加载）；传入同一个 window 即模拟刷新后读到同一存储
async function loadApp(windowRef) {
  const win = windowRef ?? makeWindow()
  globalThis.window = win
  globalThis.CustomEvent = class {
    constructor(type) { this.type = type }
  }
  const code = await bundleCode()
  const blob = `data:text/javascript;base64,${Buffer.from(`${code}\n//# nonce=${Math.random()}`).toString('base64')}`
  return { mod: await import(blob), windowRef: win }
}

let passed = 0
async function test(name, fn) {
  const { mod, windowRef } = await loadApp()
  await fn(mod, windowRef)
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function run() {
  await test('历史任务按原巡护日期迁移，状态与执行记录一致', (mod) => {
    const tasks = mod.listTasks()
    assert.equal(tasks.length, 3)
    const [p3, p2, p1] = tasks // 按日期倒序
    assert.equal(p1.code, 'PATR-0001')
    assert.equal(p1.status, '待执行')
    assert.equal(p1.patrolDate, '2026-09-01')
    assert.equal(p1.period, '08:00-17:00')
    assert.equal(p1.fireCount, 0)
    assert.equal(p2.status, '执行中')
    assert.equal(p3.status, '已完成')
    assert.equal(p3.fireCount, 2, '历史完成任务火情数按原值补齐并回写')
    // 执行记录为权威：完成任务有 登记/开始/完成 三条，且日期沿用原巡护日期
    const detail = mod.getTask(p3.id)
    assert.deepEqual(detail.records.map((r) => r.action), ['登记', '开始巡护', '确认完成'])
    assert.ok(detail.records[0].operatedAt.startsWith('2026-09-03'))
    assert.equal(detail.records[2].fireCount, 2)
    assert.equal(detail.alerts.length, 2)
  })

  await test('脏数据迁移可补值：占位文本火情数补0、日期型时段补白班', async () => {
    const win = makeWindow()
    win.localStorage.setItem('forest-fire-patrol:entries', JSON.stringify({
      patrol: [{
        id: 9, status: '执行中', pending: true, abnormal: true,
        任务编号: 'PATR-0009', 巡护区域: '脏数据沟', 巡护路线: 'X', 巡护员: '赵某',
        巡护日期: '2026-09-09', 巡护时段: '2026-09-09', 发现火情数: '巡护任务样例9', 任务状态: '随便写的旧状态',
      }],
    }))
    const { mod } = await loadApp(win)
    const tasks = mod.listTasks()
    assert.equal(tasks.length, 1)
    const t = tasks[0]
    assert.equal(t.status, '执行中')
    assert.equal(t.period, '08:00-17:00')
    assert.equal(t.fireCount, 0)
    assert.equal(t.patrolDate, '2026-09-09', '历史任务保留原巡护日期')
  })

  await test('状态只能单向推进：取消后不能确认完成，终态不可再操作', (mod) => {
    const pending = mod.listTasks().find((t) => t.status === '待执行')
    const cancel = mod.submitTaskAction({ taskId: pending.id, action: '取消任务', expectedVersion: pending.version })
    assert.equal(cancel.ok, true)
    // 旧视图再确认完成：版本先过期 -> 拒绝
    const stale = mod.submitTaskAction({ taskId: pending.id, action: '确认完成', expectedVersion: pending.version })
    assert.equal(stale.ok, false)
    // 新版本再确认完成：状态机拒绝
    const fresh = mod.getTask(pending.id)
    const again = mod.submitTaskAction({ taskId: pending.id, action: '确认完成', expectedVersion: fresh.version })
    assert.equal(again.ok, false)
    assert.match(again.message, /不能执行/)
    assert.equal(mod.submitTaskAction({ taskId: pending.id, action: '开始巡护', expectedVersion: fresh.version }).ok, false)
    // 已完成任务任何动作都拒绝
    const done = mod.listTasks().find((t) => t.status === '已完成')
    for (const action of ['开始巡护', '取消任务', '确认完成']) {
      assert.equal(mod.submitTaskAction({ taskId: done.id, action, expectedVersion: done.version }).ok, false)
    }
    // 执行中不能取消、不能重复开始
    const doing = mod.listTasks().find((t) => t.status === '执行中')
    assert.equal(mod.submitTaskAction({ taskId: doing.id, action: '取消任务', expectedVersion: doing.version }).ok, false)
    assert.equal(mod.submitTaskAction({ taskId: doing.id, action: '开始巡护', expectedVersion: doing.version }).ok, false)
    // 待执行不能跳过执行中直接完成
    const stillPending = mod.listTasks().find((t) => t.code === 'PATR-0001')
    assert.equal(mod.submitTaskAction({ taskId: stillPending.id, action: '确认完成', expectedVersion: stillPending.version }).ok, false)
  })

  await test('正常链路：开始 -> 完成(火情数) 同事务落库，任务与火情台账同步', (mod) => {
    const pending = mod.listTasks().find((t) => t.status === '待执行')
    const start = mod.submitTaskAction({ taskId: pending.id, action: '开始巡护', expectedVersion: pending.version })
    assert.equal(start.ok, true)
    assert.equal(start.task.status, '执行中')
    const doing = mod.getTask(pending.id)
    const finish = mod.submitTaskAction({
      taskId: doing.id, action: '确认完成', expectedVersion: doing.version, fireCount: 3,
    })
    assert.equal(finish.ok, true)
    const done = mod.getTask(pending.id)
    assert.equal(done.status, '已完成')
    assert.equal(done.fireCount, 3, '火情数回写任务')
    assert.equal(done.alerts.length, 3)
    assert.ok(done.alerts.every((a) => a.status === '待核实' && a.active))
    const taskRows = mod.listFireLedger().filter((r) => r.source === '巡护任务')
    assert.equal(taskRows.length, 5, '历史2起 + 新3起')
  })

  await test('两端并发提交：同版本第二次写入被拒绝', (mod) => {
    const pending = mod.listTasks().find((t) => t.status === '待执行')
    assert.equal(mod.submitTaskAction({ taskId: pending.id, action: '开始巡护', expectedVersion: pending.version }).ok, true)
    const second = mod.submitTaskAction({ taskId: pending.id, action: '开始巡护', expectedVersion: pending.version })
    assert.equal(second.ok, false)
    assert.match(second.message, /另一端|版本/)
    const current = mod.getTask(pending.id)
    const c1 = mod.submitTaskAction({ taskId: pending.id, action: '确认完成', expectedVersion: current.version, fireCount: 1 })
    assert.equal(c1.ok, true)
    const c2 = mod.submitTaskAction({ taskId: pending.id, action: '确认完成', expectedVersion: current.version, fireCount: 1 })
    assert.equal(c2.ok, false)
    assert.equal(mod.getTask(pending.id).alerts.length, 1, '被并发拒绝的完成不会多写火情提醒')
  })

  await test('非法火情数导致整体退回：任务仍停留执行中，不产生半条提醒', (mod) => {
    const pending = mod.listTasks().find((t) => t.status === '待执行')
    mod.submitTaskAction({ taskId: pending.id, action: '开始巡护', expectedVersion: pending.version })
    const doing = mod.getTask(pending.id)
    for (const fireCount of [-1, 1.5]) {
      const r = mod.submitTaskAction({ taskId: doing.id, action: '确认完成', expectedVersion: doing.version, fireCount })
      assert.equal(r.ok, false, `${fireCount} 应被拒绝`)
    }
    const after = mod.getTask(pending.id)
    assert.equal(after.status, '执行中', '失败后任务状态不变')
    assert.equal(after.version, doing.version, '失败后版本号不自增')
    assert.equal(after.alerts.length, 0, '失败不产生火情提醒')
  })

  await test('撤回火情：火情数核减、提醒终态、撤回入执行记录，任务状态不残留', (mod) => {
    const pending = mod.listTasks().find((t) => t.status === '待执行')
    mod.submitTaskAction({ taskId: pending.id, action: '开始巡护', expectedVersion: pending.version })
    const doing = mod.getTask(pending.id)
    mod.submitTaskAction({ taskId: doing.id, action: '确认完成', expectedVersion: doing.version, fireCount: 2 })
    const done = mod.getTask(pending.id)
    assert.equal(done.status, '已完成')
    const alertId = done.alerts[0].id
    const versionBefore = done.version
    const r = mod.withdrawFireAlert({ alertId, expectedTaskVersion: done.version, note: '复核为烧荒积烟' })
    assert.equal(r.ok, true)
    const after = mod.getTask(pending.id)
    assert.equal(after.status, '已完成', '撤回不改变任务终态')
    assert.equal(after.fireCount, 1, '火情数核减')
    assert.equal(after.version, versionBefore + 1)
    const withdrawn = after.alerts.find((a) => a.id === alertId)
    assert.equal(withdrawn.status, '已撤回')
    assert.equal(withdrawn.active, false)
    assert.match(withdrawn.withdrawNote, /烧荒积烟/)
    const last = after.records[after.records.length - 1]
    assert.equal(last.action, '火情撤回')
    assert.equal(last.statusAfter, '已完成', '撤回记录如实记下当时任务状态')
    assert.equal(mod.withdrawFireAlert({ alertId, expectedTaskVersion: after.version }).ok, false)
    const row = mod.listFireLedger().find((x) => x.alertId === alertId)
    assert.equal(row.status, '已撤回')
    assert.equal(row.active, false)
  })

  await test('撤回并发：任务版本过期则拒绝，火情与任务一起退回', (mod) => {
    const pending = mod.listTasks().find((t) => t.status === '待执行')
    mod.submitTaskAction({ taskId: pending.id, action: '开始巡护', expectedVersion: pending.version })
    const doing = mod.getTask(pending.id)
    mod.submitTaskAction({ taskId: doing.id, action: '确认完成', expectedVersion: doing.version, fireCount: 1 })
    const done = mod.getTask(pending.id)
    const alertId = done.alerts[0].id
    assert.equal(mod.withdrawFireAlert({ alertId, expectedTaskVersion: done.version }).ok, true)
    assert.equal(mod.withdrawFireAlert({ alertId, expectedTaskVersion: done.version }).ok, false)
  })

  await test('刷新/重新进入一致：新模块实例读到同一存储，口径完全相同', async () => {
    const { mod, windowRef } = await loadApp()
    const pending = mod.listTasks().find((t) => t.status === '待执行')
    mod.submitTaskAction({ taskId: pending.id, action: '开始巡护', expectedVersion: pending.version })
    const doing = mod.getTask(pending.id)
    mod.submitTaskAction({ taskId: doing.id, action: '确认完成', expectedVersion: doing.version, fireCount: 2 })
    const beforeWithdraw = mod.getTask(pending.id)
    mod.withdrawFireAlert({ alertId: beforeWithdraw.alerts[0].id, expectedTaskVersion: beforeWithdraw.version })

    // 同一 localStorage、全新模块实例：等同刷新页面
    const { mod: reloaded } = await loadApp(windowRef)
    const view = reloaded.getTask(pending.id)
    assert.equal(view.status, '已完成')
    assert.equal(view.fireCount, 1)
    const withdrawnAlert = view.alerts.find((a) => a.active === false)
    assert.equal(withdrawnAlert.status, '已撤回')
    const ledgerRow = reloaded.listFireLedger().find((r) => r.rowId === `task-${withdrawnAlert.id}`)
    assert.equal(ledgerRow.status, '已撤回')
    assert.equal(ledgerRow.active, false)
    // 新实例下并发保护仍生效：旧版本号不能再写
    assert.equal(
      reloaded.submitTaskAction({ taskId: pending.id, action: '确认完成', expectedVersion: 1, fireCount: 1 }).ok,
      false,
    )
  })

  await test('跨视图一致：列表状态、执行详情、台账对同一任务给出同一口径', (mod) => {
    const pending = mod.listTasks().find((t) => t.status === '待执行')
    mod.submitTaskAction({ taskId: pending.id, action: '开始巡护', expectedVersion: pending.version })
    const doing = mod.getTask(pending.id)
    mod.submitTaskAction({ taskId: doing.id, action: '确认完成', expectedVersion: doing.version, fireCount: 1 })
    const listRow = mod.listTasks().find((t) => t.id === pending.id)
    const detail = mod.getTask(pending.id)
    const ledgerCodes = mod.listFireLedger().filter((r) => r.taskId === pending.id).map((r) => r.code)
    assert.equal(listRow.status, detail.status)
    assert.equal(listRow.fireCount, detail.fireCount)
    assert.deepEqual(ledgerCodes, detail.alerts.map((a) => a.code))
    assert.equal(detail.status, detail.records[detail.records.length - 1].statusAfter)
  })

  console.log(`\n全部通过：${passed} 个用例`)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
