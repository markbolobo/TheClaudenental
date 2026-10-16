// 用量中斷自動續接機檢：`node usageInterrupts.check.mjs`（或 `npm run check:usage`）
//
// 少爺 2026-10-10：Token 用完使工作中斷時自動辨識，帳號停止會籍就不切換、等原帳號冷卻到了自動繼續；
// 自動續接要能關（主帳號有他人共用）。前半驗純判斷，後半掃 index.js 確認接線（hook 端點、掃描、開關、投遞走既有入口）。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { classifyApiError, isWeeklyLimit, parseResetText, inQuietHours, resolveAutoResumeSettings, decideAction, pickBatch, resumePrompt, isAutoSwitchThrashing, recordsToReattribute, AUTO_RESUME_DEFAULTS } from './usageInterrupts.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0

function ok(InCond, InLabel, InDetail = '') {
  if (InCond) { pass++; console.log(`  ✅ ${InLabel}`) }
  else { fail++; console.log(`  ❌ ${InLabel} ${InDetail}`) }
}

console.log('\n[1] 錯誤分類')
ok(classifyApiError({ error: 'rate_limit', apiError: 'usage_limit_reached', text: "You've hit your session limit · resets 6pm (Asia/Taipei)" }).kind === 'usage_limit', '逐字稿合成訊息（usage_limit_reached）＝用量上限')
ok(classifyApiError({ error: 'rate_limit', last_assistant_message: "You've hit your weekly limit · resets Mon 12:00am" }).kind === 'usage_limit', 'StopFailure rate_limit＋週上限文字＝用量上限')
ok(classifyApiError({ error: 'rate_limit' }).kind === 'usage_limit', '只有 rate_limit 也當用量上限')
ok(classifyApiError({ error: 'rate_limit', last_assistant_message: 'Server is temporarily limiting requests (not your usage limit)' }).kind === 'transient', '「not your usage limit」＝短暫，不是用量')
for (const e of ['billing_error', 'account_on_hold', 'authentication_failed', 'oauth_org_not_allowed'])
  ok(classifyApiError({ error: e }).kind === 'account_unavailable', `${e}＝帳號不可用（永不自動續接）`)
ok(classifyApiError({ error: 'unknown', last_assistant_message: "You've hit your monthly spend limit" }).kind === 'account_unavailable', '月花費上限＝帳號不可用')
ok(classifyApiError({ error: 'overloaded' }).kind === 'transient', 'overloaded＝短暫')
ok(classifyApiError({ error: 'invalid_request' }).kind === 'other', 'invalid_request＝其他（不處理）')

console.log('\n[2] 週上限判定')
ok(isWeeklyLimit('seven_day', ''), 'rateLimitType seven_day')
ok(!isWeeklyLimit('five_hour', "hit your weekly limit"), 'rateLimitType 優先於文字')
ok(isWeeklyLimit(null, "You've hit your weekly limit · resets Mon"), '沒有類型時看文字')

console.log('\n[3] 重設時間解析（本機時區）')
const NOW = new Date(2026, 9, 10, 14, 30, 0)   // 週六 14:30
const at = (t) => parseResetText(t, NOW)
ok(at('resets 6pm (Asia/Taipei)')?.getHours() === 18 && at('resets 6pm').getDate() === 10, '「resets 6pm」＝今天 18:00')
ok(at('resets 3:45pm')?.getHours() === 15 && at('resets 3:45pm').getMinutes() === 45, '「resets 3:45pm」')
ok(at('resets 2pm')?.getDate() === 11, '已過的時刻＝明天')
ok(at('resets 15:45')?.getHours() === 15, '24 小時制')
ok(at('resets Mon 12:00am')?.getDay() === 1 && at('resets Mon 12:00am').getHours() === 0, '「resets Mon 12:00am」＝下週一 0 點')
ok(Math.round((at('resets in 2h 10m') - NOW) / 60000) === 130, '「resets in 2h 10m」')
ok(at('no time here') === null, '解析不到回 null')

console.log('\n[4] 安靜時段')
ok(inQuietHours('09:00', '18:00', NOW), '09–18 內')
ok(!inQuietHours('20:00', '08:00', NOW), '跨午夜 20–08 外')
ok(inQuietHours('20:00', '08:00', new Date(2026, 9, 10, 23, 0)), '跨午夜 20–08 內')
ok(!inQuietHours(null, '08:00', NOW), '未設＝沒有安靜時段')

console.log('\n[5] 開關與預設（少爺 2026-10-12：預設自動續接、週上限也續接）')
const S0 = resolveAutoResumeSettings(() => undefined)
ok(S0.enabled === true && AUTO_RESUME_DEFAULTS.enabled === true, '未設定＝自動續接開')
ok(S0.maxPerBatch === 3 && S0.batchGapSec === 90, '批量 3、間隔 90 秒')
ok(S0.weeklyLimitAutoResume === true, '週上限預設也自動續接')
const SOFF = resolveAutoResumeSettings(k => ({ 'usage.autoResume.enabled': false, 'usage.autoResume.weeklyLimitAutoResume': false })[k])
const S1 = resolveAutoResumeSettings(k => ({ 'usage.autoResume.enabled': true, 'usage.autoResume.maxPerBatch': 5 })[k])
ok(S1.enabled && S1.maxPerBatch === 5, '設定值生效')

console.log('\n[6] 到點決策')
const T = NOW.getTime()
const rec = (o = {}) => ({ status: 'waiting', kind: 'usage_limit', resetAt: T - 5 * 60000, weekly: false, excluded: false, ...o })
const on = { ...S1 }
ok(decideAction({ record: rec({ resetAt: T + 60000 }), now: T, settings: on, deliverable: true }) === 'wait', '未到點＝等')
ok(decideAction({ record: rec({ resetAt: T - 30000 }), now: T, settings: on, deliverable: true }) === 'wait', '剛過重設但在緩衝內＝等')
ok(decideAction({ record: rec(), now: T, settings: on, deliverable: true, resumedSelf: true }) === 'resolved_self', '已自己接上＝不重複送')
ok(decideAction({ record: rec(), now: T, settings: SOFF, deliverable: true }) === 'notify_off', '開關手動關＝只通知')
ok(decideAction({ record: rec({ weekly: true }), now: T, settings: S0, deliverable: true }) === 'resume', '預設：週上限重設後也續接')
ok(decideAction({ record: rec({ excluded: true }), now: T, settings: on, deliverable: true }) === 'notify_excluded', '被排除的聊天室＝只通知')
ok(decideAction({ record: rec({ weekly: true }), now: T, settings: { ...on, weeklyLimitAutoResume: false }, deliverable: true }) === 'notify_weekly', '週上限續接手動關＝只通知')
ok(decideAction({ record: rec(), now: T, settings: { ...on, quietStart: '09:00', quietEnd: '18:00' }, deliverable: true }) === 'hold_quiet', '安靜時段＝延後')
ok(decideAction({ record: rec(), now: T, settings: on, deliverable: false }) === 'notify_undeliverable', '分頁開著投不進去＝只通知（不另起無頭雙寫）')
ok(decideAction({ record: rec(), now: T, settings: on, deliverable: true }) === 'resume', '全部條件成立＝續接')
ok(decideAction({ record: rec({ kind: 'account_unavailable' }), now: T, settings: on, deliverable: true }) === 'none', '帳號不可用＝永不續接')
ok(decideAction({ record: rec({ status: 'resumed' }), now: T, settings: on, deliverable: true }) === 'none', '已處理過＝不動')

console.log('\n[7] 分批與訊息')
const b = pickBatch([{ id: 'c', interruptedAt: 3 }, { id: 'a', interruptedAt: 1 }, { id: 'b', interruptedAt: 2 }], 2)
ok(b.map(x => x.id).join('') === 'ab', '最早中斷的先接、最多 N 筆')
const p = resumePrompt({ resetAt: T })
ok(p.includes('TC 自動續接') && p.includes('先確認目前狀態'), '續接訊息提醒先確認現況')
ok(!p.includes('不要掛 Monitor') && resumePrompt({ resetAt: T }, NOW, true).includes('不要掛 Monitor'), '無頭續接才加「不要掛監看、做完就結束」（2026-10-10 實測 7 室陷入監看重掛循環）')

console.log('\n[8] index.js 接線')
const SRC = fs.readFileSync(path.join(HERE, 'index.js'), 'utf-8')
ok(SRC.includes("app.post('/hook/StopFailure'"), 'StopFailure hook 端點')
ok(/usage\.autoResume|resolveAutoResumeSettings\(/.test(SRC), '讀總設定開關')
ok(SRC.includes("app.get('/api/usage/interrupts'"), '中斷清單 API')
ok(SRC.includes("/api/usage/interrupts/:sid/resume"), '手動立即續接 API')
ok(/inject\(\{\s*method:\s*'POST',\s*url:\s*'\/api\/claude\/run'/.test(SRC), '續接走既有 /api/claude/run（直投→監看→無頭同一套）')
ok(SRC.includes('scanTranscriptsForUsageLimits'), '逐字稿掃描（舊聊天室沒載入新 hook 也抓得到）')
// 2026-10-10 實測抓到：只有 hook、逐字稿沒有錯誤合成訊息時，曾把「找不到錯誤」誤判成「已自行接上」而沒續接
const _selfFn = SRC.slice(SRC.indexOf('function usageResumedSelf'), SRC.indexOf('function usageDeliverable'))
ok(_selfFn.length > 0 && !/if \(!_last\) return true/.test(_selfFn) && _selfFn.includes('InRecord.interruptedAt && ('), '逐字稿沒有錯誤訊息時改看中斷後有無新對話（不可直接當已接上）')
// 2026-10-12 少爺抓到：預設自動續接後，TC 自己的主題標籤器單次工作（tc-tagger）被當聊天室續接 ⇒ 必然「送達但沒動」
const _recFn = SRC.slice(SRC.indexOf('function recordUsageInterrupt'), SRC.indexOf('function recordUsageInterrupt') + 400)
ok(/function isTcInternalSession[\s\S]{0,200}tc-tagger\|tc-companion/.test(SRC), 'TC 內部工作判斷涵蓋標籤器與陪聊')
ok(_recFn.includes('isTcInternalSession('), '建立中斷紀錄前排除 TC 內部工作（hook 與掃描兩條路共用）')
ok(/\/tc-tagger\|tc-companion\/i\.test\(_d\)/.test(SRC), '逐字稿掃描排除標籤器與陪聊工作目錄')
ok(/usageInterruptTick[\s\S]{0,400}dismissTcInternalInterrupts\(\)/.test(SRC), '每輪收掉舊版記進來的 TC 內部工作紀錄')

// ── 換帳號續接空轉（2026-10-13 19:09～19:22 同一室 15 分鐘被換帳號續接 7 次）
const _NOW = 10_000_000
ok(!isAutoSwitchThrashing({ history: [] }, _NOW), '沒有續接紀錄＝不算空轉')
ok(!isAutoSwitchThrashing({ history: [{ at: _NOW - 60_000, reason: 'auto_switch' }] }, _NOW), '十分鐘內只換帳號續接過 1 次＝還可以再試')
ok(isAutoSwitchThrashing({ history: [{ at: _NOW - 300_000, reason: 'auto_switch' }, { at: _NOW - 60_000, reason: 'auto_switch' }] }, _NOW), '十分鐘內換帳號續接 2 次又撞上限＝空轉，改等重設')
ok(!isAutoSwitchThrashing({ history: [{ at: _NOW - 900_000, reason: 'auto_switch' }, { at: _NOW - 60_000, reason: 'auto_switch' }] }, _NOW), '超過十分鐘的舊續接不算')
ok(!isAutoSwitchThrashing({ history: [{ at: _NOW - 300_000, reason: 'auto' }, { at: _NOW - 60_000, reason: 'manual' }] }, _NOW), '一般續接與手動續接不算換帳號空轉')
ok(/const _isOtherAccount = r => [^\n]*!isAutoSwitchThrashing\(r, _now\)/.test(SRC), '每輪判斷「別的帳號撞的」時排除空轉中的紀錄')

// ── 外部切換回溯（2026-10-13 20:19：切換點之後算給舊帳號的中斷要改歸新帳號）
const _EXT = { at: 1925, from: 'SASO', to: 'MAXU' }
const _recs = [{ sessionId: 'a', accountUuid: 'SASO', interruptedAt: 1900 }, { sessionId: 'b', accountUuid: 'SASO', interruptedAt: 2019 }, { sessionId: 'c', accountUuid: 'MAXU', interruptedAt: 2030 }, { sessionId: 'd', accountUuid: 'SASO', interruptedAt: 1925 }]
ok(recordsToReattribute(_recs, _EXT).map(r => r.sessionId).join('') === 'bd', '切換點（含）之後、記在原帳號名下的中斷才改歸新帳號；之前的與本來就對的不動')
ok(recordsToReattribute(_recs, { at: 1925, from: null, to: 'MAXU' }).length === 0 && recordsToReattribute(_recs, { at: 1, from: 'SASO', to: 'SASO' }).length === 0, '沒有來源帳號或前後同一帳號＝不改')
const _early = resumePrompt({ resetAt: Date.UTC(2030, 0, 1) }, new Date(Date.UTC(2029, 0, 1)))
ok(_early.includes('已提前續接') && !_early.includes('已於'), '重設時間還沒到就續接（手動或換了帳號）＝不說「已重設」（10-13 23:38 手動續接 9 室時誤寫成「已於 00:20 重設」）')
ok(resumePrompt({ resetAt: Date.UTC(2026, 0, 1) }, new Date(Date.UTC(2027, 0, 1))).includes('已於'), '重設時間已過＝照舊說已重設')

console.log(`\n結果：${pass} 通過，${fail} 失敗`)
process.exit(fail > 0 ? 1 : 0)
