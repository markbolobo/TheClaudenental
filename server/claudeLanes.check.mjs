// 執行道機檢：`node claudeLanes.check.mjs`（或 `npm run check:lanes`）
//
// 少爺 2026-10-05「為什麼 TC 跨聊天室的操作又在排隊，而不是並行」。當天壞掉的三件事釘成回歸測試：
//   1. 執行中表與隊伍以專案路徑為鍵 → 同專案不同聊天室互相排隊（實錄最久等 72 分鐘）
//   2. QA 喚醒心跳斷的無頭補送遇到「專案有別室在跑」直接 return → 603e640e／966a3d51 的留言喚醒被吃掉
//   3. done／stderr 事件沒帶 sessionId → 並行時每個聊天室面板都以為自己跑完了
// 前半驗 claudeLanes.js 的記帳規則，後半掃 index.js／ChatPanel.jsx 防止日後又把閘門改回專案層。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createLaneRegistry, createRefCountSet } from './claudeLanes.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0

function ok(InCond, InLabel, InDetail = '') {
  if (InCond) { pass++; console.log(`  ✅ ${InLabel}`) }
  else { fail++; console.log(`  ❌ ${InLabel} ${InDetail}`) }
}

const PROJ = 'C:\\Project\\RomanPrototype'
const fakeEntry = (InSid, InProject = PROJ) => ({ proc: null, sessionId: InSid, projectPath: InProject, status: 'running' })

console.log('\n[1] 跨聊天室並行、同聊天室排隊')
{
  const L = createLaneRegistry()
  const a = fakeEntry('sess-a')
  L.register(a)
  ok(L.isSessionBusy('sess-a'), 'A 在跑 → A 忙碌')
  ok(!L.isSessionBusy('sess-b'), '同專案的 B 不受 A 影響（可直接並行）')
  L.register(fakeEntry('sess-b'))
  ok(L.runningInProject('c:/project/romanprototype/').length === 2, '同專案兩室同時在跑（路徑大小寫／斜線不同也算同專案）')
  const q1 = L.enqueue('sess-a', { projectPath: PROJ, prompt: '第一則' })
  ok(q1.pos === 1 && !q1.coalesced, 'A 忙碌時新請求排進 A 自己的隊伍')
  ok(L.dequeue('sess-a') === null, 'A 還在跑 → 不出隊')
  ok(L.queueLength('sess-b') === 0, 'A 的隊伍不影響 B')
  a.status = 'done'
  const n = L.dequeue('sess-a')
  ok(n?.prompt === '第一則', 'A 結束 → 出隊 A 的下一則')
  ok(L.queueLength('sess-a') === 0, '出隊後隊伍清空')
}

console.log('\n[2] 2026-10-05 實錄重播：6795e773 在跑時，其他三室的 QA 留言喚醒')
{
  const L = createLaneRegistry()
  L.register(fakeEntry('6795e773'))
  const _others = ['86529bb3', '037c6f80', '53f7a02b']
  ok(_others.every(s => !L.isSessionBusy(s)), '三室都判為可直接起跑（舊版三則都排隊，分別等 15／36／72 分鐘）')
}

console.log('\n[3] QA 喚醒併入同室已排的一則')
{
  const L = createLaneRegistry()
  L.register(fakeEntry('sess-q'))
  L.enqueue('sess-q', { projectPath: PROJ, prompt: '留言' })
  const r = L.enqueue('sess-q', { projectPath: PROJ, prompt: '結案' }, { coalesce: true, coalesceSeparator: '\n\n(追加喚醒) ' })
  ok(r.coalesced && L.queueLength('sess-q') === 1, '第二則喚醒併入、不堆成兩個回合')
  L.entries()[0].status = 'done'
  ok(L.dequeue('sess-q')?.prompt === '留言\n\n(追加喚醒) 結案', '併入後內容兩則都在')
  const r2 = L.enqueue('sess-q', { projectPath: PROJ, prompt: '空隊伍' }, { coalesce: true })
  ok(!r2.coalesced && r2.pos === 1, '隊伍空的時候 coalesce 退回一般排隊')
}

console.log('\n[4] 新聊天室：暫時道名 → init 改掛真 id')
{
  const L = createLaneRegistry()
  const e = fakeEntry(null)
  const key = L.register(e)
  ok(key.startsWith('new:'), '沒有 session id 掛暫時道名')
  ok(L.pendingInitInProject(PROJ).length === 1, '尚未 init 的新聊天室查得到（停止鈕沒帶 id 時用）')
  L.adopt(e, 'sess-new')
  ok(L.isSessionBusy('sess-new') && L.runningEntry('sess-new') === e, 'init 後以真 id 判忙碌')
  ok(L.pendingInitInProject(PROJ).length === 0, 'init 後不再算未 init')
  ok(L.entries().length === 1, '改掛後不留下暫時道名的殘影')
  let threw = false
  try { L.enqueue(null, { projectPath: PROJ, prompt: 'x' }) } catch { threw = true }
  ok(threw, '沒有 session id 不准排隊（新聊天室一律並行）')
}

console.log('\n[5] 進程換手與石沉重試保留')
{
  const L = createLaneRegistry()
  const old = fakeEntry('sess-r')
  L.register(old)
  old.status = 'done'
  const fresh = fakeEntry('sess-r')
  L.register(fresh)
  L.release(old)
  ok(L.runningEntry('sess-r') === fresh, '舊進程 10 秒後的移出不會刪掉同室的新進程')
  fresh.status = 'done'
  L.hold('sess-r')
  ok(L.isSessionBusy('sess-r'), '石沉重試在途 → 視同忙碌（新請求排隊，不搶同一個交接縫隙）')
  L.enqueue('sess-r', { projectPath: PROJ, prompt: '重試空窗進來的' })
  ok(L.dequeue('sess-r') === null, '保留期間不出隊')
  L.unhold('sess-r')
  ok(L.dequeue('sess-r')?.prompt === '重試空窗進來的', '解除保留後照常出隊')
}

console.log('\n[6] 計數式 pendingSpawnCwds')
{
  const S = createRefCountSet()
  S.add('c:/project/romanprototype'); S.add('c:/project/romanprototype')
  S.delete('c:/project/romanprototype')
  ok(S.has('c:/project/romanprototype'), '同 cwd 並行兩個，先 init 的那個釋放後仍在登記中')
  S.delete('c:/project/romanprototype')
  ok(!S.has('c:/project/romanprototype'), '兩個都釋放才移除')
  S.delete('c:/project/romanprototype')
  ok(!S.has('c:/project/romanprototype'), '多釋放一次不會變負數殘留')
}

console.log('\n[7] index.js 靜態掃描：閘門不得回到專案層')
{
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')
  ok(!/\bclaudeProcs\b|\bclaudeRunQueue\b/.test(src), '舊的專案路徑鍵執行表／隊伍已不存在')

  // 直接呼叫 spawnClaude 只能開新聊天室（第三個引數 null）；續聊既有聊天室必經 runOrQueueForSession
  const _allowed = [/next\.projectPath, next\.prompt, InSessionId/, /InProjectPath, InPrompt, InSessionId/, /retryCount \+ 1/]
  const _bad = []
  for (const [i, line] of src.split(/\r?\n/).entries()) {
    if (!line.includes('spawnClaude(') || line.includes('function spawnClaude')) continue
    if (_allowed.some(re => re.test(line))) continue
    const _args = line.slice(line.indexOf('spawnClaude(') + 'spawnClaude('.length).split(',').map(s => s.trim())
    if (_args[2] !== 'null') _bad.push(`L${i + 1}: ${line.trim()}`)
  }
  ok(_bad.length === 0, '直接 spawnClaude 的呼叫端都是開新聊天室', `\n      ${_bad.join('\n      ')}`)

  // 專案層判斷只准出現在：並行紀錄、提交類閘門（避免把別人改到一半的檔案包進 commit）
  const _projGates = src.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('runningInProject('))
  const _strayGates = _projGates.filter(([, l]) => !/claude\.lane\.parallel|_parallel = |可能正在改檔/.test(l))
  ok(_strayGates.length === 0, '專案層判斷只用在並行紀錄與提交類閘門', `\n      ${_strayGates.map(([n, l]) => `L${n}: ${l.trim()}`).join('\n      ')}`)

  const _fallback = src.slice(src.indexOf('const _doHeadlessFallback'), src.indexOf('const _doHeadlessFallback') + 2000)
  ok(_fallback.includes('runOrQueueForSession(') && !/status === 'running'\) return/.test(_fallback), 'QA 心跳斷補送走同室排隊、沒有「有人在跑就 return」')

  ok(/event: \{ type: 'done'/.test(src) && /sessionId: entry\.sessionId \?\? null, event: \{ type: 'done'/.test(src), 'done 事件帶 sessionId')
  ok(/sessionId: entry\.sessionId \?\? null, event: \{ type: 'stderr'/.test(src), 'stderr 事件帶 sessionId')
}

console.log('\n[8] ChatPanel.jsx 靜態掃描')
{
  const src = fs.readFileSync(path.join(HERE, '..', 'client', 'src', 'ChatPanel.jsx'), 'utf8')
  const _stop = src.slice(src.indexOf('function handleStop'), src.indexOf('function handleStop') + 600)
  ok(/sessionId: sessionId \?\? null/.test(_stop), '停止鈕帶 sessionId（只停本聊天室）')
  ok(/runningRef\.current && !sessionId\)/.test(src), '新聊天室 init 前的第二則先留著、不另開聊天室')
  const _eff = src.slice(src.indexOf('從佇列取出下一筆送出'), src.indexOf('從佇列取出下一筆送出') + 700)
  ok(/setTimeout\(\(\) => \{\s*const \[next, \.\.\.rest\] = pendingQueue/.test(_eff), '佇列在計時觸發當下才出列（避免 cleanup 清掉計時＝訊息消失）')
}

console.log(`\n結果：${pass} 通過、${fail} 失敗`)
process.exit(fail ? 1 : 0)
