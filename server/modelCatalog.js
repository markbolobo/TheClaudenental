// 模型目錄（少爺 2026-08-15 立「其他都要與時俱進」＋「要能自動更新這個功能」）
//
// 過去 model 清單與定價硬編在三處（server PRICING / client MODEL_PRICING / client MODEL_OPTIONS），
// 每次 Anthropic 出新模型就要手改三份、漏一份就靜默用錯價。本模組收斂成單一 SSOT：
//
//   內建表（BUILTIN，有日期戳記）  ∪  從已安裝 claude.exe 掃出的 alias  ∪  磁碟上的手動覆寫
//
// 「自動更新」的來源＝**少爺自己會升級的 Claude Code 二進位**：新模型上線、Claude Code 跟上版本後，
// 下次 refresh 就掃得到新 alias，自動進下拉選單並沿用同 tier 現價（標 pricingEstimated 提醒校正）。
// 沒有 ANTHROPIC_API_KEY 可打 /v1/models，這是本機唯一可靠且會自己前進的來源。

import fs from 'fs'
import os from 'os'
import path from 'path'

export const CATALOG_FILE = path.join(os.homedir(), '.claude', 'tc_model_catalog.json')

// 內建基準表。價格單位＝USD / 1M tokens。
// 來源：claude-api skill §Current Models（快取日 2026-06-24）＋ shared/prompt-caching.md §Economics
// 的官方倍率（cache read ≈ 0.1×input、cache write ＝ 1.25×input for 5m TTL）推得 cacheRead/cacheWrite。
// ⚠️ 改價只改這裡或改 CATALOG_FILE 的 overrides，不要再回頭改 client/server 的散落副本。
const PRICED_AT = '2026-06-24'

const BUILTIN = [
  // ── 現役（進下拉選單）────────────────────────────────────────────────────
  { id: 'claude-fable-5',   label: 'Fable 5',   tier: 'fable',  contextTokens: 1_000_000, input: 10, output: 50, current: true },
  { id: 'claude-opus-5',    label: 'Opus 5',    tier: 'opus',   contextTokens: 1_000_000, input: 5,  output: 25, current: true },
  { id: 'claude-opus-4-8',  label: 'Opus 4.8',  tier: 'opus',   contextTokens: 1_000_000, input: 5,  output: 25, current: true },
  // Sonnet 5 導入價 $2/$10 至 2026-08-31，之後回 $3/$15 —— 到期自動切回，不必有人記得改
  { id: 'claude-sonnet-5',  label: 'Sonnet 5',  tier: 'sonnet', contextTokens: 1_000_000, input: 3,  output: 15,
    introInput: 2, introOutput: 10, introUntil: '2026-08-31', current: true },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', tier: 'haiku',  contextTokens: 200_000,   input: 1,  output: 5,  current: true },

  // ── 舊世代但官方仍 Active（少爺 2026-08-15 要能挑）：進下拉的「舊世代」段，標《舊》────
  // 依據：claude-api skill models.md「Legacy Models (still active)」＋ 本機 claude.exe alias 表都有
  { id: 'claude-opus-4-7',   label: 'Opus 4.7',   tier: 'opus',   contextTokens: 1_000_000, input: 5,  output: 25, current: false, selectable: true },
  { id: 'claude-opus-4-6',   label: 'Opus 4.6',   tier: 'opus',   contextTokens: 1_000_000, input: 5,  output: 25, current: false, selectable: true },
  { id: 'claude-opus-4-5',   label: 'Opus 4.5',   tier: 'opus',   contextTokens: 200_000,   input: 5,  output: 25, current: false, selectable: true, priceInferred: true },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', tier: 'sonnet', contextTokens: 1_000_000, input: 3,  output: 15, current: false, selectable: true },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', tier: 'sonnet', contextTokens: 1_000_000, input: 3,  output: 15, current: false, selectable: true, priceInferred: true },

  // ── 只留價、不進下拉（已過官方退役日或限定發放；歷史 transcript 的成本回算仍會查到）──
  { id: 'claude-mythos-5',   label: 'Mythos 5',   tier: 'mythos', contextTokens: 1_000_000, input: 10, output: 50, current: false, note: 'Project Glasswing 限定' },
  { id: 'claude-opus-4-1',   label: 'Opus 4.1',   tier: 'opus',   contextTokens: 200_000,   input: 15, output: 75, current: false, priceInferred: true, note: '官方退役日 2026-08-05 已過' },
  { id: 'claude-opus-4-0',   label: 'Opus 4',     tier: 'opus',   contextTokens: 200_000,   input: 15, output: 75, current: false, priceInferred: true, note: '官方退役日 2026-06-15 已過' },
  { id: 'claude-sonnet-4-0', label: 'Sonnet 4',   tier: 'sonnet', contextTokens: 200_000,   input: 3,  output: 15, current: false, priceInferred: true, note: '官方退役日 2026-06-15 已過' },
]

// 官方快取倍率（shared/prompt-caching.md §Economics）——只存 input/output，其餘推導，避免四個數字各自腐爛
// ⭐ CACHE_WRITE 用 2×（1 小時 TTL）而非 1.25×（5 分鐘 TTL）：Claude Code 實際跑的是 1h TTL。
// 實證（少爺 2026-08-15，claude --model claude-opus-4-5 單次探測）：
//   in=10 out=34 cacheRead=25316 cacheWrite=9137，CLI 回報 total_cost_usd=0.104928
//   10*5 + 34*25 + 25316*0.5 + 9137*10 = 104928 → $0.104928 完全吻合（用 6.25 則只算出 $0.0707）
// 也就是說先前所有花費演出都把 cache write 少算 37.5%。
const CACHE_READ_MULT  = 0.1
const CACHE_WRITE_MULT = 2

/** 補齊一筆 entry 的衍生欄位（快取價、導入價到期切換）。輸入不變動，回傳新物件。 */
function hydrate(InEntry, InNow) {
  const _e = { ...InEntry }
  const _introLive = _e.introUntil && _e.introInput != null && InNow <= Date.parse(`${_e.introUntil}T23:59:59Z`)
  const _input  = _introLive ? _e.introInput  : _e.input
  const _output = _introLive ? (_e.introOutput ?? _e.output) : _e.output
  return {
    ..._e,
    introActive: !!_introLive,
    pricing: {
      input:      _input,
      output:     _output,
      cacheRead:  _e.cacheRead  ?? +(_input * CACHE_READ_MULT).toFixed(4),
      cacheWrite: _e.cacheWrite ?? +(_input * CACHE_WRITE_MULT).toFixed(4),
    },
  }
}

/** `claude-haiku-4-5` → `Haiku 4.5`；`claude-opus-5` → `Opus 5`。新模型自動有個像樣的名字。 */
function labelFromId(InId) {
  const _m = /^claude-([a-z]+)-([\d-]+)$/.exec(InId)
  if (!_m) return InId
  const _family = _m[1][0].toUpperCase() + _m[1].slice(1)
  return `${_family} ${_m[2].split('-').join('.')}`
}

// ─── 掃描已安裝的 claude 二進位 ───────────────────────────────────────────────

// 只收「家族-版號」形態的 alias；`(?![-0-9a-z])` 把帶日期/`-fast`/`-v1` 的變體與截斷前綴擋掉
const ALIAS_RE = /claude-(?:opus|sonnet|haiku|fable|mythos)-\d+(?:-\d+)?(?![-0-9a-z])/g

/**
 * 從 claude 執行檔掃出它認得的模型 alias。
 * 掃不到（找不到檔／非本機二進位／讀取失敗）一律回空陣列，呼叫端退回內建表，不讓 refresh 失敗連累開機。
 */
export function discoverAliases(InClaudeExe) {
  let _fd = null
  try {
    if (!InClaudeExe || !fs.existsSync(InClaudeExe)) return []
    const _stat = fs.statSync(InClaudeExe)
    if (!_stat.isFile() || _stat.size > 1_500_000_000) return []

    // 分塊掃描（binary 有 300MB+，整檔讀進來再轉字串會瞬間吃掉 600MB＋）。
    // 相鄰塊重疊 OVERLAP bytes，避免 alias 剛好被切在塊邊界而漏掉。
    const CHUNK = 8 * 1024 * 1024
    const OVERLAP = 64
    const _hits = new Set()
    const _buf = Buffer.allocUnsafe(CHUNK)
    _fd = fs.openSync(InClaudeExe, 'r')
    let _pos = 0
    while (_pos < _stat.size) {
      const _read = fs.readSync(_fd, _buf, 0, CHUNK, _pos)
      if (_read <= 0) break
      for (const _m of _buf.toString('latin1', 0, _read).matchAll(ALIAS_RE)) _hits.add(_m[0])
      if (_read < CHUNK) break
      _pos += _read - OVERLAP
    }

    // 帶日期快照（`claude-opus-4-20250514`）不是給人選的 alias，丟掉
    for (const _id of [..._hits]) if (/-\d{8}$/.test(_id)) _hits.delete(_id)
    // `claude-opus-4` 這種只有大版號的，多半是 `claude-opus-4-8` 被字串切半的殘影：
    // 有同家族同大版號的細版號存在就判定為殘影。單段版號真的獨立存在（Opus 5 / Fable 5）則保留。
    for (const _id of [..._hits]) {
      const _m = /^(claude-[a-z]+)-(\d+)$/.exec(_id)
      if (_m && [..._hits].some(o => o.startsWith(`${_m[1]}-${_m[2]}-`))) _hits.delete(_id)
    }
    return [..._hits].sort()
  } catch { return [] }
  finally { if (_fd !== null) { try { fs.closeSync(_fd) } catch {} } }
}

// ─── 目錄組裝與持久化 ─────────────────────────────────────────────────────────

function readOverrides() {
  try {
    const _d = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'))
    return _d && typeof _d === 'object' ? (_d.overrides ?? {}) : {}
  } catch { return {} }
}

let catalogCache = null

/**
 * 重建目錄：內建表 ∪ 掃描發現 ∪ 手動覆寫。
 * 掃到但沒價的新模型 → 沿用同 tier 現役價並標 pricingEstimated，讓成本演出不會 NaN，
 * 同時把「這筆價是猜的」誠實掛在資料上（client 顯示提醒、少爺再校正 overrides）。
 */
export function buildCatalog(InClaudeExe, InNow = Date.now()) {
  const _overrides = readOverrides()
  const _discovered = discoverAliases(InClaudeExe)
  const _byId = new Map()

  for (const _b of BUILTIN) _byId.set(_b.id, { ..._b, source: 'builtin', pricedAt: PRICED_AT })

  // 掃到但內建表沒有 ＝ 新模型（或 Claude Code 帶進來的舊 alias）
  const _added = []
  for (const _id of _discovered) {
    if (_byId.has(_id)) continue
    const _tier = /^claude-([a-z]+)-/.exec(_id)?.[1] ?? 'sonnet'
    const _peer = BUILTIN.find(b => b.tier === _tier && b.current) ?? BUILTIN.find(b => b.id === 'claude-sonnet-5')
    _byId.set(_id, {
      id: _id, label: labelFromId(_id), tier: _tier,
      contextTokens: _peer.contextTokens, input: _peer.input, output: _peer.output,
      current: true, source: 'discovered', pricingEstimated: true, estimatedFrom: _peer.id,
    })
    _added.push(_id)
  }

  for (const [_id, _ov] of Object.entries(_overrides)) {
    _byId.set(_id, { ...(_byId.get(_id) ?? { id: _id, label: labelFromId(_id), tier: 'sonnet', current: true }), ..._ov, source: 'override', pricingEstimated: false })
  }

  const _models = [..._byId.values()].map(e => hydrate(e, InNow))
  // 現役排前面，同組內 tier 由貴到便宜，讓下拉選單順序穩定
  const _tierRank = { fable: 0, mythos: 1, opus: 2, sonnet: 3, haiku: 4 }
  _models.sort((a, b) =>
    (a.current === b.current ? 0 : a.current ? -1 : 1)
    || (_tierRank[a.tier] ?? 9) - (_tierRank[b.tier] ?? 9)
    || b.id.localeCompare(a.id))

  catalogCache = {
    models: _models,
    refreshedAt: InNow,
    pricedAt: PRICED_AT,
    discoveredCount: _discovered.length,
    newlyDiscovered: _added,
    estimated: _models.filter(m => m.pricingEstimated).map(m => m.id),
    source: _discovered.length ? 'claude-binary+builtin' : 'builtin-only',
  }
  try {
    fs.mkdirSync(path.dirname(CATALOG_FILE), { recursive: true })
    fs.writeFileSync(CATALOG_FILE, JSON.stringify({ ...catalogCache, overrides: _overrides }, null, 2), 'utf8')
  } catch {}
  return catalogCache
}

/** 取目前目錄；還沒建過就先建一次。 */
export function getCatalog(InClaudeExe) {
  return catalogCache ?? buildCatalog(InClaudeExe)
}

/** 依 model id 取價（含未知 model 的 tier 猜測退路），成本回算的單一入口。 */
export function priceFor(InModelId, InClaudeExe) {
  const _cat = getCatalog(InClaudeExe)
  const _hit = _cat.models.find(m => m.id === InModelId)
  if (_hit) return _hit.pricing
  const _tier = /^claude-([a-z]+)-/.exec(InModelId ?? '')?.[1]
  const _peer = _cat.models.find(m => m.tier === _tier && m.current)
    ?? _cat.models.find(m => m.id === 'claude-sonnet-5')
    ?? _cat.models[0]
  return _peer.pricing
}
