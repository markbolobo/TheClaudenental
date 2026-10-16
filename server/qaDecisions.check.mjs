// QA Run 待定奪機檢：`node qaDecisions.check.mjs`（或 `npm run check:qadecisions`）
//
// 少爺 2026-10-08「我要 TC QA Run 待我定奪的互動方式與 TC 侍酒師的待定奪一樣的形式，統一設計」。
// 前半驗計畫書待定奪段的拆解（條目／條目外的引用／舊格式計數）與格式 SSOT 解析器接得上，
// 後半掃 index.js／DecisionDeck.jsx／QAMonitor.jsx：三層同一套寫回、送交 run 走 QA 喚醒鏈、面板共用同一個元件。

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { QA_DECISION_SECTION_RE, decisionBlockEnd, decisionSectionFreeLines, decisionDeclarationRefs, decisionLinkRefs, normalizeDecisionSource, legacyQuestionCount } from './qaDecisions.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OPEN_DECISIONS_MJS = 'C:/Project/MasterBrain/.agent/scripts/open_decisions.mjs'
let pass = 0
let fail = 0

function ok(InCond, InLabel, InDetail = '') {
  if (InCond) { pass++; console.log(`  ✅ ${InLabel}`) }
  else { fail++; console.log(`  ❌ ${InLabel} ${InDetail}`) }
}

const SECTION = [
  '',
  '- [ ] OPEN-1 實作時機：第一階段先做，還是照「F 最後」',
  '  - **現況**：第一階段不依賴他批',
  '  - **選項**：A) 第一階段立即開工；B) 照 F 組最後做',
  '  - **建議**：A（不依賴他批，先驗能驗的）',
  '  - **牽動**：[[QuestObjectiveTemplate]] OPEN-5、[[DesignPillars]] OPEN-1',
  '- [x] OPEN-2 要不要先開分支（2026-10-08 少爺定：A) 不開）',
  '',
  '設計題見 [[ExtractionHoldout]] 待定奪，另掛 [[S14_ExtractionHoldout]] OPEN-3；摘要表如下：',
  '| # | 題目 | 建議 |',
  '| OPEN-1 | 撤離點位置 | C |',
]

console.log('\n[1] 段標題')
ok(QA_DECISION_SECTION_RE.test('十一、待定奪（設計意圖 `ExtractionHoldout.md`）'), '「待定奪」')
ok(QA_DECISION_SECTION_RE.test('三、待少爺定（本批的球）'), '舊稿「待少爺定」')
ok(QA_DECISION_SECTION_RE.test('〇、要少爺定的事'), '舊稿「要少爺定」')
ok(!QA_DECISION_SECTION_RE.test('五、預期 LOG'), '其他段不算')

console.log('\n[2] 條目以外的文字')
{
  const free = decisionSectionFreeLines('十一、待定奪（設計意圖 `ExtractionHoldout.md`）', SECTION)
  ok(free[0].includes('ExtractionHoldout.md'), '段標題算在內（舊稿常把意圖檔寫在標題）')
  ok(!free.some(l => l.includes('OPEN-1 實作時機')), '條目標題行不算')
  ok(!free.some(l => l.includes('QuestObjectiveTemplate')), '條目子項的 [[X]] OPEN-n 是連動題，不算本 run 的題')
  ok(free.some(l => l.includes('[[ExtractionHoldout]]')), '條目後面的段落文字照收')
}

console.log('\n[3] 宣告本 run 掛的設計題')
{
  const refs = decisionDeclarationRefs(decisionSectionFreeLines('十一、待定奪（設計意圖 `ExtractionHoldout.md`；同步寫在 `design_intent/HitStop.md`）', SECTION))
  const has = (id, openId = null) => refs.some(r => r.id === id && r.openId === openId)
  ok(has('ExtractionHoldout'), '[[X]]／`X.md` 與「待定奪」同一行＝整份', JSON.stringify(refs))
  ok(refs.filter(r => r.id === 'ExtractionHoldout').length === 1, '重複宣告去重')
  ok(has('HitStop'), '`design_intent/X.md` 路徑寫法（段標題含待定奪）')
  ok(has('S14_ExtractionHoldout', 'OPEN-3'), '[[X]] OPEN-n ＝單題')
  ok(!has('S14_ExtractionHoldout'), '單題引用不會順便把整份算進來')
  ok(!has('QuestObjectiveTemplate', 'OPEN-5'), '條目內的牽動不進來')
  // 2026-10-08 實測舊稿誤收：C3 計畫書的「依據 [[FormationChargeStun]] INV-2」把 D3 的四題衝撞全收進 C3
  const _cite = (l) => decisionDeclarationRefs(['二、待少爺定（動工前問掉）', l])
  ok(!_cite('- 對象：推導定「無差別」——依據：方陣即死已是無差別（[[FormationChargeStun]] INV-2）').length, '引用依據（[[X]] INV-n、沒寫待定奪）不算')
  ok(!_cite('- 牽動：[[S00_TitleMenuAndQuit]] OPEN-1（A＝實機營地遠景）、[[StateMachineFlowUI]]、H2').length, '牽動行（無粗體）不算')
  ok(!_cite('  - **取決於**：[[DesignPillars]] OPEN-1').length, '取決於行不算')
  ok(!_cite('| OPEN-8 | 要不要限時 | A（取決於 [[DesignPillars]] OPEN-1） |').length, '關係詞後面的單題引用不算')
  ok(_cite('本 run 的設計題（待定奪）：[[DesignPillars]] OPEN-1、[[HitStop]]').some(r => r.id === 'DesignPillars' && r.openId === 'OPEN-1'), '寫了待定奪的行：[[X]] OPEN-n＝單題')
  ok(_cite('本 run 的設計題（待定奪）：[[DesignPillars]] OPEN-1、[[HitStop]]').some(r => r.id === 'HitStop' && !r.openId), '寫了待定奪的行：[[X]]＝整份')
  ok(!_cite('參考 [[RoguelikeProgression]] 的分層').length, '只寫 [[X]] 沒寫待定奪＝引用，不算整份')
  ok(!_cite('- [[S12_WorldTransitionModules]] OPEN-1「一場 run 的結構」→ **推導：大廳選一張非線性大地圖**').length, '數獨推導筆記提到別檔的題，不算')
  ok(!_cite('- [ ] **連動題（不在本輪做，只記錄）**：[[QuestGroundInscription]] OPEN-2').length, '「連動題（不在本輪做）」不算')
}

console.log('\n[3b] 字串解析（decisionSources／說明 prompt 用）')
ok(decisionLinkRefs('計畫書 QA/plans/QAPC_extract.md').some(r => r.id === 'QAPC_extract'), '計畫書檔名也會被解析出來（存不存在由 index.js 判，這裡只做字串）')
ok(decisionLinkRefs('[[ExtractionHoldout|撤離]]').some(r => r.id === 'ExtractionHoldout'), '[[X|別名]]')

console.log('\n[4] decisionSources 寫法')
ok(normalizeDecisionSource('ExtractionHoldout') === '[[ExtractionHoldout]]', '「X」')
ok(normalizeDecisionSource('HitStop OPEN-2') === '[[HitStop]] OPEN-2', '「X OPEN-n」')
ok(normalizeDecisionSource('HitStop#OPEN-2') === '[[HitStop]] OPEN-2', '「X#OPEN-n」')
ok(normalizeDecisionSource('[[HitStop]] OPEN-2') === '[[HitStop]] OPEN-2', '已是 wiki 連結原樣')

console.log('\n[5] 舊格式題目計數（面板提示「請 Claude 轉成標準格式」）')
ok(legacyQuestionCount(['### Q1 擊飛手感', '### OPEN-2 群戰上限', '- **Q3 局內的 Gold**', '| Q4 | 軍紀 |', '一般段落'], false) === 4, '### Q／### OPEN／- **Q／表格 Q 列')
ok(legacyQuestionCount(['| OPEN-1 | 撤離點位置 | C |', '### OPEN-2 群戰上限'], true) === 0, '已掛設計題時，OPEN 開頭的標題／表格列是意圖檔題目的摘要，不算')
ok(legacyQuestionCount(['| OPEN-1 | 撤離點位置 | C |'], false) === 1, '沒掛設計題時，表格的 OPEN 列算舊格式')
ok(legacyQuestionCount(['### Q1 第三方放哪'], true) === 1, 'Q 題不管有沒有掛都算（可能只寫在計畫書）')
ok(legacyQuestionCount(decisionSectionFreeLines('待定奪', SECTION), true) === 0, '標準格式的段落不提示')

console.log('\n[6] 與格式 SSOT（open_decisions.mjs）接得上')
if (!fs.existsSync(OPEN_DECISIONS_MJS)) ok(false, `找不到 ${OPEN_DECISIONS_MJS}`)
else {
  const { parseOpenDecisions } = await import(pathToFileURL(OPEN_DECISIONS_MJS).href)
  const items = parseOpenDecisions(SECTION.join('\n'))
  const o1 = items.find(d => d.id === 'OPEN-1')
  ok(items.length === 2, '段內兩個條目都解析到', `實得 ${items.length}`)
  ok(o1 && !o1.resolved && o1.choices?.length === 2, 'OPEN-1 未定、兩個選項', JSON.stringify(o1?.choices))
  ok(o1?.recommend?.key === 'A', '「建議」欄解析成推薦選項')
  ok(o1?.refs?.some(r => r.target === 'QuestObjectiveTemplate' && r.openId === 'OPEN-5'), '條目內引用成為連動題（refs）')
  ok(items.find(d => d.id === 'OPEN-2')?.resolvedBy === 'owner', 'OPEN-2 已由少爺定')
}

// 示意（少爺 2026-10-09「我喜歡 VS Code 用這種搭配視覺的方式，讓我更好理解討論的情境，我要 TC 的也有」）
const PREVIEW_SECTION = [
  '- [ ] OPEN-2 衝撞的地面路徑提示長什麼樣',
  '  - **選項**：A) 紅色路徑＋揚塵；B) 只用紅色路徑',
  '  - **建議**：A（讀時機也讀方向）',
  '  - **示意 A**：',
  '    ```',
  '    出招者 ●≈≈≈≈≈▶ 陣型',
  '',
  '      ~~ 揚塵 ~~ 草壓倒',
  '    ```',
  '  - **示意 B**：只有紅色路徑、沒有揚塵',
  '  - **示意**：',
  '    ```',
  '    - [ ] OPEN-9 這行在圖裡，不是條目',
  '    ```',
  '  - **少爺回覆**（2026-10-09 10:00）：先看看',
  '- [ ] OPEN-3 下一題',
  '  - **選項**：A) 甲；B) 乙',
]

console.log('\n[6b] 示意區塊')
if (fs.existsSync(OPEN_DECISIONS_MJS)) {
  const { parseOpenDecisions } = await import(pathToFileURL(OPEN_DECISIONS_MJS).href)
  const items = parseOpenDecisions(PREVIEW_SECTION.join('\n'))
  const o2 = items.find(d => d.id === 'OPEN-2')
  ok(items.length === 2, '圖裡長得像條目的行不會變成新題', `實得 ${items.map(d => d.id)}`)
  ok(o2?.choices?.find(c => c.key === 'A')?.preview === '出招者 ●≈≈≈≈≈▶ 陣型\n\n  ~~ 揚塵 ~~ 草壓倒', '選項 A 的示意：去共同縮排、保留圖內空行與對齊', JSON.stringify(o2?.choices?.[0]?.preview))
  ok(o2?.choices?.find(c => c.key === 'B')?.preview === '只有紅色路徑、沒有揚塵', '同一行寫完的短示意')
  ok(o2?.preview === '- [ ] OPEN-9 這行在圖裡，不是條目', '不帶選項字母＝整題示意')
  ok(o2?.thread?.length === 1 && o2.thread[0].who === 'owner', '示意後面的少爺回覆照常進對話串')
  ok(o2?.options === 'A) 紅色路徑＋揚塵；B) 只用紅色路徑', '示意內容不會被接到「選項」欄位')
}
{
  const _end = decisionBlockEnd(PREVIEW_SECTION, 0, PREVIEW_SECTION.length)
  ok(PREVIEW_SECTION[_end]?.startsWith('- [ ] OPEN-3'), '條目範圍跨過圖裡的空行，停在下一題（寫回的少爺回覆不會插進圖中間）', `停在第 ${_end} 行`)
  const free = decisionSectionFreeLines('待定奪', PREVIEW_SECTION)
  ok(free.length === 1, '圖的內容不算條目以外的文字（不會被當成宣告或舊格式）', JSON.stringify(free))
}

// 動態示意（少爺 2026-10-10「我想要 TC 在問我速度方面的問題時，搭配這種動圖（更能看出速度感）」「或是你能用畫面模擬」）
console.log('\n[6c] 動態示意：條目格式')
if (fs.existsSync(OPEN_DECISIONS_MJS)) {
  const { parseOpenDecisions } = await import(pathToFileURL(OPEN_DECISIONS_MJS).href)
  const items = parseOpenDecisions([
    '- [ ] OPEN-1 鏡頭要不要完全即時',
    '  - **選項**：A) 完全即時；B) 留一點平滑',
    '  - **示意 A**：',
    '    ```motion',
    '    標題 甩鏡頭 90°',
    '    畫面 旋轉 90',
    '    鏡頭: 即時',
    '    陣型: 半衰期 0.05 跟 鏡頭',
    '    ```',
    '  - **示意 A**：',
    '    ```',
    '    鏡頭 ▶ 同一幀到',
    '    ```',
    '  - **示意 B**：',
    '    ```動態',
    '    鏡頭: 半衰期 0.02',
    '    ```',
  ].join('\n'))
  const o1 = items[0]
  ok(o1?.choices?.[0]?.motion?.startsWith('標題 甩鏡頭 90°'), '```motion 區塊＝選項的動態示意', JSON.stringify(o1?.choices?.[0]))
  ok(o1?.choices?.[0]?.preview === '鏡頭 ▶ 同一幀到', '同一選項的靜態示意與動態示意並存')
  ok(o1?.choices?.[1]?.motion === '鏡頭: 半衰期 0.02', '```動態 也算')
  ok(!o1?.choices?.[1]?.preview, '動態規格不會混進靜態示意')
}

console.log('\n[6d] 動態示意：規格與模擬（client/src/motionSpec.js）')
{
  const { parseMotionSpec, simulateMotion, motionValueAt } = await import(pathToFileURL(path.join(HERE, '..', 'client', 'src', 'motionSpec.js')).href)
  const spec = parseMotionSpec('標題 甩鏡頭 90°\n畫面 旋轉 90\n鏡頭: 即時\n陣型: 半衰期 0.05 跟 鏡頭\n士兵: 半衰期 0.05 跟 陣型 形狀 點\n彈: 彈簧 0.08 0.3\n延: 線性 0.2 @0.1')
  const sim = simulateMotion(spec)
  const at = (name, t) => motionValueAt(sim, sim.tracks.findIndex(x => x.name === name), t)
  ok(!spec.errors.length && sim, '規格解析無誤', JSON.stringify(spec.errors))
  ok(sim.scene.mode === 'rotate' && sim.scene.amount === 90, '畫面模擬：旋轉 90°')
  ok(at('鏡頭', 0.01) === 1, '即時＝第一幀就到')
  ok(Math.abs(at('陣型', 0.05) - 0.5) < 0.05, '半衰期 0.05＝0.05 秒時走一半', at('陣型', 0.05).toFixed(3))
  ok(at('士兵', 0.05) < at('陣型', 0.05) - 0.2, '跟陣型的士兵更慢（連鎖延遲）')
  ok(sim.yMax > 1.2 && sim.yMax < 1.4, '彈簧過衝 0.3 ≈ 衝過頭 30%', sim.yMax.toFixed(3))
  ok(at('延', 0.09) === 0 && Math.abs(at('延', 0.2) - 0.5) < 0.03, '@0.1 延遲後才開始線性', at('延', 0.2).toFixed(3))
  ok(sim.tracks.find(t => t.name === '鏡頭').shape === 'cone' && sim.tracks.find(t => t.name === '陣型').shape === 'block' && sim.tracks.find(t => t.name === '士兵').shape === 'dot', '形狀依名稱猜（鏡頭→視野、陣型→方陣），可用「形狀」指定')
  const bad = parseMotionSpec('鏡頭: 飛\n陣型: 線性\nx: 線性 0.2 跟 y\n畫面 爆炸')
  ok(bad.errors.length === 5 && !simulateMotion(bad), '錯誤規格逐條回報、不畫', JSON.stringify(bad.errors))
}

console.log('\n[7] index.js 靜態掃描')
{
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8')
  const _calls = src.split('\n').filter(l => l.includes('findOpenBlock(') && !l.includes('function findOpenBlock'))
  const _bad = _calls.filter(l => !l.includes('decisionSectionRe('))
  ok(_calls.length > 0 && !_bad.length, '每個 findOpenBlock 呼叫都帶該層的段標題規則（計畫書的段名不同）', JSON.stringify(_bad.map(l => l.trim())))
  ok(/DECISION_LAYERS = \['intent', 'scenario', 'qa'\]/.test(src), '三層同一套：設計脈絡／情境體驗／QA 計畫書')
  ok(/DECISION_LAYERS\.includes\(a\.layer\)/.test(src), '送出定奪接受計畫書的題')
  ok(/DECISION_LAYERS\.includes\(it\?\.layer\)/.test(src), '推導定確認／推翻接受計畫書的題')
  ok(/InLayer === 'qa' \? qaPlansDirOf\(InProj\)/.test(src), '計畫書只能寫在 QA 計畫書目錄內')
  const _deliver = src.slice(src.indexOf('function deliverDecisionsToQaRun'), src.indexOf('function deliverDecisionsToQaRun') + 2600)
  ok(/kind: 'decision'/.test(_deliver) && /qaWakeBoundSession\(run, 'decision'/.test(_deliver), '送交 run＝寫成一則留言＋走 QA 喚醒鏈（原地聯動／直投／無頭）')
  ok(/target: 'qa', runId: run\.id/.test(_deliver), '派工紀錄記下送交的 run（面板顯示「已送交 QA Run」）')
  ok(/decision: '在待定奪面板送出定奪/.test(src), 'QA 喚醒動作認得「定奪」')
  ok(/dispatch\.routeQa !== false/.test(src) && /activeQaDecisionIndex\(_proj, projectId\)/.test(src), '侍酒師送出：掛在進行中 run 的設計題預設改交給該 run')
  ok(/app\.get\('\/api\/qa\/runs\/:id\/decisions'/.test(src), '有 run 的待定奪 API')
  ok(/if \(typeof body\.qapPath === 'string'\) run\.qapPath = body\.qapPath/.test(src), '計畫書路徑建 run 後可補（PATCH qapPath）')
  ok(/decisionBlockEnd\(InLines, i, _sec\[1\], DECISION_HEAD_RE\)/.test(src), 'findOpenBlock 用共用的條目範圍判斷（認得示意區塊）')
  ok(/- preview：每個選項一張示意/.test(src) && /preview: explainPreviewOf\(/.test(src), '進一步說明會替每個選項畫示意（沒附示意的舊題也有圖）')
  ok(/- motion：題目在問速度/.test(src) && /motion: explainMotionOf\(o\?\.motion\)/.test(src), '速度／時序題的進一步說明會給動態示意，並用同一份規格解析器驗證')
}

console.log('\n[8] 前端：同一個面板元件')
{
  const deck = fs.readFileSync(path.join(HERE, '..', 'client', 'src', 'DecisionDeck.jsx'), 'utf8')
  const qa = fs.readFileSync(path.join(HERE, '..', 'client', 'src', 'QAMonitor.jsx'), 'utf8')
  ok(/target: 'qa', runId: qaRun\.id/.test(deck), 'DecisionDeck 在 QA 模式送交本 run')
  ok(/import \{[^}]*DecisionDeck[^}]*\} from '\.\/DecisionDeck\.jsx'/.test(qa), 'QA 分頁用的是侍酒師同一個 DecisionDeck')
  ok(/<DecisionDeck[^>]*qaRun=/.test(qa), 'QA 分頁把 run 傳給面板')
  ok(/<DerivedReview/.test(qa), 'QA 分頁也有推導定同意／推翻')
  ok(/<PreviewPane /.test(deck) && /onPeek=\{/.test(deck), '面板有示意框，游標停哪個選項就顯示哪張（仿 VS Code 提問預覽）')
  ok(/preview: o\.preview \|\| ''/.test(deck), '說明整理出的選項也帶示意')
  ok(/<MotionPreview text=\{motion\} \/>/.test(deck) && /motion: o\.motion \|\| ''/.test(deck), '示意框會播動態示意（條目或說明來的都行）')
  const mp = fs.readFileSync(path.join(HERE, '..', 'client', 'src', 'MotionPreview.jsx'), 'utf8')
  ok(/requestAnimationFrame/.test(mp) && /<Scene sim=\{sim\} values=\{values\} \/>/.test(mp) && /RATES = \[\[1, '1×'\], \[0\.5, '½×'\], \[0\.25, '¼×'\]\]/.test(mp), '動態示意＝曲線＋播放頭＋畫面模擬，可慢放')
}

console.log(`\n結果：${pass} 通過、${fail} 失敗`)
process.exit(fail ? 1 : 0)
