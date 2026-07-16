// 活互動 session（VS Code 開著的）判別＋警示（少爺 2026-07-14 拍板「警示＋照送」）
// 背景：TC 對活的 VS Code session 只能無頭 resume——該分頁不會即時顯示、且與其進程有雙寫 transcript 風險。
// /api/sessions 只含 hook 註冊的互動 session（TC spawn 的 subprocess 在 server 入口就被濾掉），在清單內＝互動 session。

/** 取得目前互動 session id 集合（呼叫端自行決定快取策略）；TC 出身（origin:'tc'）不算 VS Code 互動 session */
export async function fetchLiveInteractiveIds() {
  try {
    const d = await fetch('/api/sessions').then(r => r.json())
    return new Set((d.sessions ?? []).filter(s => s.origin !== 'tc').map(s => s.id))
  } catch { return new Set() }
}

/** 目標是活互動 session 時跳確認框；不是（或查詢失敗）直接放行。回傳 true=照送 */
export async function confirmIfLiveInteractive(sessionId, actionLabel = '送入') {
  if (!sessionId) return true
  try {
    const d = await fetch('/api/sessions').then(r => r.json())
    const hit = (d.sessions ?? []).find(s => s.id === sessionId)
    if (!hit) return true
    // TC 出身的聊天室（2026-07-15 起會進側欄）不是 VS Code 分頁——無頭喚醒它本來就是正解，不警示
    if (hit.origin === 'tc') return true
    return window.confirm(
      `⚠️ 目標聊天室「${hit.displayName ?? sessionId.slice(0, 8)}」是 VS Code 開著的活 session（狀態 ${hit.status}）。\n` +
      `無頭${actionLabel}後：VS Code 分頁不會即時顯示處理過程，且與該分頁的進程有雙寫 transcript 風險。\n` +
      `建議直接在 VS Code 該聊天室輸入。\n\n仍要${actionLabel}嗎？`)
  } catch { return true }
}
