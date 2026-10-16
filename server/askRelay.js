// 提問中繼：VS Code／終端分頁的 AskUserQuestion 在 TC Chat 顯示，並可由 TC 代答。
//
// 少爺 2026-10-08「我要TC的Chat也能像是VS Code顯示這些問題還有選項，並且TC此時要多一個陪聊…
// 我可以選擇是直接操作原本的選項，或是讓陪聊把內容填入其他選項」。
// 路線（Claude Code 2.1.293 實測）：提問走權限詢問，PermissionRequest hook 與分頁的對話框並行、先回者勝；
// hook 回 allow＋updatedInput（原輸入＋answers）＝代答，分頁對話框隨即收掉。
// 本模組只放純邏輯（提問識別鍵、作答組裝與驗證、對話紀錄掃描），長輪詢與狀態在 index.js，機檢在 askRelay.check.mjs。

import crypto from 'crypto'

export const ASK_TOOL = 'AskUserQuestion'

/** 題目清單（缺欄位補成空值，面板與作答驗證共用） */
export function askQuestionsOf(InInput) {
  const _list = Array.isArray(InInput?.questions) ? InInput.questions : []
  return _list.filter(q => q && typeof q.question === 'string').map(q => ({
    ...q,
    header: String(q.header ?? ''),
    options: (Array.isArray(q.options) ? q.options : []).filter(o => o && typeof o.label === 'string'),
    multiSelect: q.multiSelect === true,
    kind: q.kind ?? 'choice',
  }))
}

/** 同一組提問的識別鍵：聊天室＋題目與選項標籤的雜湊——hook 重送、TC 重啟後重新登記、從對話紀錄偵測到的都對得上 */
export function askKeyOf(InSessionId, InInput) {
  const _sig = askQuestionsOf(InInput).map(q => [q.question, q.options.map(o => o.label)])
  return `${InSessionId}:${crypto.createHash('sha1').update(JSON.stringify(_sig)).digest('hex').slice(0, 12)}`
}

/** 記錄用的一行摘要：各題短標 */
export function askSummary(InInput) {
  return askQuestionsOf(InInput).map(q => q.header || q.question.slice(0, 12)).join('／')
}

/**
 * 少爺的作答 → PermissionRequest hook 的回應。
 * @param InAnswers { [題目原文]: 選項標籤 | 標籤陣列（複選）| 自由文字（其他） }
 * @param InNotes { [題目原文]: 補充說明 }（Claude Code 的 annotations.notes）
 * @returns { ok, output, answered } | { ok:false, error }
 */
export function buildAskAnswer(InInput, InAnswers, InNotes = {}) {
  const _qs = askQuestionsOf(InInput)
  if (!_qs.length) return { ok: false, error: '這次提問沒有題目' }
  const _answers = {}
  for (const [_k, _v] of Object.entries(InAnswers ?? {})) {
    const _q = _qs.find(q => q.question === _k)
    if (!_q) return { ok: false, error: `沒有這一題：${String(_k).slice(0, 40)}` }
    let _val = ''
    if (Array.isArray(_v)) {
      const _list = _v.map(x => String(x ?? '').trim()).filter(Boolean)
      if (_list.length > 1 && !_q.multiSelect) return { ok: false, error: `「${_q.header || _q.question.slice(0, 12)}」是單選` }
      _val = _list.join(', ')
    } else _val = String(_v ?? '').trim()
    if (_val) _answers[_k] = _val
  }
  const _annotations = {}
  for (const [_k, _v] of Object.entries(InNotes ?? {})) {
    const _n = String(_v ?? '').trim()
    if (_n && _qs.some(q => q.question === _k)) _annotations[_k] = { notes: _n }
  }
  if (!Object.keys(_answers).length && !Object.keys(_annotations).length) return { ok: false, error: '還沒有作答' }
  const { answers: _drop1, annotations: _drop2, ..._rest } = InInput ?? {}
  const _updated = { ..._rest, answers: _answers, ...(Object.keys(_annotations).length ? { annotations: _annotations } : {}) }
  return {
    ok: true,
    answered: Object.keys(_answers).length,
    output: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: _updated } } },
  }
}

/** 回給 hook 的 JSON：非 ASCII 一律 \u 跳脫——hook 指令在 Windows 經 Git Bash 轉手，原樣中文有被轉碼弄壞的實測前例 */
export function asciiJson(InObj) {
  return JSON.stringify(InObj).replace(/[\u007f-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/**
 * 掃對話紀錄（JSONL 文字）找還沒作答的提問：最後一個 AskUserQuestion 的 tool_use 之後沒有對應的 tool_result。
 * @returns { toolUseId, input, ts, lead } | null；lead＝提問前聊天室最後說的那段話（面板與陪聊的前情）
 */
export function findOpenAsk(InJsonlText) {
  let _open = null
  let _lastText = ''
  for (const _line of String(InJsonlText ?? '').split('\n')) {
    if (!_line.includes('"assistant"') && !_line.includes('"tool_result"')) continue
    let _o
    try { _o = JSON.parse(_line) } catch { continue }
    if (_o.isSidechain) continue
    const _c = _o.message?.content
    if (!Array.isArray(_c)) continue
    if (_o.type === 'assistant') {
      for (const _b of _c) {
        if (_b?.type === 'text' && String(_b.text ?? '').trim()) _lastText = _b.text.trim()
        if (_b?.type === 'tool_use' && _b.name === ASK_TOOL) _open = { toolUseId: _b.id, input: _b.input ?? {}, ts: Date.parse(_o.timestamp) || null, lead: _lastText }
      }
    } else if (_o.type === 'user' && _open && _c.some(b => b?.type === 'tool_result' && b.tool_use_id === _open.toolUseId)) _open = null
  }
  return _open
}

/** 對話紀錄裡這個提問有沒有結果了（已作答、被取消都算） */
export function askHasResult(InJsonlText, InToolUseId) {
  return !!InToolUseId && String(InJsonlText ?? '').includes(`"tool_use_id":"${InToolUseId}"`)
}
