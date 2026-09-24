// 情境體驗層的非元件共用：購物車 key 與結帳 prompt 壓縮（拆出 ScenarioView.jsx 讓 Fast Refresh 只看到元件）
export const scenarioKey = (pid, sid) => `${pid}:scenario:${sid}`
export const SCENARIO_NEW_KEY = (pid) => `${pid}:scenario:__NEW__`
export const stripSource = (t) => (t ?? '').replace(/[（(]出處[：:][^）)]*[）)]/g, '').trim()

// 結帳 prompt 用：把情境壓成幾行（與 Sommelier.jsx composePrompt 的其他 nodeKind 同風格）
export function scenarioPromptLines(idx, it) {
  const lines = [`${idx + 1}. 【情境體驗】${it.scenarioTitle}（${it.phase}／${it.flow}／${it.status}）`]
  if (it.oneLiner) lines.push(`   一句話: ${it.oneLiner.slice(0, 300)}`)
  if (it.thesis?.length) lines.push(`   題目對照: ${it.thesis.map(t => `${t.dimension}${t.marker ?? '○'}${stripSource(t.answer).replace(/\s+/g, ' ').slice(0, 80)}`).join(' | ').slice(0, 900)}`)
  if (it.gaps?.length) lines.push(`   💡 缺口(待定): ${it.gaps.map(g => `${g.id ?? ''} ${g.text}`.trim()).join(' | ').slice(0, 700)}`)
  if (it.openDecisions?.length) lines.push(`   ⬜ 待定奪(需業主決策): ${it.openDecisions.map(d => `${d.id} ${d.title}${d.options ? `〔選項 ${d.options}〕` : ''}`).join(' | ').slice(0, 700)}`)
  if (it.intentLinks?.length) lines.push(`   涵蓋意圖: ${it.intentLinks.join(', ')}`)
  lines.push('   → 依 .agent/workflows/z_sub_scenario_experience.md 走「讀→訪談(≤5題，九面向)→補完→定奪」；事實附出處、提案標 💡')
  return lines
}
export function newScenarioPromptLines(idx) {
  return [
    `${idx + 1}. 【新情境】請依 .agent/workflows/z_sub_scenario_experience.md §1.2 建骨架（scenario/S##_<Id>.md，14 段含「題目對照」九面向），跑 Check-ScenarioExperience.py，然後用九面向訪談我（≤5 題）。情境名與階段見上方需求描述。`,
  ]
}
