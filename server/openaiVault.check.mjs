// OpenAI（Codex）帳號保管庫＋外包機檢：`node openaiVault.check.mjs`（或 `npm run check:openai`）
//
// 少爺 2026-10-25：TC 帳號面板可加 OpenAI 帳號（AI 只是燃料、可替換）；聊天室可把工作外包給 GPT，再由 Claude 照交付文件做。
// 前半驗純判斷，後半掃 index.js 確認接線（權杖不外流、匯入不複製登入、外包預設唯讀）。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseCodexAuth, openaiAccountStatus, openaiAccountPublicView, pickOpenaiAccount, parseCodexLoginUrl, buildOutsourceArgs } from './openaiVault.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0

function ok(InCond, InLabel, InDetail = '') {
  if (InCond) { pass++; console.log(`  ✅ ${InLabel}`) }
  else { fail++; console.log(`  ❌ ${InLabel} ${InDetail}`) }
}

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0)
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = claims => `${b64({ alg: 'none' })}.${b64(claims)}.sig`
const auth = (o = {}) => ({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: jwt({ email: 'm@x', 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1', chatgpt_plan_type: 'plus', chatgpt_subscription_active_until: '2026-11-20T00:00:00Z' } }), access_token: 'AT', refresh_token: 'RT', account_id: 'acc-1', ...o } })

console.log('\n[1] 解登入檔')
const _p = parseCodexAuth(auth())
ok(_p?.accountId === 'acc-1' && _p.email === 'm@x' && _p.plan === 'plus' && _p.mode === 'chatgpt', 'ChatGPT 登入解出帳號 id／信箱／方案')
ok(!JSON.stringify(_p).includes('RT') && !JSON.stringify(_p).includes('AT"'), '解出的資料不含權杖')
ok(parseCodexAuth({ OPENAI_API_KEY: 'sk-abcdef123456' })?.mode === 'apikey', 'API 金鑰登入＝金鑰模式')
ok(!JSON.stringify(parseCodexAuth({ OPENAI_API_KEY: 'sk-abcdef123456' })).includes('sk-abc'), '金鑰模式只留末六碼當 id')
ok(parseCodexAuth(null) === null && parseCodexAuth({ tokens: {} }) === null, '沒有登入＝null')

console.log('\n[2] 狀態與挑帳號')
const A = { accountId: 'a', disabled: false, subscriptionUntil: '2026-11-20T00:00:00Z' }
const B = { accountId: 'b', disabled: false, subscriptionUntil: null }
ok(openaiAccountStatus(A, NOW) === 'available', '訂閱期內＝可用')
ok(openaiAccountStatus({ ...A, subscriptionUntil: '2026-10-01T00:00:00Z' }, NOW) === 'available', 'id_token 的訂閱到期日是登入快照、不拿來判斷（10-25 實測已過期仍可用）')
ok(openaiAccountStatus({ ...A, disabled: true }, NOW) === 'disabled', '手動停用')
ok(pickOpenaiAccount([A, B], 'b', null, NOW)?.accountId === 'b', '沒指定＝用使用中的')
ok(pickOpenaiAccount([{ ...A, disabled: true }, B], 'a', null, NOW)?.accountId === 'b', '使用中的停用＝挑別的可用帳號')
ok(pickOpenaiAccount([A, { ...B, disabled: true }], 'a', 'b', NOW) === null, '指定的帳號不可用＝不偷換')
ok(openaiAccountPublicView({ ...A, homeDir: 'C:/x' }, NOW, 'a').active === true && !('homeDir' in openaiAccountPublicView({ ...A, homeDir: 'C:/x' }, NOW, 'a')), '送前端的資料不含資料夾路徑')

console.log('\n[3] 登入網址與外包參數')
ok(parseCodexLoginUrl('open https://auth.openai.com/oauth/authorize?x=1&y=2 to sign in') === 'https://auth.openai.com/oauth/authorize?x=1&y=2', '抓到登入網址')
const _args = buildOutsourceArgs({ cwd: 'C:/w', model: 'gpt-6.1-sol', effort: 'xhigh', outputFile: 'C:/o.md' })
ok(_args.includes('read-only') && !_args.includes('workspace-write'), '外包預設唯讀沙箱')
ok(_args.at(-1) === '-' && _args.includes('--ephemeral'), '委託從標準輸入讀、不留會話')
ok(_args.join(' ').includes('-o C:/o.md') && _args.join(' ').includes('-m gpt-6.1-sol'), '指定輸出檔與模型')
ok(!buildOutsourceArgs({}).some(a => a.includes('dangerously')), '永不帶跳過沙箱旗標')

console.log('\n[4] index.js 接線')
const SRC = fs.readFileSync(path.join(HERE, 'index.js'), 'utf-8')
const _seg = SRC.slice(SRC.indexOf('OpenAI（Codex）帳號＋外包'), SRC.indexOf('async function usageInterruptTick'))
ok(_seg.length > 1000, '找得到 OpenAI 區段')
ok(!/refresh_token|access_token|id_token/.test(_seg), '端點區段不碰權杖欄位（辨識一律走 parseCodexAuth）')
ok(/storeOpenaiAccount\(CODEX_DEFAULT_HOME, 'import', true\)/.test(_seg), '匯入目前登入＝登記 ~\\.codex 本身（不複製）')
ok(/!_a\.shared && _a\.homeDir\?\.startsWith\(OPENAI_DIR\)/.test(_seg), '移除匯入的帳號不刪 Codex App 的登入檔')
ok(/CODEX_HOME: _acc\.homeDir/.test(_seg), '外包用所選帳號的 CODEX_HOME')

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通過、${fail} 失敗`)
process.exit(fail ? 1 : 0)
