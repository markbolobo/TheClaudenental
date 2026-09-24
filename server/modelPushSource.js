// 官方推播來源：`~/.claude.json`（少爺 2026-09-24「為什麼我沒看到 Opus 5.5」）
//
// 前兩個來源都有「要等 Claude Code 升版」的延遲：
//   · 二進位掃描  → 新模型的 alias 要等新版 claude.exe 才會出現
//   · claude-api skill → 官方模型表隨 Claude Code 版本一起帶
// 這一個沒有：Anthropic 伺服器直接把模型選單與公告推到客戶端設定檔，舊版 Claude Code 照樣收得到。
// Opus 5.5 就是這樣——2026-09-24 已發布，但本機 Claude Code 太舊用不了，
// 官方自己的選單把它標成 `Opus 5.5 (disabled) / Update to 2.1.280+ to use Opus 5.5`。
//
// 兩個管道：
//   additionalModelOptionsCache                            模型選單的附加選項（含停用與原因）
//   cachedGrowthBookFeatures.tengu_startup_announcements   新模型公告（`Introducing <模型>`）
//
// 讀不到或格式不合一律回空結構，呼叫端照常運作——這是加值資訊，不是必要條件。

import fs from 'fs'
import os from 'os'
import path from 'path'

export const CLIENT_CONFIG_FILE = path.join(os.homedir(), '.claude.json')

/** `...anthropic.claude-code-2.1.278-win32-x64...` → `2.1.278`。認不得回 null。 */
export function claudeVersionFromPath(InPath) {
  const _m = /claude-code-(\d+(?:\.\d+)*)/.exec(String(InPath ?? ''))
  return _m ? _m[1] : null
}

/** 版本字串比大小：`2.1.278` < `2.1.280`。任一邊認不得回 null（＝無法比較）。 */
export function compareClaudeVersion(InA, InB) {
  if (!InA || !InB) return null
  const _a = String(InA).split('.').map(Number)
  const _b = String(InB).split('.').map(Number)
  for (let _i = 0; _i < Math.max(_a.length, _b.length); _i++) {
    const _d = (_a[_i] ?? 0) - (_b[_i] ?? 0)
    if (_d !== 0) return _d
  }
  return 0
}

/** `Fable 5.1 · Most capable for...` → `Fable 5.1`；取不出像樣的名字就回退到原本的 label。 */
function labelFromOption(InOption) {
  const _head = String(InOption.description ?? '').split(/[·•]/)[0].trim()
  const _base = /^[A-Z][\w.]*(\s+[\d.]+)?$/.test(_head) ? _head : String(InOption.label ?? '').trim()
  return _base.replace(/\s*\(disabled\)\s*$/i, '').trim()
}

/**
 * 讀官方推給客戶端的模型資訊。
 * 回 `{ models, blocked, announcements, readAt }`：
 *   models        `value` 是真的 model id（可能帶 `[1m]` 這種脈絡變體）→ 可以真的拿去跑
 *   blocked       `value` 不是 model id（例：`cc-update-required-1`）→ 官方有、本機用不了，附原因
 *   announcements 新模型公告，供比對「官方公告了但三個來源都還沒有」的模型
 */
export function loadPushedModels(InFile = CLIENT_CONFIG_FILE) {
  const _empty = { models: [], blocked: [], announcements: [], readAt: null }
  let _cfg = null
  try { _cfg = JSON.parse(fs.readFileSync(InFile, 'utf8')) } catch { return _empty }
  if (!_cfg || typeof _cfg !== 'object') return _empty

  const _models = []
  const _blocked = []
  for (const _o of Array.isArray(_cfg.additionalModelOptionsCache) ? _cfg.additionalModelOptionsCache : []) {
    if (!_o || typeof _o !== 'object') continue
    const _value = String(_o.value ?? '')
    const _label = labelFromOption(_o)
    if (_value.startsWith('claude-')) {
      _models.push({ id: _value, label: _label, description: String(_o.description ?? ''), disabled: !!_o.disabled })
      continue
    }
    // 不是 model id ＝ 官方拿這格在講「有這個模型，但你現在選不了」
    const _req = /(?:update to|需要)\s*v?(\d+(?:\.\d+)+)\+?/i.exec(String(_o.description ?? ''))
    _blocked.push({
      key: _value || _label,
      label: _label,
      reason: String(_o.description ?? '').trim(),
      requiresVersion: _req ? _req[1] : null,
    })
  }

  const _announcements = []
  const _raw = _cfg.cachedGrowthBookFeatures?.tengu_startup_announcements
  for (const _a of Array.isArray(_raw) ? _raw : []) {
    if (!_a || typeof _a !== 'object') continue
    const _title = String(_a.title ?? '')
    const _m = /introducing\s+(.+)$/i.exec(_title)
    _announcements.push({
      id: String(_a.id ?? ''),
      title: _title,
      text: String(_a.text ?? ''),
      modelLabel: _m ? _m[1].trim() : null,
    })
  }

  let _readAt = null
  try { _readAt = fs.statSync(InFile).mtimeMs } catch {}
  return { models: _models, blocked: _blocked, announcements: _announcements, readAt: _readAt }
}

/** 推播檔的指紋（只 stat）：伺服器推新模型下來時檔案會變，用來觸發重建。 */
export function pushFingerprint(InFile = CLIENT_CONFIG_FILE) {
  try {
    const _s = fs.statSync(InFile)
    return `${_s.size}|${_s.mtimeMs}`
  } catch { return 'none' }
}
