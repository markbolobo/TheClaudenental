// 模型目錄機檢：`node modelCatalog.check.mjs`（或 `npm run check:models`）
//
// 少爺 2026-09-24「當官方發布新的就要更新 TC 可以使用的模型」。這支把當時壞掉的四件事釘成回歸測試：
//   1. 已退役模型（Sonnet 3.7／Haiku 3.5）不得出現在下拉
//   2. 二進位切半產生的幻影（Haiku 3.55）不得出現在下拉
//   3. 真的新模型（官方表還沒收錄）要自動出現在「現役」段並標 ⚠
//   4. 官方表取不到時要退回上次學到的那份，不准倒退
// 第 3 條沒辦法等官方真的發新模型，所以用假二進位模擬——掃描器只是對檔案做字串比對，
// 餵一個含 `claude-opus-6` 的文字檔就等同於「Claude Code 升版帶進新 alias」。

import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildCatalog, priceFor, CATALOG_FILE } from './modelCatalog.js'
import { loadSkillCatalog, canonKey } from './modelSkillSource.js'
import { loadPushedModels, claudeVersionFromPath, compareClaudeVersion } from './modelPushSource.js'

let pass = 0
let fail = 0

function ok(InCond, InLabel, InDetail = '') {
  if (InCond) { pass++; console.log(`  ✅ ${InLabel}`) }
  else { fail++; console.log(`  ❌ ${InLabel} ${InDetail}`) }
}

/** 跟 server 同一套 claude.exe 偵測（VS Code extension 優先，沒有就退 PATH）。 */
function findClaudeExe() {
  const _extDir = path.join(os.homedir(), '.vscode', 'extensions')
  try {
    const _dirs = fs.readdirSync(_extDir).filter(d => d.startsWith('anthropic.claude-code'))
      .sort((a, b) => compareClaudeVersion(claudeVersionFromPath(a) ?? '0', claudeVersionFromPath(b) ?? '0') ?? a.localeCompare(b))
      .reverse()
    for (const _d of _dirs) {
      const _c = path.join(_extDir, _d, 'resources', 'native-binary', 'claude.exe')
      if (fs.existsSync(_c)) return _c
    }
  } catch {}
  return 'claude'
}

const CLAUDE_EXE = findClaudeExe()

console.log('\n【1】真實 claude.exe')
const real = buildCatalog(CLAUDE_EXE)
const selectable = new Set(real.models.filter(m => m.current || m.selectable).map(m => m.id))
ok(!selectable.has('claude-sonnet-3-7'), 'Sonnet 3.7（2026-02-19 退役）不在下拉')
ok(!selectable.has('claude-haiku-3-5'), 'Haiku 3.5（2026-02-19 退役）不在下拉')
ok(!selectable.has('claude-haiku-3-55'), '幻影 Haiku 3.55 不在下拉')
ok(selectable.has('claude-fable-5'), 'Fable 5 沒被 Fable 5.1 的殘影過濾誤殺')
const estimatedCurrent = real.models.filter(m => m.current && m.pricingEstimated)
ok(estimatedCurrent.every(m => m.status === 'new'), '現役裡標 ⚠ 的一律是官方表還沒收錄的新模型，其餘都有官方／內建價',
  JSON.stringify(estimatedCurrent.map(m => `${m.id}:${m.status}`)))
ok(real.models.every(m => Number.isFinite(m.pricing.input) && Number.isFinite(m.pricing.cacheWrite)), '每一筆都算得出價，沒有 NaN')

console.log('\n【2】模擬官方發新模型（假二進位）')
const fakeExe = path.join(os.tmpdir(), 'tc_model_catalog_check_bin.txt')
fs.writeFileSync(fakeExe, [
  'claude-opus-6', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5',
  'claude-sonnet-3-7', 'claude-haiku-3-55', 'claude-mythos-6', 'claude-quasar-1',
].join('\n'), 'utf8')
const simulated = buildCatalog(fakeExe)
const opus6 = simulated.models.find(m => m.id === 'claude-opus-6')
ok(!!opus6 && opus6.current, 'Opus 6 自動進「現役」段')
ok(opus6?.pricingEstimated && opus6?.estimatedFrom === 'claude-opus-5', 'Opus 6 價沿用同 tier 的 Opus 5 並標 ⚠', JSON.stringify(opus6?.estimatedFrom))
ok(!!simulated.models.find(m => m.id === 'claude-mythos-6')?.current, '官方表認得的家族出新版（Mythos 6）也自動進現役')
ok(!simulated.models.some(m => m.id === 'claude-quasar-1'), '官方表沒聽過的家族（Quasar）不收，雜訊擋在門外')
ok(simulated.newlyDiscovered.includes('claude-opus-6'), 'newlyDiscovered 有報出新模型')
fs.rmSync(fakeExe, { force: true })

console.log('\n【3】官方表取不到時的退路')
ok(loadSkillCatalog('C:/definitely-not-a-real-temp-dir') === null, 'skill 目錄不存在 → 回 null，不丟例外')
const persisted = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'))
ok(persisted.learned?.models?.length > 0, `官方表已落地 learned（${persisted.learned?.models?.length ?? 0} 筆），skill 目錄被清也還在`)
ok(persisted.learned?.byCanon?.length > 0, '退役索引一併落地')

console.log('\n【4】成本回算')
buildCatalog(CLAUDE_EXE)                                                // 回到真實目錄，別把模擬結果留在檔案裡
ok(canonKey('claude-opus-4-5-20251101') === canonKey('claude-opus-4-5'), 'canonKey 讓歷史 transcript 的含日期全名對回 alias')
const dated = priceFor('claude-opus-4-5-20251101', CLAUDE_EXE)
ok(dated.input === 5 && dated.output === 25, 'Opus 4.5 含日期全名取得到自己的價，不退到 tier 猜測', JSON.stringify(dated))

console.log('')
console.log('【5】官方推播（~/.claude.json）')
const fixture = path.join(os.tmpdir(), 'tc_model_push_check.json')
fs.writeFileSync(fixture, JSON.stringify({
  additionalModelOptionsCache: [
    { value: 'claude-fable-5-1[1m]', label: 'Fable', description: 'Fable 5.1 · Most capable for your hardest tasks' },
    { value: 'cc-update-required-1', label: 'Opus 5.5 (disabled)', description: 'Update to 2.1.280+ to use Opus 5.5', disabled: true },
  ],
  cachedGrowthBookFeatures: { tengu_startup_announcements: [{ id: 'opus-5-5-update', title: 'Introducing Opus 5.5', text: '...' }] },
}), 'utf8')
const pushed = loadPushedModels(fixture)
ok(pushed.models.length === 1 && pushed.models[0].id === 'claude-fable-5-1[1m]', '真 model id 的推播選項收進來（含 [1m] 脈絡變體）', JSON.stringify(pushed.models))
ok(pushed.models[0].label === 'Fable 5.1', '標籤取自 description 的模型名，而不是縮寫的 label', pushed.models[0].label)
ok(pushed.blocked.length === 1 && pushed.blocked[0].requiresVersion === '2.1.280', '不是 model id 的那格解成「要升版才能用」並抓到版本門檻', JSON.stringify(pushed.blocked))
ok(pushed.blocked[0].label === 'Opus 5.5', 'blocked 標籤去掉 (disabled) 後綴', pushed.blocked[0].label)
ok(pushed.announcements[0]?.modelLabel === 'Opus 5.5', '公告 Introducing 後面的模型名解得出來', JSON.stringify(pushed.announcements))
fs.rmSync(fixture, { force: true })
ok(compareClaudeVersion('2.1.278', '2.1.280') < 0, '2.1.278 < 2.1.280')
ok(compareClaudeVersion('2.1.281', '2.1.280') >= 0, '2.1.281 >= 2.1.280（門檻達標 → blocked 該自己消失）')
ok(compareClaudeVersion('2.1.300', '2.1.99') > 0, '2.1.300 > 2.1.99（字串排序會排反的那組）')
ok(claudeVersionFromPath('C:/x/anthropic.claude-code-2.1.281-win32-x64/y') === '2.1.281', '從擴充目錄名解得出 Claude Code 版本')
ok(canonKey('claude-opus-5[1m]') === canonKey('claude-opus-5'), '[1m] 脈絡變體對得回本尊（價與狀態共用）')

console.log(`\n通過 ${pass} 項，失敗 ${fail} 項`)
process.exit(fail ? 1 : 0)
