// 提問中繼機檢：`node askRelay.check.mjs`（或 `npm run check:ask`）
//
// 少爺 2026-10-08「我要TC的Chat也能像是VS Code顯示這些問題還有選項…我可以選擇是直接操作原本的選項，或是讓陪聊把內容填入其他選項」。
// 前半驗純邏輯（提問識別鍵、作答組裝、ASCII 回應、對話紀錄掃描），後半掃 index.js 與前端確認接線：
// 提問在「TC 子進程」過濾之前就進中繼、回 hook 一律 ASCII、分頁先答／回合結束都會放掉扣著的連線。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ASK_TOOL, askQuestionsOf, askKeyOf, askSummary, buildAskAnswer, asciiJson, findOpenAsk, askHasResult } from './askRelay.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0

function ok(InCond, InLabel, InDetail = '') {
  if (InCond) { pass++; console.log(`  ✅ ${InLabel}`) }
  else { fail++; console.log(`  ❌ ${InLabel} ${InDetail}`) }
}

const INPUT = {
  questions: [
    { question: '體幹滿了之後，誰會被處決？', header: '處決對象', multiSelect: false, options: [{ label: '只有敵人被處決（建議）', description: '敵人體幹滿→處決窗' }, { label: '兩邊都會被處決', description: '' }] },
    { question: '據點活過來要哪些畫面？', header: '活過來', multiSelect: true, options: [{ label: '鷹旗升起', description: '' }, { label: '篝火點燃', description: '' }, { label: '營地環境音', description: '' }] },
  ],
  metadata: { source: 'test' },
}
const Q1 = INPUT.questions[0].question
const Q2 = INPUT.questions[1].question

console.log('\n[1] 提問識別鍵')
ok(askKeyOf('s1', INPUT) === askKeyOf('s1', JSON.parse(JSON.stringify(INPUT))), '同一組題目＝同一個鍵（hook 重送、對話紀錄重建對得上）')
ok(askKeyOf('s1', INPUT) !== askKeyOf('s2', INPUT), '不同聊天室＝不同鍵')
ok(askKeyOf('s1', INPUT) !== askKeyOf('s1', { questions: [{ ...INPUT.questions[0], options: [{ label: '只有敵人被處決（建議）' }, { label: '都不處決' }] }, INPUT.questions[1]] }), '選項不同＝不同鍵')
ok(askSummary(INPUT) === '處決對象／活過來', '摘要＝各題短標')
ok(askQuestionsOf({}).length === 0 && askQuestionsOf({ questions: [null, { question: 'x' }] }).length === 1, '題目清單防呆')

console.log('\n[2] 作答組裝')
let r = buildAskAnswer(INPUT, { [Q1]: '只有敵人被處決（建議）' })
ok(r.ok && r.answered === 1, '單選一題')
const out = r.output?.hookSpecificOutput
ok(out?.hookEventName === 'PermissionRequest' && out.decision?.behavior === 'allow', '回應形狀＝PermissionRequest／allow（不是 PreToolUse 的 permissionDecision）')
ok(JSON.stringify(out?.decision?.updatedInput?.questions) === JSON.stringify(INPUT.questions), 'updatedInput 保留原題目（改題目會被 Claude Code 驗證擋下）')
ok(out?.decision?.updatedInput?.metadata?.source === 'test', 'updatedInput 保留原輸入的其他欄位')
r = buildAskAnswer(INPUT, { [Q2]: ['鷹旗升起', '篝火點燃'] })
ok(r.ok && r.output.hookSpecificOutput.decision.updatedInput.answers[Q2] === '鷹旗升起, 篝火點燃', '複選＝以「, 」串起來（與分頁作答同格式）')
ok(!buildAskAnswer(INPUT, { [Q1]: ['只有敵人被處決（建議）', '兩邊都會被處決'] }).ok, '單選題給兩個選項＝擋下')
r = buildAskAnswer(INPUT, { [Q1]: '我想要只有首領能被處決，一般野蠻人直接擊倒' })
ok(r.ok && r.output.hookSpecificOutput.decision.updatedInput.answers[Q1].startsWith('我想要'), '「其他」＝自由文字原樣當答案')
r = buildAskAnswer(INPUT, { [Q1]: '兩邊都會被處決' }, { [Q1]: '我方處決要很少見', [Q2]: '' })
ok(r.ok && r.output.hookSpecificOutput.decision.updatedInput.annotations?.[Q1]?.notes === '我方處決要很少見' && !r.output.hookSpecificOutput.decision.updatedInput.annotations[Q2], '補充說明→annotations.notes（空的不送）')
ok(!buildAskAnswer(INPUT, { '不存在的題目': 'x' }).ok, '不存在的題目＝擋下')
ok(!buildAskAnswer(INPUT, {}).ok && !buildAskAnswer(INPUT, { [Q1]: '   ' }).ok, '沒作答＝擋下')
ok(!buildAskAnswer({}, { a: 'b' }).ok, '沒有題目＝擋下')
r = buildAskAnswer({ ...INPUT, answers: { [Q2]: '模型自己塞的' } }, { [Q1]: '只有敵人被處決（建議）' })
ok(r.ok && !(Q2 in r.output.hookSpecificOutput.decision.updatedInput.answers), '原輸入夾帶的 answers 不會混進來')

console.log('\n[3] 回 hook 的 JSON 一律 ASCII')
const _json = asciiJson({ a: '中文「引號」50%', e: '🎮', n: 1 })
ok(/^[\x00-\x7f]*$/.test(_json), '沒有任何非 ASCII 位元組')
ok(JSON.parse(_json).a === '中文「引號」50%' && JSON.parse(_json).e === '🎮', '解回來與原文相同（含表情符號）')

console.log('\n[4] 對話紀錄掃描')
const line = (o) => JSON.stringify(o)
const ask = (id, input = INPUT) => line({ type: 'assistant', timestamp: '2026-10-08T10:29:38.476Z', message: { content: [{ type: 'tool_use', id, name: ASK_TOOL, input }] } })
const text = (t) => line({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })
const result = (id) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Your questions have been answered' }] } })
let open = findOpenAsk([text('C2 批設計好了，有四題要你定'), ask('toolu_A')].join('\n'))
ok(open?.toolUseId === 'toolu_A' && open.lead === 'C2 批設計好了，有四題要你定' && askKeyOf('s1', open.input) === askKeyOf('s1', INPUT), '未答的提問：抓到 id、題目、提問前那段話')
ok(findOpenAsk([ask('toolu_A'), result('toolu_A')].join('\n')) === null, '已有結果＝不算未答')
ok(findOpenAsk([ask('toolu_A'), result('toolu_A'), ask('toolu_B')].join('\n'))?.toolUseId === 'toolu_B', '取最後一個未答的')
ok(findOpenAsk([ask('toolu_A'), line({ type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_A' }] } })].join('\n'))?.toolUseId === 'toolu_A', '子代理的紀錄不影響')
ok(findOpenAsk('壞掉的一行\n{"type":"assistant"') === null, '壞資料不炸')
ok(askHasResult([ask('toolu_A'), result('toolu_A')].join('\n'), 'toolu_A') && !askHasResult(ask('toolu_A'), 'toolu_A') && !askHasResult('x', null), 'askHasResult')

console.log('\n[5] index.js 接線')
const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')
const permRoute = src.slice(src.indexOf("app.post('/hook/PermissionRequest'"), src.indexOf("app.post('/hook/PermissionRequest'") + 1500)
ok(permRoute.indexOf('return askHold(request, reply, e)') > 0 && permRoute.indexOf('return askHold(request, reply, e)') < permRoute.indexOf('subprocessSids.has(e.session_id)'),
  '提問在「TC 子進程」過濾之前就進中繼（曾由 TC 起跑、後來在 VS Code 開著的聊天室也要能答）')
const holdFn = src.slice(src.indexOf('async function askHold('), src.indexOf('async function askHold(') + 3000)
ok(holdFn.includes('reply.send(asciiJson('), '扣著的連線回應走 asciiJson')
ok(holdFn.includes("socket?.once('close'"), 'hook 被收掉（連線斷）會改成只顯示')
const postRoute = src.slice(src.indexOf("app.post('/hook/PostToolUse'"), src.indexOf("app.post('/hook/PostToolUse'") + 600)
ok(/askRelease\(e\.session_id, 'answered_elsewhere'/.test(postRoute), '分頁答完（PostToolUse）會放掉扣著的連線')
for (const [_route, _why] of [['/hook/Stop', 'turn_end'], ['/hook/SessionEnd', 'session_end'], ['/hook/UserPromptSubmit', 'new_prompt']]) {
  const _r = src.slice(src.indexOf(`app.post('${_route}'`), src.indexOf(`app.post('${_route}'`) + 700)
  ok(_r.includes(`askRelease(e?.session_id, '${_why}')`), `${_route} 會結束該聊天室未答的提問`)
}
ok(src.includes("app.post('/api/ask/answer'") && src.includes("app.get('/api/ask/state'"), '作答與狀態 API 在')
ok(/\['qa', 'som', 'chat', 'ask'\]\.includes\(scope\)/.test(src), '陪聊接受 ask 範圍')
ok(src.includes("getTcSetting('companion.askAutoBrief', true)"), '陪聊自動開場受總設定控制')

console.log('\n[6] 前端接線')
const clientDir = path.join(HERE, '..', 'client', 'src')
const chat = fs.readFileSync(path.join(clientDir, 'ChatPanel.jsx'), 'utf8')
const app = fs.readFileSync(path.join(clientDir, 'App.jsx'), 'utf8')
const panel = fs.existsSync(path.join(clientDir, 'AskPanel.jsx')) ? fs.readFileSync(path.join(clientDir, 'AskPanel.jsx'), 'utf8') : ''
ok(/import \{ AskPanel[^}]*\} from '\.\/AskPanel\.jsx'/.test(chat) && chat.includes('<AskPanel'), 'Chat 掛上提問面板')
ok(app.includes("msg.type === 'ask_update'") && app.includes('tc-ask-update'), 'ws 的 ask_update 轉成 tc-ask-update 事件')
ok(app.includes("key: 'companion.askAutoBrief'"), '總設定有「提問陪聊自動開場」')
ok(panel.includes('/api/ask/answer') && panel.includes('/api/ask/state') && panel.includes("scope: 'ask'"), '面板走作答／狀態 API 與 ask 陪聊')

console.log(`\n${fail ? '❌' : '✅'} 提問中繼機檢：${pass} 過、${fail} 失敗\n`)
process.exit(fail ? 1 : 0)
