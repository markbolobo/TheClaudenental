// 預約結案機檢：`node qaCloseArm.check.mjs`（或 `npm run check:closearm`）
//
// 少爺 2026-10-05「如果我說 QA 進入{或是按下}結案，Run 進入已完成的狀態，就會自動補上（替我手按），讓 QA Run 進入已結案」。
// 前半驗留言意圖判斷（該預約的要預約、否定／疑問／單項留言不准預約），後半掃 index.js／QAMonitor.jsx
// 確認代按走的是跟 ✔ 結案鈕同一套動作、放在「任何 PATCH＝處理中」之後、而且會送出結案喚醒。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { commentIntendsClose, transitionCancelsArm, canArmInStatus } from './qaCloseArm.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0

function ok(InCond, InLabel, InDetail = '') {
  if (InCond) { pass++; console.log(`  ✅ ${InLabel}`) }
  else { fail++; console.log(`  ❌ ${InLabel} ${InDetail}`) }
}

console.log('\n[1] 留言表態結案 → 預約')
for (const t of ['目前驗收通過，可以結案', 'OK', 'ok', 'OK!', 'Okay', '結案', '可以結案了', '全部通過 結案吧', 'QA 進入結案',
  '沒問題可以結案', '不錯，直接結案', '不用改了直接結案', '第三項修好就結案'])
  ok(commentIntendsClose(t, null), `「${t}」`)

console.log('\n[2] 否定／疑問／單項 → 不預約')
for (const t of ['可以結案嗎？', '可以結案嗎', '要不要結案', '先不要結案', '別急著結案', '還不能結案，第3項有問題', '暫不結案',
  '結案了沒', '這樣 OK 嗎', '第2項 OK', '不行', '', '   ', '還沒要結案'])
  ok(!commentIntendsClose(t, null), `「${t}」`)
ok(!commentIntendsClose('OK', 3), '針對單一項目的「OK」＝該項通過，不是整輪結案')
ok(!commentIntendsClose('可以結案', 0), '項目 id 0 也算單項留言')

console.log('\n[3] 狀態轉換')
ok(transitionCancelsArm('running', 'announced'), '分支迴圈轉回待放行 → 預約作廢')
ok(transitionCancelsArm('running', 'aborted'), '中止 → 預約作廢')
ok(transitionCancelsArm('paused', 'countdown'), '轉進倒數中 → 預約作廢')
ok(!transitionCancelsArm('running', 'finished'), '推到已完成不作廢（這正是要代按的時機）')
ok(!transitionCancelsArm('announced', 'announced'), '狀態沒變不作廢')
ok(!transitionCancelsArm('paused', 'running'), '暫停後繼續不作廢')
ok(['announced', 'countdown', 'running', 'paused'].every(canArmInStatus), '進行中的狀態都能預約')
ok(!['finished', 'closed', 'aborted'].some(canArmInStatus), '已完成（當場代按）／已結案／已中止不預約')

console.log('\n[4] index.js 靜態掃描')
{
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')
  const _patch = src.slice(src.indexOf("app.patch('/api/qa/runs/:id'"), src.indexOf("app.post('/api/qa/runs/:id/events'"))
  const _control = src.slice(src.indexOf("app.post('/api/qa/runs/:id/control'"), src.indexOf("app.get('/api/qa/runs/:id/artifact'"))
  ok(_patch.length > 0 && _control.length > 0, '找得到 PATCH 與 control 端點')
  const _flip = _patch.indexOf("run.claudeAck.state = 'working'")
  const _auto = _patch.indexOf('const _autoClose =')
  ok(_flip > 0 && _auto > _flip, '代按放在「任何 PATCH＝處理中」之後（否則結案的「等待接手」當場被翻掉）')
  ok(/if \(_autoClose\) qaApplyClose\(run, _autoClose\)/.test(_patch), 'PATCH 代按走 qaApplyClose（與 ✔ 結案鈕同一套）')
  ok(/qaWakeBoundSession\(run, 'close'/.test(_patch), 'PATCH 代按會送出結案喚醒')
  ok(/transitionCancelsArm\(_prevStatus, run\.status\)/.test(_patch), 'PATCH 轉回待放行／中止會作廢預約')
  ok(/action === 'close'[\s\S]{0,200}qaApplyClose\(run\)/.test(_control), '✔ 結案鈕走 qaApplyClose')
  ok(/armClose === true \|\| commentIntendsClose\(text, itemId \?\? null\)/.test(_control), '留言會判斷預約（鈕帶 armClose 或內容表態）')
  const _disarm = _control.slice(_control.indexOf("action === 'disarm-close'"), _control.indexOf("action === 'disarm-close'") + 300)
  ok(_disarm.includes('return { ok: true, run }') && !_disarm.includes('qaWakeBoundSession'), '取消預約只動標記、不喚醒 Claude')
}

console.log('\n[5] QAMonitor.jsx 靜態掃描')
{
  const src = fs.readFileSync(path.join(HERE, '..', 'client', 'src', 'QAMonitor.jsx'), 'utf8')
  ok(/sendComment\('OK', \{ armClose: true \}\)/.test(src), '執行中 ✔ 結案鈕送 OK 並預約')
  ok(/control\('disarm-close'\)/.test(src), '已預約時有取消鈕')
  ok(/inPlaceLink: qaInPlaceLink, \.\.\.extra \}\)/.test(src), 'sendComment 會把預約旗標帶給 server')
}

console.log(`\n結果：${pass} 通過、${fail} 失敗`)
process.exit(fail ? 1 : 0)
