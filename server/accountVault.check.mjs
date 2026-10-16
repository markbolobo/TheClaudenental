// 用量上限自動換帳號機檢：`node accountVault.check.mjs`（或 `npm run check:accounts`）
//
// 少爺 2026-10-10：撞上限時自動換到另一個帳號、同一聊天室繼續（等同 VS Code 手動 Switch Account）；
// 不主動換回、只在中斷時檢查冷卻；換過去沒冷卻就直接續接；會籍停止的帳號永不切過去。
// 前半驗純判斷，後半掃 index.js 確認接線（權杖不外流、換走前先存回、續接走既有入口）。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { AUTO_SWITCH_DEFAULTS, resolveAutoSwitchSettings, accountStatus, pickSwitchTarget, decideSwitch, mergeCredentials, matchAccountByCredentials, liveOrganizationUuid, decideRevert, detectExternalSwitch, raiseCooling, rollbackCoolingSince, COOLING_LOG_MAX, accountRecordFrom, accountPublicView, parseLoginUrl } from './accountVault.js'
import { decideAction, resolveAutoResumeSettings, resumePrompt, recoverAuthFailedRecord } from './usageInterrupts.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0

function ok(InCond, InLabel, InDetail = '') {
  if (InCond) { pass++; console.log(`  ✅ ${InLabel}`) }
  else { fail++; console.log(`  ❌ ${InLabel} ${InDetail}`) }
}

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0)
const acc = (o = {}) => ({ accountUuid: 'a', organizationUuid: 'org-a', email: 'a@x', subscriptionType: 'max', refreshTokenExpiresAt: NOW + 86400000, coolingUntil: null, disabled: false, ...o })

console.log('\n[1] 帳號狀態')
ok(accountStatus(acc(), NOW) === 'available', '一般＝可用')
ok(accountStatus(acc({ coolingUntil: NOW + 60000 }), NOW) === 'cooling', '重設時間未到＝冷卻')
ok(accountStatus(acc({ coolingUntil: NOW - 1 }), NOW) === 'available', '重設時間已過＝可用')
ok(accountStatus(acc({ disabled: true }), NOW) === 'disabled', '停用（會籍停止、手動）＝不可用')
ok(accountStatus(acc({ refreshTokenExpiresAt: NOW - 1 }), NOW) === 'expired', '登入期限過了＝要重新加入')
ok(accountStatus(acc({ subscriptionType: 'free' }), NOW) === 'unusable', '不是付費訂閱＝不切過去')

console.log('\n[2] 換到哪個')
const A = acc({ accountUuid: 'a', coolingUntil: NOW + 3600000 })
const B = acc({ accountUuid: 'b', organizationUuid: 'org-b', email: 'b@x' })
const C = acc({ accountUuid: 'c', organizationUuid: 'org-c', disabled: true })
ok(pickSwitchTarget([A, B, C], 'a', NOW)?.accountUuid === 'b', '跳過自己與停用的帳號')
ok(pickSwitchTarget([A, C], 'a', NOW) === null, '沒有可用帳號＝null（照第一階段等重設）')
ok(pickSwitchTarget([A, acc({ accountUuid: 'b', organizationUuid: 'org-b', lastActiveAt: 500 }), acc({ accountUuid: 'd', organizationUuid: 'org-d', lastActiveAt: 100 })], 'a', NOW)?.accountUuid === 'd', '多個可用＝挑最久沒用的')

console.log('\n[3] 要不要換（少爺定：不主動換回，只在目前帳號冷卻或停用時換）')
const ON = { ...AUTO_SWITCH_DEFAULTS, enabled: true }
ok(resolveAutoSwitchSettings(() => undefined).enabled === false && AUTO_SWITCH_DEFAULTS.enabled === false, '未設定＝自動換帳號關')
ok(resolveAutoSwitchSettings(k => (k === 'usage.autoSwitch.enabled' ? true : undefined)).enabled === true, '總設定 usage.autoSwitch.enabled 生效')
ok(decideSwitch({ accounts: [A, B], activeUuid: 'a', now: NOW, settings: { ...ON, enabled: false }, lastSwitchAt: 0 }).action === 'none', '開關關＝不換')
ok(decideSwitch({ accounts: [acc(), B], activeUuid: 'a', now: NOW, settings: ON, lastSwitchAt: 0 }).action === 'none', '目前帳號沒冷卻＝不換（不主動換回）')
ok(decideSwitch({ accounts: [A, B], activeUuid: 'a', now: NOW, settings: ON, lastSwitchAt: 0 }).target?.accountUuid === 'b', '目前帳號冷卻、另一個可用＝換')
ok(decideSwitch({ accounts: [acc({ disabled: true }), B], activeUuid: 'a', now: NOW, settings: ON, lastSwitchAt: 0 }).action === 'switch', '目前帳號停用（會籍停止）＝換走')
ok(decideSwitch({ accounts: [A, acc({ accountUuid: 'b', organizationUuid: 'org-b', disabled: true })], activeUuid: 'a', now: NOW, settings: ON, lastSwitchAt: 0 }).action === 'none', '另一個停用＝不切過去、等原帳號')
ok(decideSwitch({ accounts: [A, acc({ accountUuid: 'b', organizationUuid: 'org-b', coolingUntil: NOW + 1000 })], activeUuid: 'a', now: NOW, settings: ON, lastSwitchAt: 0 }).action === 'none', '另一個也在冷卻＝不換')
ok(decideSwitch({ accounts: [A, B], activeUuid: 'a', now: NOW, settings: ON, lastSwitchAt: NOW - 30000 }).reason === 'cooldown', '剛換過＝冷靜期內不再換（多室連發中斷）')
ok(decideSwitch({ accounts: [A, B], activeUuid: null, now: NOW, settings: ON, lastSwitchAt: 0 }).action === 'none', '目前帳號不在保管庫＝不換')

console.log('\n[4] 登入檔合併與比對（保留 MCP 登入、權杖不外流）')
const LIVE = { mcpOAuth: { srv: { t: 1 } }, claudeAiOauth: { accessToken: 'x', refreshToken: 'y' }, organizationUuid: 'org-a' }
const TGT = { claudeAiOauth: { accessToken: 'p', refreshToken: 'q' }, organizationUuid: 'org-b' }
const M = mergeCredentials(LIVE, TGT)
ok(M.mcpOAuth?.srv?.t === 1 && M.claudeAiOauth.refreshToken === 'q' && M.organizationUuid === 'org-b', '只換訂閱登入與組織，MCP 登入保留')
ok(matchAccountByCredentials([A, B], { organizationUuid: 'org-b' })?.accountUuid === 'b', '以組織 id 認出帳號')
ok(matchAccountByCredentials([A, B], { organizationUuid: 'org-z' }) === null, '不在保管庫＝null')
const R = accountRecordFrom({ claudeAiOauth: { accessToken: 'SECRET', refreshToken: 'SECRET2', subscriptionType: 'max', refreshTokenExpiresAt: 5 }, organizationUuid: 'org-a' }, { accountUuid: 'a', emailAddress: 'a@x', organizationUuid: 'org-a' }, NOW)
ok(!JSON.stringify(R).includes('SECRET'), '保管庫帳號紀錄不含權杖')
ok(!JSON.stringify(accountPublicView({ ...R, claudeAiOauth: { accessToken: 'SECRET' } }, NOW, 'a')).includes('SECRET'), '介面看到的帳號資料不含權杖（就算紀錄被塞了也不帶出去）')
ok(parseLoginUrl('If the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1\nPaste code') === 'https://claude.com/cai/oauth/authorize?code=true&x=1', '從登入輸出抓網址')

console.log('\n[5] 換過去之後的續接（少爺定：沒冷卻就直接續接）')
const S0 = resolveAutoResumeSettings(() => undefined)
const rec = { status: 'waiting', kind: 'usage_limit', resetAt: NOW + 3600000, weekly: false, excluded: false }
ok(decideAction({ record: rec, now: NOW, settings: S0, deliverable: true, switchedAway: true }) === 'resume', '別的帳號撞的、已換到沒冷卻的帳號＝不等重設、不看第一階段開關，直接續接')
ok(decideAction({ record: rec, now: NOW, settings: S0, deliverable: true, switchedAway: false }) === 'wait', '沒換帳號＝照第一階段等重設')
ok(decideAction({ record: { ...rec, excluded: true }, now: NOW, settings: S0, deliverable: true, switchedAway: true }) === 'notify_excluded', '被排除的聊天室換了帳號也不續接')
ok(decideAction({ record: rec, now: NOW, settings: S0, deliverable: false, switchedAway: true }) === 'notify_undeliverable', '投不進去＝只通知')
ok(decideAction({ record: rec, now: NOW, settings: S0, deliverable: true, switchedAway: true, resumedSelf: true }) === 'resolved_self', '已自己接上＝不重送')
ok(decideAction({ record: { ...rec, weekly: true }, now: NOW, settings: S0, deliverable: true, switchedAway: true }) === 'resume', '原帳號是週上限也照樣續接（新帳號的額度）')
ok(resumePrompt(rec, new Date(NOW), false, 'b@x').includes('已自動換到另一個帳號（b@x）'), '續接訊息說明換了帳號')

console.log('\n[6] index.js 接線')
const SRC = fs.readFileSync(path.join(HERE, 'index.js'), 'utf-8')
const _sw = SRC.slice(SRC.indexOf('function switchAccount'), SRC.indexOf('function verifyAccountSwitch'))
ok(_sw.length > 0 && _sw.indexOf('syncActiveCredentials()') < _sw.indexOf('writeJsonAtomic(LIVE_CREDENTIALS_FILE'), '換走前先把目前帳號最新的登入存回保管庫（舊更新權杖重用＝整個登入作廢）')
ok(_sw.includes("importActiveAccount('before_switch')") && _sw.includes('為免登入遺失不切換'), '目前帳號不在保管庫時先收進來，收不進來就不切（避免登入遺失）')
ok(_sw.includes('mergeCredentials(_live, _saved)'), '寫回共用登入檔走合併（保留 MCP 登入）')
const _api = SRC.slice(SRC.indexOf("app.get('/api/accounts'"), SRC.indexOf('async function usageInterruptTick'))
ok(_api.includes('accountPublicView') && !/claudeAiOauth|accessToken|refreshToken/.test(_api.replace(/function loginJobView[\s\S]*?\n}\n/, '')), '帳號 API 只回介面欄位，不碰權杖欄位')
ok(SRC.includes("app.post('/api/accounts/login'") && SRC.includes("['auth', 'login', '--claudeai']") && SRC.includes('CLAUDE_CONFIG_DIR: _dir'), '加入帳號走官方 claude auth login（臨時設定目錄）')
ok(/fs\.rmSync\(_dir, \{ recursive: true, force: true \}\)/.test(SRC), '登入完成或失敗都刪掉臨時目錄')
const _tick = SRC.slice(SRC.indexOf('async function usageInterruptTick'), SRC.indexOf("app.post('/hook/StopFailure'"))
ok(_tick.includes('decideSwitch(') && _tick.includes("switchAccount(_sw.target.accountUuid, 'auto')"), '排程裡依判斷自動換帳號')
ok(_tick.includes('switchedAway: _switchedAway') && _tick.includes('resumeUsageInterrupt(_r.sessionId'), '換過去後的續接走既有續接入口')
ok(SRC.includes('accountUuid: _account?.accountUuid ?? null') && SRC.includes('function accountAt('), '中斷紀錄記下當時的帳號（換帳號後才到的舊帳號中斷不算到新帳號）')
ok(SRC.includes('noteAccountFromInterrupt(_account, _rec)'), '中斷回寫帳號冷卻／停用')
// 2026-10-10 實測：換帳號後 G1 收到續接訊息卻停住（Claude Code 把訊息扣到重設時間），TC 仍記「已續接」
ok(_tick.includes('checkResumeStalled(_now)') && /status = 'stalled'/.test(SRC) && SRC.includes('function usageActivityAfter'), '續接送出後確認真的有回覆，沒動就標「送達但沒動」並通知')
// 2026-10-10 實測：G1 開著分頁卻被寫成「無頭續接、不要掛監看」
ok(/const _headless = !isLiveInteractiveSession\(InSid\) && !isMonitorAlive\(InSid\) && !ccmsgAvailable\(InSid\)/.test(SRC), '有活監看或直投登記就不是無頭續接')
// 2026-10-10 實證：監看送的續接訊息被「等重設」扣住，跨工作階段直投叫得醒（G1 舊進程 13 秒內開工）
const _stall = SRC.slice(SRC.indexOf('function checkResumeStalled'), SRC.indexOf('function usageDeliverable'))
ok(_stall.includes('ccmsgAvailable(_r.sessionId)') && _stall.includes('ccmsgPostVerified(') && _stall.indexOf('ccmsgPostVerified(') < _stall.indexOf("_r.status = 'stalled'"), '送達但沒動時先用直投補叫一次，叫不醒才標 stalled')

// 2026-10-10 實查：26 個開著的 VS Code 分頁曾被 TC 無頭續接過而永久列在 subprocessSids，被誤判「不是活分頁」
const _live = SRC.slice(SRC.indexOf('function isLiveInteractiveSession'), SRC.indexOf('function monitorMountCommand'))
ok(_live.length > 0 && !/subprocessSids\.has/.test(_live), '活分頁判定只看本機註冊表，不因曾被無頭續接而排除')
ok(SRC.includes("logEvent('tc.ccmsg.hook_register_miss'"), 'hook 帶標頭卻登記失敗時留診斷紀錄（只記布林、不記權杖）')

console.log('\n[登入失效防護（2026-10-13 少爺「修復 TC 的這些問題」）]')
// ① Claude Code 自己登入時寫的登入檔沒有頂層組織 id（10-13 00:37 實查）⇒ 舊版認不出帳號、新登入存不進保管庫、一換帳號就被蓋掉
const ACC = [{ accountUuid: 'A', organizationUuid: 'orgA' }, { accountUuid: 'B', organizationUuid: 'orgB' }]
const credNoOrg = { claudeAiOauth: { refreshToken: 'r' } }
ok(matchAccountByCredentials(ACC, credNoOrg) === null, '登入檔沒有組織 id、也沒給帳號資料＝認不出')
ok(matchAccountByCredentials(ACC, credNoOrg, { organizationUuid: 'orgB' })?.accountUuid === 'B', '登入檔沒有組織 id 時改用 ~/.claude.json 的帳號資料認出帳號')
ok(matchAccountByCredentials(ACC, { ...credNoOrg, organizationUuid: 'orgA' }, { organizationUuid: 'orgB' })?.accountUuid === 'A', '登入檔有組織 id 就以登入檔為準（TC 換帳號寫的檔）')
ok(liveOrganizationUuid({}, { organizationUuid: 'orgB' }) === null, '沒有訂閱登入就不退回帳號資料')
// ② 換過去驗證失敗＝立刻換回原帳號（原帳號冷卻也換）
const SW = [{ at: 1000, from: 'A', to: 'B', reason: 'auto' }]
const ACC2 = [{ accountUuid: 'A', coolingUntil: 999999 }, { accountUuid: 'B' }]
ok(decideRevert({ switches: SW, failedUuid: 'B', now: 1000 + 60000, windowSec: 600, accounts: ACC2 }).to === 'A', '切過去 60 秒內登入失效＝換回原帳號（原帳號冷卻中也換）')
ok(decideRevert({ switches: SW, failedUuid: 'B', now: 1000 + 700000, windowSec: 600, accounts: ACC2 }).action === 'none', '超過回退視窗＝不換回')
ok(decideRevert({ switches: SW, failedUuid: 'A', now: 2000, windowSec: 600, accounts: ACC2 }).action === 'none', '失效的不是剛切過去的帳號＝不換回')
ok(decideRevert({ switches: [...SW, { at: 1500, from: 'B', to: 'A', reason: 'revert' }], failedUuid: 'A', now: 2000, windowSec: 600, accounts: ACC2 }).action === 'none', '回退後又失效＝不再來回切')
ok(decideRevert({ switches: SW, failedUuid: 'B', now: 2000, windowSec: 600, accounts: [{ accountUuid: 'A', disabled: true }, { accountUuid: 'B' }] }).action === 'none', '原帳號已停用＝不換回')
// ③ 登入失效的中斷：現在的登入可用就改回待續接
const recAU = { status: 'account_unavailable', kind: 'account_unavailable', error: 'authentication_failed', accountUuid: 'B' }
const p1 = recoverAuthFailedRecord(recAU, { accountUuid: 'A' }, 'available', 5000)
ok(p1?.status === 'waiting' && p1.kind === 'usage_limit' && p1.resetAt === 5000, '登入失效的中斷在可用帳號上改回待續接、立刻到期')
ok(recoverAuthFailedRecord(recAU, { accountUuid: 'A', coolingUntil: 9000 }, 'cooling', 5000)?.resetAt === 9000, '目前帳號冷卻中＝等它重設再續接')
ok(recoverAuthFailedRecord(recAU, { accountUuid: 'B', disabled: true }, 'disabled', 5000) === null, '目前登入就是那個停用中的帳號＝不恢復')
ok(recoverAuthFailedRecord(recAU, null, null, 5000) === null, '認不出目前登入＝不恢復')
ok(recoverAuthFailedRecord({ ...recAU, error: 'billing_error' }, { accountUuid: 'A' }, 'available', 5000) === null, '帳務等其他「帳號不可用」不恢復')
// 接線
ok(/function matchLiveAccount[\s\S]{0,300}CLAUDE_JSON_FILE/.test(SRC), '共用登入比對統一走 matchLiveAccount（缺組織 id 時讀 ~/.claude.json）')
ok((SRC.match(/matchAccountByCredentials\(accountList\(\)/g) ?? []).length === 1, '除了 matchLiveAccount 本身，沒有地方直接比對（避免漏掉缺組織 id 的情況）')
ok(SRC.includes('storeAccount({ ..._live, organizationUuid: liveOrganizationUuid(_live, _oa) }'), '匯入目前登入：登入檔缺組織 id 時補上，不再報「對不上」')
ok(/_a\.refreshToken !== _b\.refreshToken[\s\S]{0,120}authentication_failed[\s\S]{0,200}account\.reenabled/.test(SRC), '登入檔換成新的更新權杖＝重新登入過：解除「登入失效」的自動停用')
ok(SRC.includes("error === 'authentication_failed') revertSwitchIfFresh") && SRC.includes("switchAccount(_decision.to, 'revert')"), '帳號因登入失效被停用時呼叫回退判斷，需要時換回原帳號')
ok(SRC.includes('recoverAuthFailedRecord(_r, _active, _activeStatus, _now)'), '每輪檢查把登入失效的中斷改回待續接')

// ── 外部切換補記（2026-10-13 19:08：登入檔在 TC 外換成 sasocaptain，切換紀錄沒記，上限被算到 claudecodemaxuser）
const XS = [{ at: 1000, from: 'A', to: 'B', reason: 'manual' }]
ok(detectExternalSwitch({ switches: XS, liveUuid: 'B', at: 5000, now: 100000, graceMs: 30000 }) === null, '登入檔就是最後切過去的帳號＝不補記')
const _xs1 = detectExternalSwitch({ switches: XS, liveUuid: 'A', at: 50000, now: 100000, graceMs: 30000 })
ok(_xs1 && _xs1.from === 'B' && _xs1.to === 'A' && _xs1.reason === 'external' && _xs1.at === 50000, '登入檔換成別的帳號＝補一筆外部切換（時間＝登入檔修改時間）')
ok(detectExternalSwitch({ switches: XS, liveUuid: 'A', at: 20000, now: 20000, graceMs: 30000 }) === null, 'TC 剛換完的寬限期內被寫回＝交給切換後驗證、不補記')
ok(detectExternalSwitch({ switches: XS, liveUuid: 'A', at: 500, now: 100000, graceMs: 30000 }) === null, '登入檔比最後一筆切換還舊＝不補記')
ok(detectExternalSwitch({ switches: XS, liveUuid: null, at: 50000, now: 100000, graceMs: 30000 }) === null, '認不出登入檔的帳號＝不補記')
const XS2 = [...XS, { at: 50000, from: 'B', to: 'A', reason: 'external' }]
ok(detectExternalSwitch({ switches: XS2, liveUuid: 'B', at: 51000, now: 52000, graceMs: 30000 })?.to === 'B', '上一筆是外部切換時沒有寬限期，再換回也補記')
ok(detectExternalSwitch({ switches: [], liveUuid: 'A', at: 1, now: 2, graceMs: 30000 })?.from === null, '沒有任何切換紀錄＝補第一筆（來源空）')
ok(decideRevert({ switches: XS2, failedUuid: 'A', now: 50500, windowSec: 600, accounts: [{ accountUuid: 'A' }, { accountUuid: 'B' }] }).reason === 'external_login', '外部登入的帳號失效＝不自動換回（那是少爺自己登入的）')
ok(/function syncActiveCredentials[\s\S]{0,900}detectExternalSwitch\(/.test(SRC) && SRC.includes("reason: 'external' })"), '登入檔同步時偵測外部切換並寫入切換紀錄')

console.log('\n[外部切換回溯] 冷卻調高紀錄與倒回（2026-10-13 20:19 事故：外部切換晚 55 分鐘補記，sasocaptain 被標冷卻到 00:20）')
const _r1 = raiseCooling({ coolingUntil: null }, 2150, 1925, false)
ok(_r1 && _r1.coolingUntil === 2150 && _r1.coolingLog.length === 1 && _r1.coolingLog[0].prev === null && _r1.coolingLog[0].at === 1925, '冷卻調高＝寫入新值並記一筆（中斷時間、調高前的值）')
ok(raiseCooling({ coolingUntil: 2150 }, 2000, 1930, false) === null && raiseCooling({ coolingUntil: 2150 }, 2150, 1930, false) === null, '重設時間沒有更晚＝不調高、不記')
ok(raiseCooling({ coolingUntil: null, coolingLog: Array.from({ length: COOLING_LOG_MAX }, (_, i) => ({ at: i, prev: null, to: i })) }, 99999, 5000, false).coolingLog.length === COOLING_LOG_MAX, '紀錄有上限、只留最近幾筆')
const _saso = { coolingUntil: 2420, coolingWeekly: false, coolingLog: [{ at: 1925, prev: null, prevWeekly: false, to: 2150 }, { at: 2019, prev: 2150, prevWeekly: false, to: 2420 }] }
const _rb = rollbackCoolingSince(_saso, 1926)
ok(_rb && _rb.coolingUntil === 2150 && _rb.coolingLog.length === 1, '外部切換點之後的調高全倒回（00:20 → 21:50），切換前的那筆保留')
const _rb2 = rollbackCoolingSince({ ..._saso, coolingUntil: null }, 1926)
ok(_rb2 && !('coolingUntil' in _rb2) && _rb2.coolingLog.length === 1, '期間已被手動清除冷卻＝尊重現值、只清紀錄（總控 23:3x 手動清過，不可再寫回）')
ok(rollbackCoolingSince(_saso, 3000) === null, '切換點之後沒有調高＝不動')
ok(rollbackCoolingSince({ coolingUntil: 2420 }, 1926) === null, '沒有紀錄的舊資料＝不動現有冷卻')
ok(/function noteAccountFromInterrupt[\s\S]{0,400}raiseCooling\(/.test(SRC), '中斷回寫冷卻一律走 raiseCooling（才有紀錄可倒回）')
ok(/function syncActiveCredentials[\s\S]{0,1200}correctAttributionAfterExternalSwitch\(_ext\)/.test(SRC), '補記外部切換後立刻回溯更正歸屬與冷卻')
ok(/function correctAttributionAfterExternalSwitch[\s\S]{0,900}recordsToReattribute\([\s\S]{0,600}rollbackCoolingSince\(/.test(SRC), '回溯＝改歸屬＋原帳號冷卻倒回＋新帳號補冷卻')
ok(/try \{ syncActiveCredentials\(\) \}[^\n]*\n\s*const _account = accountAt\(/.test(SRC), '記錄中斷前先同步登入檔，再照切換紀錄歸屬')
ok(/setTimeout\(\(\) => \{ try \{ syncActiveCredentials\(\) \}/.test(SRC), '伺服器啟動後立刻同步登入檔，不等第一輪定期檢查')

console.log(`\n結果：${pass} 通過，${fail} 失敗`)
process.exit(fail > 0 ? 1 : 0)
