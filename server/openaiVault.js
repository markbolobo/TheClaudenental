// OpenAI（Codex）帳號保管庫的純判斷（少爺 2026-10-25：「TC是工具既是介面，而AI只是驅動的燃料，替換不會影響我的工作流」）
// 一個 OpenAI 帳號＝一個 CODEX_HOME 資料夾（auth.json＋config.toml）；跑 codex 時指定 CODEX_HOME 就是用那個帳號。
// 匯入目前登入＝直接登記 ~/.codex（不複製）：同一份更新權杖存兩份，任一邊輪替後另一份就作廢。
// 權杖絕不經 API 或介面送出，這裡只解出帳號辨識資料。機檢 openaiVault.check.mjs。

/** 解 JWT 的內容段（不驗簽，只拿辨識資料） */
function decodeJwtPayload(InJwt) {
  const _part = String(InJwt ?? '').split('.')[1]
  if (!_part) return null
  try { return JSON.parse(Buffer.from(_part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')) } catch { return null }
}

/** 從 auth.json 取帳號辨識資料：ChatGPT 登入看 id_token、API 金鑰登入只標示金鑰模式 */
export function parseCodexAuth(InAuth) {
  if (!InAuth) return null
  const _tokens = InAuth.tokens ?? null
  if (_tokens?.refresh_token) {
    const _claims = decodeJwtPayload(_tokens.id_token) ?? {}
    const _auth = _claims['https://api.openai.com/auth'] ?? {}
    const _accountId = _tokens.account_id ?? _auth.chatgpt_account_id ?? null
    if (!_accountId) return null
    return {
      accountId: _accountId,
      email: _claims.email ?? null,
      plan: _auth.chatgpt_plan_type ?? null,
      subscriptionUntil: _auth.chatgpt_subscription_active_until ?? null,
      mode: 'chatgpt',
    }
  }
  if (InAuth.OPENAI_API_KEY) return { accountId: `apikey-${String(InAuth.OPENAI_API_KEY).slice(-6)}`, email: null, plan: 'api', subscriptionUntil: null, mode: 'apikey' }
  return null
}

/**
 * 帳號狀態：只看停用。id_token 的訂閱到期日是登入當下的快照、續約後不更新（10-25 實測：顯示已過期但 codex 照常可用），不能拿來判斷
 * InNow 保留給之後的冷卻判斷
 */
export function openaiAccountStatus(InAccount, InNow) {
  return InAccount.disabled ? 'disabled' : 'available'
}

/** 送給前端的帳號資料（不含資料夾以外的任何登入內容） */
export function openaiAccountPublicView(InAccount, InNow, InActiveId) {
  return {
    provider: 'openai',
    accountId: InAccount.accountId,
    email: InAccount.email,
    plan: InAccount.plan,
    mode: InAccount.mode,
    shared: !!InAccount.shared,
    source: InAccount.source,
    addedAt: InAccount.addedAt,
    lastUsedAt: InAccount.lastUsedAt ?? null,
    disabled: !!InAccount.disabled,
    status: openaiAccountStatus(InAccount, InNow),
    active: InAccount.accountId === InActiveId,
  }
}

/** 外包要用哪個帳號：指定的優先；否則使用中的；使用中的不可用就挑第一個可用的 */
export function pickOpenaiAccount(InAccounts, InActiveId, InWantedId, InNow) {
  const _usable = a => a && openaiAccountStatus(a, InNow) === 'available'
  if (InWantedId) return InAccounts.find(a => a.accountId === InWantedId && _usable(a)) ?? null
  const _active = InAccounts.find(a => a.accountId === InActiveId)
  if (_usable(_active)) return _active
  return InAccounts.find(_usable) ?? null
}

/** `codex login` 輸出裡的登入網址 */
export function parseCodexLoginUrl(InOutput) {
  const _m = String(InOutput ?? '').match(/https:\/\/auth\.openai\.com\/\S+/)
  return _m ? _m[0].replace(/[)\].,'"]+$/, '') : null
}

/** 外包執行的 codex 參數：預設唯讀沙箱、不存會話、最後一則回覆寫到指定檔 */
export function buildOutsourceArgs(InReq) {
  const _args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', InReq.sandbox === 'workspace-write' ? 'workspace-write' : 'read-only']
  if (InReq.cwd) _args.push('-C', InReq.cwd)
  if (InReq.model) _args.push('-m', InReq.model)
  if (InReq.effort) _args.push('-c', `model_reasoning_effort="${InReq.effort}"`)
  if (InReq.outputFile) _args.push('-o', InReq.outputFile)
  _args.push('-')
  return _args
}
