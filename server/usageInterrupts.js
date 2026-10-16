// 用量上限中斷的自動續接：純判斷（錯誤分類、重設時間、到點後該怎麼做、這一批續接誰）。
//
// 少爺 2026-10-10「若是恢復成單一帳號的情況下，有時候Token也會用到滿，使得工作被中斷，（我希望系統可以自動辨識，
// 當Token用完且工作被中斷，若是其中一個帳號已經停止會籍，就不會切換該帳號，而是等原帳號的冷卻到了，自動繼續被中斷的聊天室）」
// 少爺 2026-10-10「自動接續的設計，是可以關閉的嗎，有時候我希望控管Token(因為主要帳號還有其他人使用，所以我希望可以有開關)」
// ⇒ 偵測與記帳永遠開（不花用量）；只有「自動續接」受總設定開關與用量護欄控制，預設關。
// 本模組只放純判斷；記帳、逐字稿掃描、續接投遞在 index.js，機檢在 usageInterrupts.check.mjs。

/** 帳號本身不能用（帳務、暫停、登入失效）：永不自動續接、只通知 */
export const ACCOUNT_UNAVAILABLE_ERRORS = ['billing_error', 'account_on_hold', 'authentication_failed', 'oauth_org_not_allowed']
/** 伺服器端短暫問題：幾分鐘後再接 */
export const TRANSIENT_ERRORS = ['overloaded', 'server_error']

/** 自動續接的預設值（總設定未設時） */
export const AUTO_RESUME_DEFAULTS = {
  enabled: true,           // 被中斷的聊天室預設自動續接（少爺 2026-10-12）
  maxPerBatch: 3,          // 一批最多接回幾室
  batchGapSec: 90,         // 兩批之間隔幾秒
  bufferSec: 90,           // 重設時間過後再等幾秒才動（避開邊界）
  transientRetrySec: 300,  // 伺服器過載類錯誤幾秒後重試
  weeklyLimitAutoResume: true,  // 週上限重設後同樣自動續接（少爺 2026-10-12）
}

const USAGE_LIMIT_TEXT_RE = /hit your (?:session|weekly|opus|sonnet|[a-z]+) limit/i
const WEEKLY_TEXT_RE = /hit your weekly limit/i
const NOT_USAGE_LIMIT_TEXT_RE = /not your usage limit|temporary capacity issue/i
const SPEND_TEXT_RE = /monthly spend limit|individual spend limit|credit balance is too low/i
const ACCOUNT_TEXT_RE = /account is on hold|organization has been disabled|oauth token revoked|login expired|not logged in|invalid authentication credentials/i

/**
 * 把一次 API 錯誤分類。InInfo 可帶 StopFailure hook 的欄位（error／error_details／last_assistant_message），
 * 或逐字稿那筆合成訊息的欄位（error／apiError／text）。
 * 回 { kind: 'usage_limit'|'account_unavailable'|'transient'|'other', error, apiError, text }
 */
export function classifyApiError(InInfo) {
  const _error = String(InInfo?.error ?? '')
  const _apiError = String(InInfo?.apiError ?? '')
  const _text = [InInfo?.error_details, InInfo?.last_assistant_message, InInfo?.text].filter(Boolean).join(' ')
  const _base = { error: _error || null, apiError: _apiError || null, text: _text }
  if (ACCOUNT_UNAVAILABLE_ERRORS.includes(_error) || SPEND_TEXT_RE.test(_text) || ACCOUNT_TEXT_RE.test(_text)) return { kind: 'account_unavailable', ..._base }
  if (NOT_USAGE_LIMIT_TEXT_RE.test(_text)) return { kind: 'transient', ..._base }
  if (_apiError === 'usage_limit_reached' || USAGE_LIMIT_TEXT_RE.test(_text)) return { kind: 'usage_limit', ..._base }
  if (_error === 'rate_limit') return { kind: 'usage_limit', ..._base }
  if (TRANSIENT_ERRORS.includes(_error)) return { kind: 'transient', ..._base }
  return { kind: 'other', ..._base }
}

/** 週上限（大家共用的額度）：逐字稿的 rateLimitType 為準，否則看訊息文字 */
export function isWeeklyLimit(InRateLimitType, InText) {
  if (InRateLimitType) return /seven_day|weekly/i.test(String(InRateLimitType))
  return WEEKLY_TEXT_RE.test(String(InText ?? ''))
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/**
 * 從錯誤訊息文字解析重設時間（逐字稿沒有 resetsAt 時的後備）。
 * 支援「resets 6pm」「resets 3:45pm」「resets 15:45」「resets Mon 12:00am」「resets in 2h 10m」與 ISO 時間；解析不到回 null。
 * 一律以本機時區計算（訊息括號裡的時區名稱只作提示）。
 */
export function parseResetText(InText, InNow = new Date()) {
  const _text = String(InText ?? '')
  if (!_text) return null
  const _iso = _text.match(/(20\d{2}-\d{2}-\d{2}[T ][0-2]\d:[0-5]\d(?::[0-5]\d)?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/)
  if (_iso) {
    const _d = new Date(_iso[1])
    if (!isNaN(_d) && _d.getTime() > InNow.getTime() - 60000) return _d
  }
  const _dur = _text.match(/(?:resets?|try again)\s+in\s+(?:(\d+)\s*(?:h|hr|hrs|hours?))?\s*(?:(\d+)\s*(?:m|min|mins|minutes?))?/i)
  if (_dur && (_dur[1] || _dur[2])) {
    return new Date(InNow.getTime() + ((Number(_dur[1] ?? 0) * 60) + Number(_dur[2] ?? 0)) * 60000)
  }
  const _clock = _text.match(/resets?\s+(?:at\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (_clock) {
    let _hour = Number(_clock[2])
    const _minute = Number(_clock[3] ?? 0)
    const _ampm = (_clock[4] ?? '').toLowerCase()
    if (_ampm === 'pm' && _hour < 12) _hour += 12
    if (_ampm === 'am' && _hour === 12) _hour = 0
    if (_hour > 23 || _minute > 59) return null
    const _d = new Date(InNow)
    _d.setHours(_hour, _minute, 0, 0)
    if (_clock[1]) {
      const _target = WEEKDAYS.indexOf(_clock[1].toLowerCase())
      let _delta = (_target - _d.getDay() + 7) % 7
      if (_delta === 0 && _d.getTime() <= InNow.getTime() + 60000) _delta = 7
      _d.setDate(_d.getDate() + _delta)
      return _d
    }
    if (_d.getTime() <= InNow.getTime() + 60000) _d.setDate(_d.getDate() + 1)
    return _d
  }
  return null
}

/** 現在是否落在「不自動續接」時段；InStart／InEnd 為 'HH:MM'，可跨午夜；任一未設＝沒有安靜時段 */
export function inQuietHours(InStart, InEnd, InNow = new Date()) {
  const _parse = s => { const m = String(s ?? '').match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : null }
  const _s = _parse(InStart)
  const _e = _parse(InEnd)
  if (_s === null || _e === null || _s === _e) return false
  const _n = InNow.getHours() * 60 + InNow.getMinutes()
  return _s < _e ? (_n >= _s && _n < _e) : (_n >= _s || _n < _e)
}

/** 合併總設定（getTcSetting 讀出的鍵值）與預設值 */
export function resolveAutoResumeSettings(InGet) {
  const _g = (k, d) => { const v = InGet(`usage.autoResume.${k}`); return v === undefined || v === null ? d : v }
  return {
    enabled: _g('enabled', AUTO_RESUME_DEFAULTS.enabled) === true,
    maxPerBatch: Math.max(1, Number(_g('maxPerBatch', AUTO_RESUME_DEFAULTS.maxPerBatch)) || AUTO_RESUME_DEFAULTS.maxPerBatch),
    batchGapSec: Math.max(10, Number(_g('batchGapSec', AUTO_RESUME_DEFAULTS.batchGapSec)) || AUTO_RESUME_DEFAULTS.batchGapSec),
    bufferSec: AUTO_RESUME_DEFAULTS.bufferSec,
    transientRetrySec: AUTO_RESUME_DEFAULTS.transientRetrySec,
    weeklyLimitAutoResume: _g('weeklyLimitAutoResume', AUTO_RESUME_DEFAULTS.weeklyLimitAutoResume) === true,
    quietStart: _g('quietStart', null),
    quietEnd: _g('quietEnd', null),
  }
}

/**
 * 到點後對一筆中斷紀錄該做什麼。InCtx：{ record, now, settings, resumedSelf, deliverable }
 * - resumedSelf：逐字稿在中斷之後已有新的對話（Claude Code 自己接了或少爺手動接了）
 * - deliverable：投得進去（無頭、或分頁開著且能直投／有監看）；分頁開著卻投不進去＝只能通知
 * - switchedAway：這筆是在別的帳號撞上限的，而現在用的帳號沒在冷卻（已自動換過去）⇒ 不必等重設、直接續接
 *   （少爺 2026-10-10 定「換過去先檢查是否在冷卻，無冷卻就直接自動續接」；換帳號總開關本身就是控管用量的開關）
 * 回 'none'|'wait'|'resolved_self'|'notify_off'|'notify_excluded'|'notify_weekly'|'notify_undeliverable'|'hold_quiet'|'resume'
 */
export function decideAction(InCtx) {
  const { record, now, settings, resumedSelf, deliverable, switchedAway } = InCtx
  if (!record || record.status !== 'waiting') return 'none'
  if (record.kind === 'account_unavailable' || record.kind === 'other') return 'none'
  const _due = (record.resetAt ?? 0) + settings.bufferSec * 1000
  if (!switchedAway && now < _due) return 'wait'
  if (resumedSelf) return 'resolved_self'
  if (record.excluded) return 'notify_excluded'
  if (switchedAway && record.kind === 'usage_limit') {
    if (inQuietHours(settings.quietStart, settings.quietEnd, new Date(now))) return 'hold_quiet'
    return deliverable ? 'resume' : 'notify_undeliverable'
  }
  if (!settings.enabled) return 'notify_off'
  if (record.weekly && !settings.weeklyLimitAutoResume) return 'notify_weekly'
  if (inQuietHours(settings.quietStart, settings.quietEnd, new Date(now))) return 'hold_quiet'
  if (!deliverable) return 'notify_undeliverable'
  return 'resume'
}

/**
 * 換帳號續接後很快又撞上限＝換過去的帳號其實也沒額度（或中斷歸屬算錯）：不再當「別的帳號撞的」立刻續接，改等重設。
 * 2026-10-13 19:09～19:22 歸屬算錯，同一室 15 分鐘內被「換帳號續接」多達 7 次、每次十幾秒內又撞上限。
 * 視窗內已有 2 次換帳號續接＝空轉。
 */
export function isAutoSwitchThrashing(InRecord, InNow, InWindowMs = 10 * 60 * 1000) {
  const _recent = (InRecord?.history ?? []).filter(h => h.reason === 'auto_switch' && InNow - (h.at ?? 0) < InWindowMs)
  return _recent.length >= 2
}

/**
 * 外部切換補記後的回溯：切換時間點之後、記在原帳號名下的中斷，其實是新帳號撞的 ⇒ 回傳要改歸新帳號的紀錄
 * （2026-10-13 20:19 事故：外部切換晚了 55 分鐘才補記，期間的上限全算給 sasocaptain、把它標冷卻到 00:20）。
 * InExt：detectExternalSwitch 的結果 { at, from, to }。
 */
export function recordsToReattribute(InRecords, InExt) {
  if (!InExt?.from || !InExt?.to || InExt.from === InExt.to) return []
  return (InRecords ?? []).filter(r => r && r.accountUuid === InExt.from && (r.interruptedAt ?? 0) >= (InExt.at ?? 0))
}

/**
 * 登入失效造成的中斷能不能改回待續接：所有聊天室共用一份登入檔，只要現在的登入屬於一個沒被停用的帳號，
 * 這些聊天室就能再跑（2026-10-12 19:59 換到死登入，15 室被歸「帳號不可用」後永不續接，停了 3.5 小時）。
 * 帳務、停權等其他「帳號不可用」不在此列。回要合併進紀錄的欄位，不能恢復回 null。
 * InActive：目前登入所屬的保管庫帳號（認不出＝null）；InActiveStatus：accountStatus 的結果。
 */
export function recoverAuthFailedRecord(InRecord, InActive, InActiveStatus, InNow) {
  if (!InRecord || InRecord.status !== 'account_unavailable' || InRecord.error !== 'authentication_failed') return null
  if (!InActive || InActive.disabled || InActiveStatus === 'disabled' || InActiveStatus === 'expired') return null
  return {
    status: 'waiting',
    kind: 'usage_limit',
    resetAt: Math.max(InNow, InActive.coolingUntil ?? 0),
    recoveredFrom: 'authentication_failed',
    recoveredAt: InNow,
    notified: null,
  }
}

/** 這一批要續接哪些：最早中斷的先接，最多 InMax 筆 */
export function pickBatch(InRecords, InMax) {
  return [...InRecords].sort((a, b) => (a.interruptedAt ?? 0) - (b.interruptedAt ?? 0)).slice(0, Math.max(0, InMax))
}

/**
 * 續接時送進聊天室的訊息（繁中；提醒先確認現況，避免照舊計畫重做別室已推進的事）。
 * InHeadless＝分頁沒開、走無頭續接：明講不要掛 Monitor——無頭進程掛了監看就不會結束，
 * 每次監看到期又多跑一輪（2026-10-10 實測：7 室各自陷入「到期→重掛」循環、持續花用量、擋住 TC 重啟）。
 */
export function resumePrompt(InRecord, InNow = new Date(), InHeadless = false, InSwitchedTo = null) {
  const _at = new Date(InRecord.resetAt ?? InNow).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
  const _early = !InSwitchedTo && (InRecord.resetAt ?? 0) > new Date(InNow).getTime()
  const _why = InSwitchedTo ? `原帳號撞上用量上限，已自動換到另一個帳號（${InSwitchedTo}）`
    : _early ? `已提前續接（原本要等到 ${_at} 重設；目前登入的帳號可用）` : `帳號用量已於 ${_at} 重設`
  const _base = `（TC 自動續接）${_why}。請先確認目前狀態（跨聊天室的進度、編譯與資產佔用是否已變動），再從剛才中斷的地方接續；若工作已完成或不需要再做，回一行說明即可。`
  return InHeadless
    ? `${_base}這是無頭續接（沒有開著的分頁）：不要掛 Monitor 或任何常駐監看，做完這一輪就結束；之後的留言與喚醒由 TC 負責。`
    : _base
}
