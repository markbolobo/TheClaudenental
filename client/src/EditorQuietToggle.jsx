// ─── Editor 勿擾（少爺 2026-10-30「雙編譯Unreal時的提示通知也有勿擾功能，啟動後，不會再跳出提示，會直接關閉Editor…而且啟動Editor也是勿擾，這個開關會一次控兩個」）────────
// 一個開關同時管兩件事（TC 總設定 build.quiet.editor）：
//   ① Close-UEEditor-WithCountdown.ps1：不跳倒數視窗、直接關 Editor（照舊先送關閉訊息、等它自己存好再收尾）
//   ② Launch-UEEditor.ps1：經 RunHidden 啟動，不閃主控台視窗（Editor 本身照常出現）
// 關閉＝兩支腳本照舊（倒數視窗＝少爺的確認）；TC 不在線時腳本一律當作關閉。
import { useEffect, useState } from 'react'

const KEY = 'build.quiet.editor'
export const EDITOR_QUIET_HINT = 'Editor 勿擾：開啟＝雙編譯要關 Editor 時不跳倒數視窗、直接關；啟動 Editor 不閃主控台視窗。一個開關同時控這兩件'

export default function EditorQuietToggle() {
  const [quiet, setQuiet] = useState(null)   // null＝未知
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let _stop = false
    const _poll = () => fetch('/api/settings')
      .then(r => r.json()).then(d => { if (!_stop) setQuiet(d?.[KEY] === true) })
      .catch(() => { if (!_stop) setQuiet(null) })
    _poll()
    const _t = setInterval(_poll, 10_000)
    return () => { _stop = true; clearInterval(_t) }
  }, [])

  const toggle = async () => {
    if (quiet === null) return
    setBusy(true)
    try {
      const _r = await fetch('/api/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [KEY]: quiet ? null : true }),
      }).then(r => r.json())
      if (_r.ok) setQuiet(_r.settings?.[KEY] === true)
    } catch {}
    setBusy(false)
  }

  const _label = busy ? '套用中…' : quiet === null ? '🔔 Editor?' : quiet ? '🔕 Editor 勿擾' : '🔔 Editor 提示'
  return (
    <button type="button" onClick={toggle} disabled={busy || quiet === null} title={EDITOR_QUIET_HINT}
      className={`text-[9px] border rounded-sm px-1.5 py-0.5 transition-colors tracking-wide disabled:opacity-50 ${quiet
        ? 'text-sky-300 border-sky-400/50 bg-sky-400/10 hover:bg-sky-400/20'
        : 'text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--gold)] hover:border-[var(--gold-border)]'}`}>
      {_label}
    </button>
  )
}
