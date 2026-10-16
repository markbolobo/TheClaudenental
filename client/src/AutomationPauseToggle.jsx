// ─── 自動化總開關（少爺 2026-10-15「先停止監看PIE…在TC做開關」→「TC直接做總開關就好」）────────
// 暫停＝所有聊天室的 Watch-QAComments 監看自行結束、TC 不再要求補掛、Editor Python 閘道擋下會開 PIE 的腳本；
// 恢復＝TC 直投通知暫停前有掛監看的聊天室重掛。TC 直投送進分頁的訊息不受影響。
import { useEffect, useState } from 'react'

export const AUTOMATION_PAUSE_HINT = '自動化總開關：暫停＝所有聊天室停止 QA 留言／TC 訊息監看、不自動補掛、不准自動開 PIE；恢復＝通知原本有監看的聊天室重掛'

export default function AutomationPauseToggle() {
  const [paused, setPaused] = useState(null)   // null＝未知
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let _stop = false
    const _poll = () => fetch('/api/automation-pause')
      .then(r => r.json()).then(d => { if (!_stop) setPaused(!!d.paused) })
      .catch(() => { if (!_stop) setPaused(null) })
    _poll()
    const _t = setInterval(_poll, 10_000)
    return () => { _stop = true; clearInterval(_t) }
  }, [])

  const toggle = async () => {
    if (paused === null) return
    setBusy(true)
    try {
      const _r = await fetch('/api/automation-pause', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: !paused }),
      }).then(r => r.json())
      if (_r.ok) setPaused(!!_r.paused)
    } catch {}
    setBusy(false)
  }

  const _label = busy ? '套用中…' : paused === null ? '👁 自動化?' : paused ? '⏸ 自動化暫停' : '👁 自動化中'
  return (
    <button type="button" onClick={toggle} disabled={busy || paused === null} title={AUTOMATION_PAUSE_HINT}
      className={`text-[9px] border rounded-sm px-1.5 py-0.5 transition-colors tracking-wide disabled:opacity-50 ${paused
        ? 'text-amber-300 border-amber-400/50 bg-amber-400/10 hover:bg-amber-400/20'
        : 'text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--gold)] hover:border-[var(--gold-border)]'}`}>
      {_label}
    </button>
  )
}
