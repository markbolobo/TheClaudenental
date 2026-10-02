// 待定奪面板的非元件共用（拆出 DecisionDeck.jsx 讓 Fast Refresh 只看到元件）：
// 題目 key、作答草稿（localStorage，換視圖／重整不丟）、兩層資料 → 面板條目。

/** 一題的 key＝server 說明快取／派工紀錄的 key：專案|層|來源 id|OPEN-n */
export const decisionKey = (pid, layer, sourceId, openId) => `${pid}|${layer}|${sourceId}|${openId}`

const DRAFT_STORE_KEY = 'tc_decision_drafts_v1'
export function loadDecisionDrafts() {
  try { return JSON.parse(localStorage.getItem(DRAFT_STORE_KEY)) ?? {} } catch { return {} }
}
export function saveDecisionDrafts(InDrafts) {
  try { localStorage.setItem(DRAFT_STORE_KEY, JSON.stringify(InDrafts)) } catch { /* 無痕視窗／配額滿：草稿只留在記憶體 */ }
}

/** 草稿算不算「已答」：選了選項，或在「其他」寫了想法 */
export function isDraftAnswered(InDraft) {
  if (!InDraft) return false
  return (InDraft.kind === 'choose' && !!InDraft.choiceKey) || (InDraft.kind === 'reply' && !!InDraft.text?.trim())
}

// 清單檢視 ↔ 定奪面板（少爺 2026-09-29：預設面板，舊清單保留可切）
const VIEW_STORE_KEY = 'tc_decision_view'
export function loadDecisionView() {
  try { return localStorage.getItem(VIEW_STORE_KEY) === 'list' ? 'list' : 'deck' } catch { return 'deck' }
}
export function saveDecisionView(InView) {
  try { localStorage.setItem(VIEW_STORE_KEY, InView) } catch { /* 同上 */ }
}

/**
 * 一題在數獨盤面上的關係（graph＝server /api/decisions/state 的 { nodes, edges }）：
 * up＝上游關鍵題（本題取決於它）、down＝本題解鎖的下游題、refs＝明示引用；*Open＝其中還沒定的
 */
export function relationsOf(InGraph, InKey) {
  const out = { up: [], upOpen: [], down: [], downOpen: [], refs: [] }
  if (!InGraph) return out
  const _push = (InList, InNode) => { if (!InList.some(n => n.key === InNode.key)) InList.push(InNode) }
  for (const e of InGraph.edges?.[InKey] ?? []) {
    const n = InGraph.nodes?.[e.key]
    if (!n) continue
    const _up = (e.kind === 'depends' && e.dir === 'out') || (e.kind === 'unlocks' && e.dir === 'in')
    const _down = (e.kind === 'unlocks' && e.dir === 'out') || (e.kind === 'depends' && e.dir === 'in')
    if (_up) { _push(out.up, n); if (!n.resolved) _push(out.upOpen, n) }
    else if (_down) { _push(out.down, n); if (!n.resolved) _push(out.downOpen, n) }
    else _push(out.refs, n)
  }
  out.refs = out.refs.filter(n => !out.up.some(u => u.key === n.key) && !out.down.some(d => d.key === n.key))
  return out
}

/** 推導定（Claude 依脈絡推出、待少爺確認）的條目：設計脈絡 */
export function intentDerivedItems(InProjectId, InIntents) {
  return (InIntents ?? []).flatMap(it => (it.openDecisions ?? []).filter(d => d.resolved && d.resolvedBy === 'derived').map(d => ({
    key: decisionKey(InProjectId, 'intent', it.id, d.id), layer: 'intent', sourceId: it.id, sourceTitle: it.title, file: it.file, d,
  })))
}

/** 推導定的條目：情境體驗 */
export function scenarioDerivedItems(InProjectId, InScenarios) {
  return (InScenarios ?? []).flatMap(s => (s.openDecisions ?? []).filter(d => d.resolved && d.resolvedBy === 'derived').map(d => ({
    key: decisionKey(InProjectId, 'scenario', s.id, d.id), layer: 'scenario', sourceId: s.id, sourceTitle: s.title, file: s.file, d,
  })))
}

/** 設計脈絡 → 面板條目（只收未定案） */
export function intentDeckItems(InProjectId, InIntents) {
  return (InIntents ?? []).flatMap(it => (it.openDecisions ?? []).filter(d => !d.resolved).map(d => ({
    key: decisionKey(InProjectId, 'intent', it.id, d.id),
    layer: 'intent', sourceId: it.id, sourceTitle: it.title, file: it.file, d,
  })))
}

/** 情境體驗 → 面板條目（只收未定案） */
export function scenarioDeckItems(InProjectId, InScenarios) {
  return (InScenarios ?? []).flatMap(s => (s.openDecisions ?? []).filter(d => !d.resolved).map(d => ({
    key: decisionKey(InProjectId, 'scenario', s.id, d.id),
    layer: 'scenario', sourceId: s.id, sourceTitle: s.title, file: s.file, d,
  })))
}
