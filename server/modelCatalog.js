// 模型目錄（少爺 2026-08-15 立「其他都要與時俱進」＋「要能自動更新這個功能」）
//
// 過去 model 清單與定價硬編在三處（server PRICING / client MODEL_PRICING / client MODEL_OPTIONS），
// 每次 Anthropic 出新模型就要手改三份、漏一份就靜默用錯價。本模組收斂成單一 SSOT：
//
//   內建基準表（BUILTIN，有日期戳記）
//   ∪ **官方模型表**（Claude Code 內建 claude-api skill 的狀態表與價；見 modelSkillSource.js）
//   ∪ **官方推播**（`~/.claude.json` 的模型選單與公告；見 modelPushSource.js）
//   ∪ 從已安裝 claude.exe 掃出的 alias
//   ∪ 磁碟上的手動覆寫
//
// 「自動更新」分兩段，前段不必等升版、後段補齊細節：
//   0. Anthropic 伺服器推模型選單與公告到 `~/.claude.json` → 就算 Claude Code 沒升版也知道有新模型；
//      本機版本不夠而選不了的，列進 `blocked` 讓下拉直接說出原因（少爺 2026-09-24「為什麼我沒看到 Opus 5.5」）
//   1. Claude Code 升版後二進位掃得到新 alias → 立刻進下拉（價先沿用同 tier 並標 ⚠）
//   2. 同版帶進來的 claude-api skill 列出它 → 狀態與價改以官方表為準，⚠ 自動消失
// 沒有 ANTHROPIC_API_KEY 可打 /v1/models，這三條是本機唯一可靠且會自己前進的來源。
//
// ⭐ 2026-09-24 少爺回報下拉混進退役模型（Sonnet 3.7／Haiku 3.5）與幻影 Haiku 3.55：
// 起因是當時唯一的自動來源只有二進位掃描，它給得出 id、給不出「現役／退役」。官方狀態表補進來後：
//   · 已過退役日的一律不進下拉（仍留在目錄供舊 transcript 成本回算）
//   · 官方表沒列、版號又比同家族現役舊的（幻影 3.55）一律不進下拉
//   · 官方表沒列、版號比同家族現役新的＝真新模型，進下拉標 ⚠ 等官方表跟上

import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadSkillCatalog, canonKey, parseModelVersion, compareVersionParts, skillFingerprint } from './modelSkillSource.js'
import { loadPushedModels, claudeVersionFromPath, compareClaudeVersion, pushFingerprint } from './modelPushSource.js'

export const CATALOG_FILE = path.join(os.homedir(), '.claude', 'tc_model_catalog.json')

// 內建基準表。價格單位＝USD / 1M tokens。
// 來源：claude-api skill §Current Models（快取日 2026-06-24）＋ shared/prompt-caching.md §Economics
// 的官方倍率（cache read ≈ 0.1×input、cache write ＝ 1.25×input for 5m TTL）推得 cacheRead/cacheWrite。
// ⚠ 這張表是**退路**：官方表解得到的欄位一律以官方表為準。改價優先改 CATALOG_FILE 的 overrides。
const PRICED_AT = '2026-06-24'

const BUILTIN = [
  // ── 現役（進下拉選單）────────────────────────────────────────────────────
  // Fable 5.1 的 cache read ＝ 0.025×input（官方特例，不是通用的 0.1×），漏掉會把快取讀取成本算成 4 倍
  { id: 'claude-fable-5-1', label: 'Fable 5.1', tier: 'fable',  contextTokens: 1_000_000, input: 10, output: 50, cacheRead: 0.25, current: true },
  { id: 'claude-fable-5',   label: 'Fable 5',   tier: 'fable',  contextTokens: 1_000_000, input: 10, output: 50, current: true },
  { id: 'claude-opus-5',    label: 'Opus 5',    tier: 'opus',   contextTokens: 1_000_000, input: 5,  output: 25, current: true },
  { id: 'claude-opus-4-8',  label: 'Opus 4.8',  tier: 'opus',   contextTokens: 1_000_000, input: 5,  output: 25, current: true },
  // Sonnet 5 導入價 $2/$10 已轉為常態價（官方表 2026-06-24 就是 $2/$10），不再是限時價
  { id: 'claude-sonnet-5',  label: 'Sonnet 5',  tier: 'sonnet', contextTokens: 1_000_000, input: 2,  output: 10, current: true },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', tier: 'haiku',  contextTokens: 200_000,   input: 1,  output: 5,  current: true },

  // Project Glasswing 限定：沒參與的帳號選了會被擋，所以標註但不擋——要不要選是少爺的事
  { id: 'claude-mythos-5-1', label: 'Mythos 5.1', tier: 'mythos', contextTokens: 1_000_000, input: 10, output: 50, cacheRead: 0.25, current: true, note: 'Project Glasswing 限定' },
  { id: 'claude-mythos-5',   label: 'Mythos 5',   tier: 'mythos', contextTokens: 1_000_000, input: 10, output: 50, current: false, selectable: true, note: 'Project Glasswing 限定' },

  // ── 舊世代但官方仍 Active（少爺 2026-08-15 要能挑）：進下拉的「舊世代」段，標《舊》────
  // 依據：claude-api skill models.md「Legacy Models (still active)」＋ 本機 claude.exe alias 表都有
  { id: 'claude-opus-4-7',   label: 'Opus 4.7',   tier: 'opus',   contextTokens: 1_000_000, input: 5,  output: 25, current: false, selectable: true },
  { id: 'claude-opus-4-6',   label: 'Opus 4.6',   tier: 'opus',   contextTokens: 1_000_000, input: 5,  output: 25, current: false, selectable: true },
  { id: 'claude-opus-4-5',   label: 'Opus 4.5',   tier: 'opus',   contextTokens: 200_000,   input: 5,  output: 25, current: false, selectable: true, priceInferred: true },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', tier: 'sonnet', contextTokens: 1_000_000, input: 3,  output: 15, current: false, selectable: true },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', tier: 'sonnet', contextTokens: 1_000_000, input: 3,  output: 15, current: false, selectable: true, priceInferred: true },

  // ── 只留價、不進下拉（已過官方退役日或限定發放；歷史 transcript 的成本回算仍會查到）──
  { id: 'claude-opus-4-1',   label: 'Opus 4.1',   tier: 'opus',   contextTokens: 200_000,   input: 15, output: 75, current: false, priceInferred: true, note: '官方退役日 2026-08-05 已過' },
  // 官方 Deprecated 表寫的是「Retires TBD」＝已淘汰但還沒公布退役日；退不退役由官方表的 retiresAt 決定，這裡不寫死
  { id: 'claude-opus-4-0',   label: 'Opus 4',     tier: 'opus',   contextTokens: 200_000,   input: 15, output: 75, current: false, priceInferred: true, note: '官方已標記淘汰' },
  { id: 'claude-sonnet-4-0', label: 'Sonnet 4',   tier: 'sonnet', contextTokens: 200_000,   input: 3,  output: 15, current: false, priceInferred: true, note: '官方已標記淘汰' },
]

// 官方快取倍率（shared/prompt-caching.md §Economics）——只存 input/output，其餘推導，避免四個數字各自腐爛
// ⭐ CACHE_WRITE 用 2×（1 小時 TTL）而非 1.25×（5 分鐘 TTL）：Claude Code 實際跑的是 1h TTL。
// 實證（少爺 2026-08-15，claude --model claude-opus-4-5 單次探測）：
//   in=10 out=34 cacheRead=25316 cacheWrite=9137，CLI 回報 total_cost_usd=0.104928
//   10*5 + 34*25 + 25316*0.5 + 9137*10 = 104928 → $0.104928 完全吻合（用 6.25 則只算出 $0.0707）
// 也就是說先前所有花費演出都把 cache write 少算 37.5%。
const CACHE_READ_MULT  = 0.1
const CACHE_WRITE_MULT = 2

/**
 * 補齊一筆 entry 的衍生欄位（快取價、導入價到期切換）。輸入不變動，回傳新物件。
 * 導入價（introInput/introUntil）是資料驅動的能力，目前沒有模型在用——下次官方再出限時價時填欄位即可。
 */
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

// 家族名基準清單。⚠ 不要再手動往這裡加新家族——呼叫端會把內建表與官方表出現過的家族一起餵進來，
// 官方表列出新家族（fable／mythos 當年就是這樣冒出來的）時掃描器自動跟著認得。
const BASE_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos']

/** 只收「家族-版號」形態的 alias；`(?![-0-9a-z])` 把帶日期/`-fast`/`-v1` 的變體與截斷前綴擋掉。 */
function aliasRegex(InFamilies) {
  const _families = [...new Set([...BASE_FAMILIES, ...InFamilies])].filter(f => typeof f === 'string' && /^[a-z]+$/.test(f))
  return new RegExp(`claude-(?:${_families.join('|')})-\\d+(?:-\\d+)?(?![-0-9a-z])`, 'g')
}

/**
 * 從 claude 執行檔掃出它認得的模型 alias。
 * `InKnownIds` ＝ 已知為真的 id 集合（內建表＋官方表）；用來保護 `claude-fable-5` 這種
 * 「短版號真的存在」的 id 不被殘影過濾誤殺——`claude-fable-5-1` 出現後它就會被當成切半字串丟掉。
 * `InFamilies` ＝ 額外認得的家族名（由官方表帶進來）。不放寬成任意字串是刻意的：
 * 二進位裡多的是 `claude-xxx-1` 形狀的雜訊，放寬就等於把雜訊灌進下拉。
 * 掃不到（找不到檔／非本機二進位／讀取失敗）一律回空陣列，呼叫端退回內建表，不讓 refresh 失敗連累開機。
 */
export function discoverAliases(InClaudeExe, InKnownIds = new Set(), InFamilies = []) {
  const ALIAS_RE = aliasRegex(InFamilies)
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
    // 有同家族同大版號的細版號存在就判定為殘影。已知為真的 id 不動。
    for (const _id of [..._hits]) {
      if (InKnownIds.has(_id)) continue
      const _m = /^(claude-[a-z]+)-(\d+)$/.exec(_id)
      if (_m && [..._hits].some(o => o.startsWith(`${_m[1]}-${_m[2]}-`))) _hits.delete(_id)
    }
    return [..._hits].sort()
  } catch { return [] }
  finally { if (_fd !== null) { try { fs.closeSync(_fd) } catch {} } }
}

// ─── 目錄組裝與持久化 ─────────────────────────────────────────────────────────

function readCatalogFile() {
  try {
    const _d = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'))
    return _d && typeof _d === 'object' ? _d : {}
  } catch { return {} }
}

let catalogCache = null

/** 這一輪要不要重掃的便宜指紋：只 stat claude.exe＋讀 skill 目錄名，完整掃描則要讀 300MB+。 */
export function catalogFingerprint(InClaudeExe) {
  let _stat = null
  try { _stat = fs.statSync(InClaudeExe) } catch {}
  return `${InClaudeExe}|${_stat?.size ?? 0}|${_stat?.mtimeMs ?? 0}|${skillFingerprint()}|${pushFingerprint()}`
}

/** 已過退役日（或官方直接列在退役表）＝不能再選。`Retires: TBD` 沒有日期，不算退役。 */
function isRetired(InEntry, InNow) {
  if (InEntry.status === 'retired') return true
  if (!InEntry.retiresAt) return false
  const _ms = Date.parse(`${InEntry.retiresAt}T23:59:59Z`)
  return !Number.isNaN(_ms) && _ms <= InNow
}

/** 新模型沒價時拿誰的價來墊：同 tier 現役優先；全新家族取現役裡最貴的（成本寧可高估不低估）。 */
function estimatePeer(InTier, InEntries) {
  const _current = InEntries.filter(e => e.current && e.input != null)
  return _current.find(e => e.tier === InTier)
    ?? _current.sort((a, b) => b.input - a.input)[0]
    ?? InEntries.find(e => e.id === 'claude-sonnet-5')
    ?? InEntries[0]
}

/**
 * 重建目錄：內建表 ∪ 官方表 ∪ 掃描發現 ∪ 手動覆寫（後者蓋前者）。
 * 官方表這次取不到（skill 沒展開／Temp 被清）就用上次學到的那份，讓下拉不會倒退回舊分類。
 */
export function buildCatalog(InClaudeExe, InNow = Date.now()) {
  const _file = readCatalogFile()
  const _overrides = _file.overrides ?? {}
  const _skill = loadSkillCatalog()
  const _learned = _file.learned ?? null
  const _official = _skill ?? _learned                                    // 這輪實際採用的官方表
  const _officialFresh = !!_skill

  const _byId = new Map()
  for (const _b of BUILTIN) _byId.set(_b.id, { ..._b, source: 'builtin', pricedAt: PRICED_AT })

  // 官方表覆蓋內建：現役與否、狀態、退役日、脈絡長度，以及它說得出的價
  for (const _o of _official?.models ?? []) {
    const _base = _byId.get(_o.id) ?? { id: _o.id, label: labelFromId(_o.id) }
    // 備註以內建表的中文為優先，官方英文備註只補內建表沒寫的
    _byId.set(_o.id, { ..._base, ..._o, note: _base.note ?? _o.note, source: _officialFresh ? 'official' : 'official-cached' })
  }

  // 官方退役表寫的是含日期全名（`claude-3-7-sonnet-20250219`），二進位掃到的是 alias
  // （`claude-sonnet-3-7`），要靠 canonKey 才對得起來
  const _statusByCanon = new Map(_official?.byCanon ?? [])
  for (const _e of _byId.values()) {
    if (_e.status) continue
    const _hit = _statusByCanon.get(canonKey(_e.id))
    if (_hit) { _e.status = _hit.status; if (_hit.retiresAt) _e.retiresAt = _hit.retiresAt }
  }

  // 掃到但前面都沒有 ＝ 新模型，或官方沒收錄的舊 alias
  const _discovered = discoverAliases(InClaudeExe, new Set(_byId.keys()), [..._byId.values()].map(e => e.tier))
  const _added = []
  const _entries = [..._byId.values()]
  for (const _id of _discovered) {
    if (_byId.has(_id)) continue
    const _canonHit = _statusByCanon.get(canonKey(_id))
    const _tier = /^claude-([a-z]+)-/.exec(_id)?.[1] ?? 'sonnet'
    const _peer = estimatePeer(_tier, _entries)
    const _entry = {
      id: _id, label: labelFromId(_id), tier: _tier,
      contextTokens: _peer.contextTokens, input: _peer.input, output: _peer.output,
      source: 'discovered', pricingEstimated: true, estimatedFrom: _peer.id,
      status: _canonHit?.status ?? classifyUnlisted(_id, _entries),
      retiresAt: _canonHit?.retiresAt,
    }
    // `new` ＝ 版號比同家族現役新，官方表還沒跟上 → 先進下拉讓少爺能用
    _entry.current = _entry.status === 'new'
    _byId.set(_id, _entry)
    if (_entry.status === 'new') _added.push(_id)
  }

  // 官方推播（`~/.claude.json`）：伺服器直接推來的選單，不必等 Claude Code 升版。
  // 真 model id 的直接收（含 `claude-opus-5[1m]` 這種脈絡變體，價與狀態沿用同一個 canon 的既有條目）。
  const _push = loadPushedModels()
  for (const _p of _push.models) {
    if (_byId.has(_p.id) || _p.disabled) continue
    const _twin = _entries.find(e => canonKey(e.id) === canonKey(_p.id))
    const _variant = /\[([^\]]+)\]$/.exec(_p.id)?.[1]
    _byId.set(_p.id, {
      ...(_twin ?? {}),
      id: _p.id,
      label: `${_p.label || _twin?.label || labelFromId(_p.id)}${_variant ? `（${_variant.toUpperCase()} 脈絡）` : ''}`,
      note: _p.description || _twin?.note,
      source: 'pushed',
      current: _twin?.current ?? true,
      selectable: true,
    })
  }

  for (const [_id, _ov] of Object.entries(_overrides)) {
    _byId.set(_id, { ...(_byId.get(_id) ?? { id: _id, label: labelFromId(_id), tier: 'sonnet', current: true }), ..._ov, source: 'override', pricingEstimated: false })
  }

  // 官方表列到、但三處都沒寫價的（多半是舊世代）→ 沿用同 tier 現役價並標 ⚠，免得成本演出出現 NaN
  for (const _e of _byId.values()) {
    if (_e.input != null) continue
    const _peer = estimatePeer(_e.tier, _entries)
    _e.input = _peer.input
    _e.output = _peer.output
    _e.contextTokens ??= _peer.contextTokens
    _e.pricingEstimated = true
    _e.estimatedFrom = _peer.id
  }

  // 最後統一判「能不能選」：退役的一律不能選；官方說得出狀態的照狀態走；
  // 官方沒說的（skill 取不到時的純內建路徑）沿用內建表原本的旗標，不倒退
  const _retiredIds = []
  for (const _e of _byId.values()) {
    if (isRetired(_e, InNow)) {
      if (_e.current || _e.selectable || _e.source === 'discovered') _retiredIds.push(_e.id)
      _e.retired = true
      _e.current = false
      _e.selectable = false
      continue
    }
    _e.retired = false
    if (_e.status === 'active' || _e.status === 'deprecated' || _e.status === 'new') _e.selectable = true
    else if (_e.status === 'unlisted') _e.selectable = false
  }

  const _models = [..._byId.values()].map(e => hydrate(e, InNow))
  // 現役排前面，同組內 tier 由貴到便宜、同 tier 版號由新到舊，讓下拉選單順序穩定
  const _tierRank = { fable: 0, mythos: 1, opus: 2, sonnet: 3, haiku: 4 }
  _models.sort((a, b) =>
    (a.current === b.current ? 0 : a.current ? -1 : 1)
    || (_tierRank[a.tier] ?? 9) - (_tierRank[b.tier] ?? 9)
    || -compareVersionParts(parseModelVersion(a.id)?.parts ?? [0], parseModelVersion(b.id)?.parts ?? [0])
    || a.id.localeCompare(b.id))

  // 官方有、本機選不了的 → 不是「沒有這個模型」，是「這台的 Claude Code 太舊」。
  // 列成 blocked 讓下拉直接把原因寫在上面，而不是讓少爺對著少一項的清單猜（2026-09-24 Opus 5.5）。
  const _installedVersion = claudeVersionFromPath(InClaudeExe)
  const _blocked = []
  for (const _b of _push.blocked) {
    const _cmp = compareClaudeVersion(_installedVersion, _b.requiresVersion)
    if (_cmp !== null && _cmp >= 0) continue                             // 本機版本已達標 ＝ 這筆過期了
    _blocked.push({
      ..._b,
      installedVersion: _installedVersion,
      note: _b.requiresVersion
        ? `需要 Claude Code ${_b.requiresVersion}+（本機 ${_installedVersion ?? '版本不明'}）`
        : _b.reason,
    })
  }
  // 官方公告了新模型、但三個來源都還沒有它 → 一樣列出來，別讓少爺以為 TC 漏了
  for (const _a of _push.announcements) {
    if (!_a.modelLabel) continue
    if (_blocked.some(b => b.label === _a.modelLabel)) continue
    if ([..._byId.values()].some(e => e.label === _a.modelLabel)) continue
    _blocked.push({ key: _a.id, label: _a.modelLabel, reason: _a.text, requiresVersion: null, installedVersion: _installedVersion, note: _a.text })
  }

  catalogCache = {
    models: _models,
    refreshedAt: InNow,
    pricedAt: _official?.pricedAt ?? PRICED_AT,
    discoveredCount: _discovered.length,
    newlyDiscovered: _added,
    estimated: _models.filter(m => m.pricingEstimated && (m.current || m.selectable)).map(m => m.id),
    excludedRetired: _retiredIds,
    excludedUnlisted: _models.filter(m => m.status === 'unlisted').map(m => m.id),
    blocked: _blocked,
    installedClaudeVersion: _installedVersion,
    officialSource: _officialFresh ? `skill ${_skill.skillVersion}` : (_learned ? `skill ${_learned.skillVersion}（上次學到的）` : 'none'),
    source: _discovered.length ? 'claude-binary+builtin' : 'builtin-only',
  }
  try {
    fs.mkdirSync(path.dirname(CATALOG_FILE), { recursive: true })
    // learned ＝ 這次解析到的官方表，留著給 skill 目錄消失時頂用
    const _keep = _skill ? { models: _skill.models, byCanon: _skill.byCanon, pricedAt: _skill.pricedAt, skillVersion: _skill.skillVersion } : _learned
    fs.writeFileSync(CATALOG_FILE, JSON.stringify({ ...catalogCache, overrides: _overrides, learned: _keep }, null, 2), 'utf8')
  } catch {}
  return catalogCache
}

/**
 * 官方表沒列到的 id 怎麼歸類：版號比同家族現役新 ＝ 真的新模型（官方表還沒跟上）；
 * 反之多半是二進位裡的舊字串或切半殘影（如 `claude-haiku-3-55`），不進下拉。
 */
function classifyUnlisted(InId, InEntries) {
  const _v = parseModelVersion(InId)
  if (!_v) return 'unlisted'
  const _newest = InEntries
    .filter(e => e.current && parseModelVersion(e.id)?.family === _v.family)
    .map(e => parseModelVersion(e.id).parts)
    .sort(compareVersionParts)
    .pop()
  if (!_newest) return 'new'                                              // 全新家族＝當新模型
  return compareVersionParts(_v.parts, _newest) > 0 ? 'new' : 'unlisted'
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
  // 歷史 transcript 可能帶含日期的全名（`claude-opus-4-5-20251101`），靠 canonKey 對回來
  const _canon = canonKey(InModelId ?? '')
  const _byCanon = _cat.models.find(m => canonKey(m.id) === _canon)
  if (_byCanon) return _byCanon.pricing
  const _tier = /^claude-([a-z]+)-/.exec(InModelId ?? '')?.[1]
  const _peer = _cat.models.find(m => m.tier === _tier && m.current)
    ?? _cat.models.find(m => m.id === 'claude-sonnet-5')
    ?? _cat.models[0]
  return _peer.pricing
}
