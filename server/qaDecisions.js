// QA Run 待定奪的純邏輯（少爺 2026-10-08「QA Run 待我定奪的互動方式與侍酒師的待定奪一樣的形式，統一設計」）。
//
// 一個 run 的待定奪＝它的計畫書（run.qapPath）「待定奪」段：
//   ① 段內 `- [ ] OPEN-n` 條目＝只屬於本 run 的題（實作時機、修法、範圍…），格式同意圖檔（open_decisions.mjs）
//   ② 段內條目以外、寫了「待定奪」的那一行（含段標題）＝宣告本 run 掛的設計題：
//      `[[X]]`／`X.md`／`design_intent/X.md`＝整份未定題；`[[X]] OPEN-n`＝單題
//      （例：段標題「待定奪（同步寫在設計脈絡 `design_intent/HitStop.md`）」、「本 run 的設計題（待定奪）：[[ExtractionHoldout]]、[[DesignPillars]] OPEN-1」）
//      沒寫待定奪的行只是提到別的題（依據、連動、數獨推導筆記），不算；牽動／取決於／解鎖／依據／推導這類關係行與關係詞後面的引用也不算
//      2026-10-08 實測舊稿：「依據 [[FormationChargeStun]] INV-2」、「[[S12_…]] OPEN-1 → 推導：…」、「連動題（不在本輪做）：[[X]] OPEN-2」都曾被誤收
//   ③ run.decisionSources（選填）＝沒有計畫書或要額外掛的來源：`X`（整份）、`X OPEN-n`、`[[X]] OPEN-n`
// 本模組只放拆段與字串解析；檔案存在與否、萃取資料在 index.js「QA Run 的待定奪」段；機檢在 qaDecisions.check.mjs。

/** 計畫書的待定奪段標題：舊稿常寫「待少爺定／要少爺定」，一併認得（新稿一律「待定奪」） */
export const QA_DECISION_SECTION_RE = /待定奪|待少爺定|要少爺定/

const ITEM_HEAD_RE = /^\s*-\s*\[[ xX]\]\s*\**OPEN-\d+/
const FENCE_RE = /^\s*(`{3,}|~{3,})/

/** 條目範圍的結尾（三層共用：意圖檔／情境檔／計畫書）：標題行之後、有縮排、不是下一個條目的行；
 *  「示意」的 ``` 區塊整塊算在條目內（圖裡可能有空行——沒這條，寫回的少爺回覆會插進圖中間） */
export function decisionBlockEnd(InLines, InHead, InSecEnd, InHeadRe = ITEM_HEAD_RE) {
  let _end = InHead + 1
  let _fence = null
  while (_end < InSecEnd) {
    const l = InLines[_end]
    if (_fence) { if (l.trim().startsWith(_fence)) _fence = null; _end++; continue }
    if (!/^\s+\S/.test(l) || InHeadRe.test(l)) break
    _fence = l.match(FENCE_RE)?.[1] ?? null
    _end++
  }
  return _end
}

/** 段內條目以外的文字（含段標題）：條目標題行與其子項（含示意區塊）略過 */
export function decisionSectionFreeLines(InHeading, InSectionLines) {
  const out = [InHeading]
  for (let i = 0; i < InSectionLines.length; i++) {
    if (!ITEM_HEAD_RE.test(InSectionLines[i])) { out.push(InSectionLines[i]); continue }
    i = decisionBlockEnd(InSectionLines, i, InSectionLines.length) - 1
  }
  return out
}

/** 文字裡的意圖／情境引用：`[[X]]`、`[[X]] OPEN-n`、`X.md`、`design_intent/X.md` → [{ id, openId }]（只做字串解析，存不存在由呼叫端判） */
export function decisionLinkRefs(InText) {
  const out = []
  const _seen = new Set()
  const _push = (InId, InOpenId) => {
    const _k = `${InId}|${InOpenId ?? '*'}`
    if (_seen.has(_k)) return
    _seen.add(_k)
    out.push({ id: InId, openId: InOpenId ?? null })
  }
  const _text = String(InText ?? '')
  for (const m of _text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\](?:\s*(OPEN-\d+))?/g)) _push(m[1].trim(), m[2] ?? null)
  for (const m of _text.matchAll(/(?:^|[\s`'"（(／/])(?:design_intent\/|scenario\/)?([A-Z]\w*)\.md\b/g)) _push(m[1], null)
  return out
}

// 關係行（條目子項或舊稿的欄位）：牽動、取決於、解鎖、依據、推導…——裡面的引用是連動題或引用依據
const RELATION_LINE_RE = /^\s*(?:[-*>|]\s*)*(?:\*\*)?\s*(?:牽動|取決於|解鎖|依據|推導|連動|相關|附帶|事實|現況)/
// 單題引用前面緊接著這些詞＝關係（例：「取決於 [[DesignPillars]] OPEN-1」），不是本 run 的題
const RELATION_WORD_BEFORE_RE = /(?:牽動|取決於|解鎖|依據|推導|連動|併入|見於)[：:\s]*$/

/** 計畫書待定奪段宣告本 run 掛的設計題（規則見檔頭 ②）→ [{ id, openId }] */
export function decisionDeclarationRefs(InFreeLines) {
  const out = []
  const _seen = new Set()
  const _push = (InRef) => {
    const _k = `${InRef.id}|${InRef.openId ?? '*'}`
    if (_seen.has(_k)) return
    _seen.add(_k)
    out.push(InRef)
  }
  for (const l of InFreeLines) {
    if (!/定奪/.test(l) || RELATION_LINE_RE.test(l)) continue
    for (const m of l.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]\s*(OPEN-\d+)/g))
      if (!RELATION_WORD_BEFORE_RE.test(l.slice(Math.max(0, m.index - 8), m.index))) _push({ id: m[1].trim(), openId: m[2] })
    // 整份：單題引用先拿掉，免得同一個檔被當成整份
    for (const r of decisionLinkRefs(l.replace(/\[\[[^\]]+\]\]\s*OPEN-\d+/g, ''))) _push(r)
  }
  return out
}

/** run.decisionSources 的一筆 → 可給 decisionLinkRefs 的文字（`X`／`X OPEN-n`／`X#OPEN-n` 補成 wiki 連結） */
export function normalizeDecisionSource(InText) {
  const _t = String(InText ?? '').trim()
  if (_t.includes('[[')) return _t
  const _m = _t.match(/^(\w+)(?:\s*[#:\s]\s*(OPEN-\d+))?$/)
  return _m ? `[[${_m[1]}]]${_m[2] ? ` ${_m[2]}` : ''}` : _t
}

/** 舊格式題目（### Q1、- **Q1、表格列…）的行數：面板讀不到，用來提示「請 Claude 轉成標準格式」。
 *  段內已掛設計題時，`OPEN-n` 開頭的標題／列多半是意圖檔題目的摘要（舊稿「同步寫在設計脈絡」），不算 */
export function legacyQuestionCount(InFreeLines, InHasLinks) {
  const _q = /^\s*(?:#{3,5}\s*|[-*]\s*\*\*|\|\s*)\**(?:Q|D-)\d+/
  const _open = /^\s*(?:#{3,5}\s*|[-*]\s*\*\*|\|\s*)\**OPEN-\d+/
  return InFreeLines.filter(l => _q.test(l) || (!InHasLinks && _open.test(l))).length
}
