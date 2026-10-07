// ─── 勿擾開關（少爺 2026-10-06）：酒窖工具／誓約逐項設定「執行時不跳出主控台視窗」────────
// 開＝只拿掉主控台／終端視窗；工具自己的介面與對話框照常出現。pending＝偏好已改、排程實況還在補套。

export const QUIET_HINT = '勿擾：執行時不跳出主控台／終端視窗（工具自己的介面與對話框照常出現）'

export default function QuietToggle({ on, busy = false, pending = false, disabled = false, title, onToggle }) {
  const _label = busy ? '套用中…' : pending ? '🔕 套用中' : on ? '🔕 勿擾' : '🔔 勿擾關'
  return (
    <button
      type="button"
      disabled={busy || disabled}
      title={title ?? QUIET_HINT}
      onClick={e => { e.stopPropagation(); onToggle?.(!on) }}
      className={`text-[9px] px-1.5 py-0.5 rounded border shrink-0 transition-colors disabled:opacity-50 ${on
        ? 'text-[var(--gold)] border-[var(--gold-border)] bg-[var(--gold)]/10 hover:bg-[var(--gold)]/20'
        : 'text-[var(--text-muted)] border-[var(--border)] hover:border-[var(--gold-border)]'}`}>
      {_label}
    </button>
  )
}
