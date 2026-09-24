// 🔁 重新登入聯動（少爺 2026-09-16「讓以後 TC 觸發的聊天室都具備，提供我可以重新登入聯動聊天室的功能」）
// TC 自己 spawn 的聊天室是無頭出身，永遠做不到原地聯動。這裡請 server 在終端開 `claude --resume <sid>`
// 把它重新登入成活的互動 session（註冊表 kind:interactive），起手 prompt 會叫它立刻掛起監看；
// 之後 QA ▶／留言／結案與侍酒師結帳都會原地送進它。已是活分頁時 server 回 alreadyLive，只提示不重開。
export async function reloginSession(sessionId, projectPath = null, label = '') {
  if (!sessionId) return false
  try {
    const d = await fetch('/api/session/relogin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, projectPath }),
    }).then(r => r.json())
    if (!d.ok) {
      window.alert(`🔁 重新登入聯動${label ? `（${label}）` : ''}：${d.error ?? '未知錯誤'}`)
      return false
    }
    return true
  } catch (e) {
    window.alert(`🔁 重新登入聯動失敗：${e}`)
    return false
  }
}
