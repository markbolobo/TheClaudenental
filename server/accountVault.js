// 用量上限自動換帳號：純判斷（帳號狀態、換到哪個、登入檔怎麼合併、對外可見欄位）。
//
// 少爺 2026-10-10「我已經需要可以自動換帳號的部分了，聊天室依舊使用同個，只是切換帳號（就像我手動在 VS Code 觸發 Switch Account 的步驟）」
// 少爺 2026-10-10 定：換回＝不主動換回，等聊天室被中斷時才檢查另一個帳號是否在冷卻；換過去先檢查是否在冷卻，沒冷卻就直接自動續接；
//                    帳號由 TC 面板「加入帳號」登入；會籍停止（帳務、停權、登入失效）的帳號永不切過去。
// 做法：所有聊天室共用 ~/.claude/.credentials.json；換掉這份檔＝全部聊天室同時換帳號，執行中的分頁不必重開
//      （2026-10-10 16:00 少爺手動切換後，從前一天就開著的進程直接用新帳號回覆，總控實證）。
// 本模組只放純判斷；保管庫讀寫、切換、登入子進程在 index.js，機檢在 accountVault.check.mjs。

/** 自動換帳號的預設值（總設定未設時） */
export const AUTO_SWITCH_DEFAULTS = {
  enabled: false,            // 預設關：開了才會自動換帳號＋換後續接
  switchCooldownSec: 120,    // 兩次自動切換至少隔多久（多室同時撞上限會連發好幾筆中斷）
  verifyAfterSec: 20,        // 切換後多久檢查登入檔沒被舊帳號寫回
  revertWindowSec: 600,      // 切過去之後這段時間內撞到「帳號不可用」＝這個帳號的登入不能用
}

/** 能自動切過去的訂閱類型 */
export const USABLE_SUBSCRIPTIONS = ['pro', 'max', 'team', 'enterprise']

/** 合併總設定與預設值 */
export function resolveAutoSwitchSettings(InGet) {
  const _v = InGet('usage.autoSwitch.enabled')
  return { ...AUTO_SWITCH_DEFAULTS, enabled: _v === true }
}

/**
 * 帳號此刻的狀態。InAccount：保管庫的帳號紀錄（不含權杖）。
 * 回 'disabled'（手動或自動停用）|'expired'（登入期限已過，要重新加入）|'unusable'（訂閱類型不能用）|'cooling'（冷卻中）|'available'
 */
export function accountStatus(InAccount, InNow) {
  if (!InAccount) return 'disabled'
  if (InAccount.disabled) return 'disabled'
  if (InAccount.refreshTokenExpiresAt && InAccount.refreshTokenExpiresAt <= InNow) return 'expired'
  if (InAccount.subscriptionType && !USABLE_SUBSCRIPTIONS.includes(String(InAccount.subscriptionType).toLowerCase())) return 'unusable'
  if ((InAccount.coolingUntil ?? 0) > InNow) return 'cooling'
  return 'available'
}

/** 換到哪個帳號：除了目前這個以外、狀態可用的帳號；多個時挑最久沒用的（輪流用） */
export function pickSwitchTarget(InAccounts, InActiveUuid, InNow) {
  const _cands = (InAccounts ?? []).filter(a => a.accountUuid !== InActiveUuid && accountStatus(a, InNow) === 'available')
  if (!_cands.length) return null
  return [..._cands].sort((a, b) => (a.lastActiveAt ?? 0) - (b.lastActiveAt ?? 0))[0]
}

/**
 * 這一輪要不要自動換帳號。InCtx：{ accounts, activeUuid, now, settings, lastSwitchAt }
 * 只有「目前帳號在冷卻」才換（少爺定：不主動換回）；換不了（沒有可用帳號）就照第一階段等重設。
 * 回 { action: 'none'|'switch', target?, reason }
 */
export function decideSwitch(InCtx) {
  const { accounts, activeUuid, now, settings, lastSwitchAt } = InCtx
  if (!settings?.enabled) return { action: 'none', reason: 'off' }
  const _active = (accounts ?? []).find(a => a.accountUuid === activeUuid)
  if (!_active) return { action: 'none', reason: 'active_unknown' }
  const _st = accountStatus(_active, now)
  if (_st === 'available') return { action: 'none', reason: 'active_ok' }
  if (now - (lastSwitchAt ?? 0) < settings.switchCooldownSec * 1000) return { action: 'none', reason: 'cooldown' }
  const _target = pickSwitchTarget(accounts, activeUuid, now)
  if (!_target) return { action: 'none', reason: 'no_target' }
  return { action: 'switch', target: _target, reason: `active_${_st}` }
}

/**
 * 寫回 ~/.claude/.credentials.json 的內容：保留目前檔案的其他欄位（例如 mcpOAuth＝各 MCP 伺服器的登入），
 * 只換訂閱登入（claudeAiOauth）與它所屬的組織。
 */
export function mergeCredentials(InCurrentFile, InTargetCredentials) {
  return {
    ...(InCurrentFile ?? {}),
    claudeAiOauth: InTargetCredentials.claudeAiOauth,
    organizationUuid: InTargetCredentials.organizationUuid,
  }
}

/**
 * 登入檔屬於哪個帳號：以組織 id 比對保管庫（每個個人訂閱各有自己的組織）。
 * Claude Code 自己登入時寫的登入檔沒有頂層組織 id（2026-10-13 實查），這時改用 ~/.claude.json 的 oauthAccount（同一次登入一起寫）。
 */
export function matchAccountByCredentials(InAccounts, InCredentialsFile, InOauthAccount = null) {
  const _org = liveOrganizationUuid(InCredentialsFile, InOauthAccount)
  if (!_org) return null
  return (InAccounts ?? []).find(a => a.organizationUuid === _org) ?? null
}

/** 共用登入檔所屬組織：登入檔頂層有就用它；沒有、但有訂閱登入時才退回 ~/.claude.json 的 oauthAccount；都沒有回 null */
export function liveOrganizationUuid(InCredentialsFile, InOauthAccount = null) {
  if (InCredentialsFile?.organizationUuid) return InCredentialsFile.organizationUuid
  if (!InCredentialsFile?.claudeAiOauth) return null
  return InOauthAccount?.organizationUuid ?? null
}

/**
 * 換帳號後驗證失敗要不要換回：切過去 InWindowSec 秒內，新帳號撞上「登入失效」＝保管的登入不能用，
 * 立刻換回原帳號（原帳號在冷卻也換：冷卻會等重設後自動續接，死登入則所有聊天室永遠卡住）。
 * InCtx：{ switches, failedUuid, now, windowSec, accounts }；回 { action: 'none'|'revert', to?, reason }
 */
export function decideRevert(InCtx) {
  const { switches, failedUuid, now, windowSec, accounts } = InCtx
  const _last = (switches ?? []).at(-1)
  if (!_last || _last.to !== failedUuid) return { action: 'none', reason: 'not_last_switch' }
  if (_last.reason === 'revert') return { action: 'none', reason: 'already_reverted' }
  if (_last.reason === 'external') return { action: 'none', reason: 'external_login' }
  if (now - (_last.at ?? 0) > windowSec * 1000) return { action: 'none', reason: 'outside_window' }
  const _prev = (accounts ?? []).find(a => a.accountUuid === _last.from)
  if (!_prev) return { action: 'none', reason: 'no_previous' }
  if (_prev.disabled) return { action: 'none', reason: 'previous_disabled' }
  return { action: 'revert', to: _prev.accountUuid, reason: 'auth_failed_after_switch' }
}

/**
 * 共用登入檔在 TC 之外換了帳號（VS Code 登入、執行中的 Claude 更新權杖時寫回別的帳號）：
 * 切換紀錄最後一筆的目標跟登入檔實際的帳號不同 ⇒ 回一筆要補進切換紀錄的外部切換，否則回 null。
 * 中斷歸屬照切換紀錄回推，漏記這種切換就會把上限算到錯的帳號（2026-10-13 19:08 事故）。
 * TC 自己剛換完的寬限期內不判（被舊進程寫回由切換後驗證負責重寫，免得記成兩筆來回）。
 * InCtx：{ switches, liveUuid（登入檔所屬帳號，認不出＝null）, at（登入檔修改時間）, now, graceMs }
 */
export function detectExternalSwitch(InCtx) {
  const { switches, liveUuid, at, now, graceMs } = InCtx
  if (!liveUuid) return null
  const _last = (switches ?? []).at(-1)
  if (_last && _last.to === liveUuid) return null
  if (_last && (at ?? 0) < (_last.at ?? 0)) return null
  if (_last && _last.reason !== 'external' && (now ?? 0) - (_last.at ?? 0) < (graceMs ?? 0)) return null
  return { at, from: _last?.to ?? null, to: liveUuid, reason: 'external' }
}

/** 帳號冷卻調高紀錄最多留幾筆（外部切換回溯用） */
export const COOLING_LOG_MAX = 20

/**
 * 中斷把帳號的冷卻調高：回傳要寫回帳號的欄位，沒有調高＝null。
 * 每次調高記一筆 { at：造成調高的中斷時間, prev／prevWeekly：調高前的冷卻, to：調高後 }，外部切換回溯時據此倒回。
 */
export function raiseCooling(InAccount, InResetAt, InAt, InWeekly) {
  if (!InAccount || !InResetAt || (InAccount.coolingUntil ?? 0) >= InResetAt) return null
  const _entry = { at: InAt ?? null, prev: InAccount.coolingUntil ?? null, prevWeekly: !!InAccount.coolingWeekly, to: InResetAt }
  return { coolingUntil: InResetAt, coolingWeekly: !!InWeekly, coolingLog: [...(InAccount.coolingLog ?? []), _entry].slice(-COOLING_LOG_MAX) }
}

/**
 * 外部切換回溯：切換時間點之後由中斷造成的冷卻調高，都是把別的帳號的上限算到這個帳號頭上 ⇒ 倒回最早那筆調高之前的值。
 * 冷卻在那之後被手動清除或改過＝尊重現值、只清掉紀錄；沒有可倒回的紀錄（含沒有紀錄的舊資料）＝null、不動冷卻。
 * 回傳要寫回帳號的欄位。
 */
export function rollbackCoolingSince(InAccount, InSince) {
  const _log = InAccount?.coolingLog ?? []
  const _idx = _log.findIndex(e => (e.at ?? 0) >= (InSince ?? 0))
  if (_idx < 0) return null
  const _kept = _log.slice(0, _idx)
  if ((InAccount.coolingUntil ?? null) !== (_log.at(-1).to ?? null)) return { coolingLog: _kept }
  return { coolingUntil: _log[_idx].prev ?? null, coolingWeekly: !!_log[_idx].prevWeekly, coolingLog: _kept }
}

/** 從登入檔與 ~/.claude.json 的 oauthAccount 做出保管庫帳號紀錄（不含權杖） */
export function accountRecordFrom(InCredentialsFile, InOauthAccount, InNow) {
  const _o = InCredentialsFile?.claudeAiOauth ?? {}
  return {
    accountUuid: InOauthAccount?.accountUuid ?? null,
    organizationUuid: InCredentialsFile?.organizationUuid ?? InOauthAccount?.organizationUuid ?? null,
    email: InOauthAccount?.emailAddress ?? null,
    displayName: InOauthAccount?.displayName ?? null,
    organizationName: InOauthAccount?.organizationName ?? null,
    subscriptionType: _o.subscriptionType ?? null,
    rateLimitTier: _o.rateLimitTier ?? null,
    refreshTokenExpiresAt: _o.refreshTokenExpiresAt ?? null,
    addedAt: InNow,
  }
}

/** 給介面看的帳號資料：絕不含權杖 */
export function accountPublicView(InAccount, InNow, InActiveUuid) {
  const { accountUuid, email, displayName, organizationName, subscriptionType, rateLimitTier, refreshTokenExpiresAt,
    coolingUntil, coolingWeekly, disabled, disabledReason, disabledAt, lastActiveAt, addedAt } = InAccount
  return {
    accountUuid, email, displayName, organizationName, subscriptionType, rateLimitTier, refreshTokenExpiresAt,
    coolingUntil: coolingUntil ?? null, coolingWeekly: !!coolingWeekly, disabled: !!disabled, disabledReason: disabledReason ?? null,
    disabledAt: disabledAt ?? null, lastActiveAt: lastActiveAt ?? null, addedAt: addedAt ?? null,
    active: accountUuid === InActiveUuid,
    status: accountStatus(InAccount, InNow),
  }
}

/** 從 `claude auth login` 的輸出找登入網址 */
export function parseLoginUrl(InOutput) {
  const _m = String(InOutput ?? '').match(/https:\/\/\S+oauth\/authorize\S*/)
  return _m ? _m[0] : null
}
