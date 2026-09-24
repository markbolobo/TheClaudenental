// 官方模型表來源：Claude Code 隨版本內建的 claude-api skill
// （少爺 2026-09-24「我說過要自動化更新，當官方發布新的就要更新 TC 可以使用的模型」）
//
// 為什麼是這裡：本機沒有 ANTHROPIC_API_KEY，打不了 /v1/models；claude.exe 字串掃描只掃得出 id，
// 掃不出「現役／退役／價格」。claude-api skill 由 Claude Code 隨版本帶著走，內含官方四張狀態表
// 與一張定價表，是本機唯一「會自己前進、又說得出狀態與價格」的來源。
//
// 佈局：<temp>/claude/bundled-skills/<Claude Code 版本>/<hash>/claude-api/
//   shared/models.md            `## Current` / `## Legacy` / `## Deprecated` / `## Retired` 四張狀態表
//                               （別名、脈絡長度、最大輸出、退役日）＋每個模型的敘述 bullet（部分帶價）
//   <語言>/claude-api/README.md 「選模型」段的程式註解帶價（`model="claude-opus-5",  # $5.00/$25.00 per 1M tokens`）
//   SKILL.md                    `## Current Models (cached: YYYY-MM-DD)` 定價表——**目前不落地**
//                               （skill 本體是注入 prompt 的，只有被引用的檔案才展開到磁碟）；
//                               哪天落地了這裡照樣吃得到，所以留著解析。
//
// ⚠ 這份是 session 用到 claude-api 時才展開的快取：沒人用過、或 Temp 被清就不存在。
// 取不到一律回 null，呼叫端退回上次學到的結果（catalog 檔的 learned 段），不讓開機失敗。
//
// ⚠ 價格覆蓋率：狀態／脈絡長度／退役日是表格，全員都有；價格散在敘述文字裡，只有部分模型寫明
// （2026-09-24 實測＝Fable 5.1、Opus 5、Sonnet 5、Haiku 4.5 四筆）。解不到的沿用 modelCatalog
// 的 BUILTIN 基準表，再沒有才退到同 tier 推估並標 ⚠。同句提到兩個模型兩個價的（Fable 5 那段）
// 一律不吃——寧可退回基準表，也不要解出別人的價。

import fs from 'fs'
import os from 'os'
import path from 'path'

// ─── 版本與 id 正規化 ─────────────────────────────────────────────────────────

/**
 * 把 model id 收斂成「家族-版號」的比對鍵，讓新舊兩種寫法對得起來。
 * `claude-sonnet-3-7` 與 `claude-3-7-sonnet-20250219` 都 → `sonnet-3.7`。
 */
export function canonKey(InId) {
  const _s = String(InId ?? '').toLowerCase()
    .replace(/\[[^\]]*\]$/, '')                                        // 去掉脈絡變體後綴（`claude-opus-5[1m]`）
    .replace(/-\d{8}$/, '')                                            // 去掉日期快照後綴
  let _m = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(_s)                 // claude-<家族>-<版號>
  if (_m) return `${_m[1]}-${_m[2].split('-').join('.')}`
  _m = /^claude-(\d+(?:-\d+)?)-([a-z]+)$/.exec(_s)                     // claude-<版號>-<家族>（舊體例）
  if (_m) return `${_m[2]}-${_m[1].split('-').join('.')}`
  return _s
}

/** 取 id 的家族與版號陣列：`claude-opus-4-8` → `{ family: 'opus', parts: [4, 8] }`。認不得回 null。 */
export function parseModelVersion(InId) {
  const _canon = canonKey(InId)
  const _m = /^([a-z]+)-(\d+(?:\.\d+)?)$/.exec(_canon)
  if (!_m) return null
  return { family: _m[1], parts: _m[2].split('.').map(Number) }
}

/** 版號陣列比大小：`[4,8]` vs `[5]` → 負數。缺的位補 0。 */
export function compareVersionParts(InA, InB) {
  const _len = Math.max(InA.length, InB.length)
  for (let _i = 0; _i < _len; _i++) {
    const _d = (InA[_i] ?? 0) - (InB[_i] ?? 0)
    if (_d !== 0) return _d
  }
  return 0
}

// ─── 找 skill 目錄 ────────────────────────────────────────────────────────────

/** 版本字串比大小（`2.1.278` > `2.1.99`），給挑最新展開版用。 */
function compareDirVersion(InA, InB) {
  const _a = InA.split('.').map(n => Number(n) || 0)
  const _b = InB.split('.').map(n => Number(n) || 0)
  return compareVersionParts(_a, _b)
}

/**
 * 找展開過的 claude-api skill 目錄，多個版本取最新、且必須真的有 `shared/models.md`。
 * 一個都沒有回 null。
 */
export function findSkillDir(InTempDir = os.tmpdir()) {
  const _root = path.join(InTempDir, 'claude', 'bundled-skills')
  let _versions = []
  try { _versions = fs.readdirSync(_root) } catch { return null }
  _versions.sort(compareDirVersion).reverse()
  for (const _ver of _versions) {
    let _hashes = []
    try { _hashes = fs.readdirSync(path.join(_root, _ver)) } catch { continue }
    for (const _hash of _hashes) {
      const _dir = path.join(_root, _ver, _hash, 'claude-api')
      if (fs.existsSync(path.join(_dir, 'shared', 'models.md'))) return { dir: _dir, version: _ver }
    }
  }
  return null
}

// ─── markdown 表格解析 ────────────────────────────────────────────────────────

function normHeader(InText) { return InText.toLowerCase().replace(/[^a-z0-9]/g, '') }

/**
 * 把 markdown 讀成 `[{ heading, rows: [{ 正規化表頭: 值 }] }]`。
 * 用表頭取值而不是欄位序號——官方哪天調換欄位順序也不會解錯。
 */
function readTables(InMd) {
  const _tables = []
  let _heading = ''
  let _headers = null
  for (const _raw of InMd.split(/\r?\n/)) {
    const _line = _raw.trim()
    if (_line.startsWith('#')) { _heading = _line.replace(/^#+\s*/, ''); _headers = null; continue }
    if (!_line.startsWith('|')) { _headers = null; continue }
    const _body = _line.replace(/^\|/, '').replace(/\|$/, '')
    const _cells = _body.split('|').map(c => c.trim())
    if (/^[-: ]*$/.test(_cells.join(''))) continue                     // 表頭下的分隔列
    if (!_headers) { _headers = _cells.map(normHeader); _tables.push({ heading: _heading, rows: [] }); continue }
    const _row = {}
    _headers.forEach((h, i) => { _row[h] = _cells[i] ?? '' })
    _tables[_tables.length - 1].rows.push(_row)
  }
  return _tables
}

function unquote(InText) { return String(InText ?? '').replace(/`/g, '').trim() }

/** 一列裡取得 model id：優先 alias 欄（官方叫人用的），沒有才退回 Full ID。 */
function pickId(InRow) {
  for (const _key of ['aliasusethis', 'alias', 'modelid', 'fullid']) {
    const _v = unquote(InRow[_key])
    if (_v && _v !== '-' && _v.startsWith('claude')) return _v
  }
  return null
}

/** `1M` → 1000000、`200K` → 200000。認不得回 null。 */
function parseContext(InText) {
  const _m = /^([\d.]+)\s*([MK])$/i.exec(String(InText ?? '').trim())
  if (!_m) return null
  return Math.round(Number(_m[1]) * (_m[2].toUpperCase() === 'M' ? 1_000_000 : 1_000))
}

/** `$10.00` → 10。認不得回 null。 */
function parsePrice(InText) {
  const _m = /\$\s*([\d.]+)/.exec(String(InText ?? ''))
  return _m ? Number(_m[1]) : null
}

/** 從狀態文字或 Retires／Retired 欄取退役日，取得到回 `YYYY-MM-DD`，`TBD` 之類回 null。 */
function parseRetireDate(InRow) {
  const _text = `${InRow.status ?? ''} ${InRow.retires ?? ''} ${InRow.retired ?? ''}`
  const _iso = /(\d{4}-\d{2}-\d{2})/.exec(_text)
  if (_iso) return _iso[1]
  const _human = /([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})/.exec(_text)
  if (_human) {
    const _ms = Date.parse(`${_human[1]} UTC`)                          // 不補 UTC 會被當本地時間，轉回來差一天
    if (!Number.isNaN(_ms)) return new Date(_ms).toISOString().slice(0, 10)
  }
  return null
}

/** 判這一列是現役／已宣告退役／已退役。標題與狀態欄任一說退役就算退役。 */
function statusFor(InHeading, InRow) {
  const _h = InHeading.toLowerCase()
  const _s = `${InRow.status ?? ''}`.toLowerCase()
  if (_h.includes('retired') || _s.includes('retired')) return 'retired'
  if (_h.includes('deprecated') || _s.includes('deprecated')) return 'deprecated'
  return 'active'
}

/** `Claude Opus 4.8` → `Opus 4.8`（TC 下拉一向不帶 Claude 前綴）。 */
function shortLabel(InFriendly) {
  return String(InFriendly ?? '').replace(/^Claude\s+/i, '').trim()
}

/** 狀態欄括號裡的但書（如 `Active (Project Glasswing only)`）→ 存成備註給 hover 用。 */
function parseNote(InRow) {
  const _m = /\(([^)]*only[^)]*)\)/i.exec(String(InRow.status ?? ''))
  return _m ? _m[1].trim() : null
}

// ─── 價格來源（三處，後面的蓋前面的）────────────────────────────────────────

/** 把一筆價寫進 map，只覆蓋有值的欄位——不同來源各給一半也拼得起來。 */
function mergePrice(InMap, InId, InPatch) {
  const _cur = InMap.get(InId) ?? {}
  for (const [_k, _v] of Object.entries(InPatch)) if (_v != null) _cur[_k] = _v
  InMap.set(InId, _cur)
}

/** 來源一：各語言 `<lang>/claude-api/README.md`「選模型」段的註解 `# $5.00/$25.00 per 1M tokens`。 */
function readPriceComments(InDir, InOut) {
  let _langs = []
  try { _langs = fs.readdirSync(InDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { return }
  for (const _lang of _langs) {
    let _txt = ''
    try { _txt = fs.readFileSync(path.join(InDir, _lang, 'claude-api', 'README.md'), 'utf8') } catch { continue }
    const _re = /["'`](claude-[a-z0-9-]+)["'`][^\n]*?\$([\d.]+)\s*\/\s*\$([\d.]+)\s*per 1M tokens/g
    for (const _m of _txt.matchAll(_re)) mergePrice(InOut, _m[1], { input: Number(_m[2]), output: Number(_m[3]) })
  }
}

/**
 * 來源二：`shared/models.md` 的模型敘述 bullet，`($10/$50 per MTok; cache reads $0.25/MTok)`。
 * 一行 bullet 可能同時掛兩個模型名（「Fable 5 / Mythos 5」），有價就兩個都給——官方那句話的意思
 * 本來就是「同價」。快取價只吃 `cache reads $X/MTok` 這種緊接寫法，「cache reads here are ...
 * rather than 某某的 ...」那種比較句一律不吃。
 */
function readPriceProse(InMd, InIdByLabel, InOut) {
  for (const _raw of InMd.split(/\r?\n/)) {
    const _line = _raw.trim()
    if (!_line.startsWith('- **')) continue
    const _ids = []
    for (const _n of _line.matchAll(/\*\*([^*]+)\*\*/g)) {
      const _id = InIdByLabel.get(shortLabel(_n[1]))
      if (_id) _ids.push(_id)
    }
    if (!_ids.length) continue
    const _pair = /\$([\d.]+)\s*\/\s*\$([\d.]+)\s*per MTok/.exec(_line)
    const _cache = /cache reads?\s+\$([\d.]+)\s*\/\s*MTok/.exec(_line)
    if (!_pair && !_cache) continue
    for (const _id of _ids) {
      mergePrice(InOut, _id, {
        input:     _pair ? Number(_pair[1]) : null,
        output:    _pair ? Number(_pair[2]) : null,
        cacheRead: _cache ? Number(_cache[1]) : null,
      })
    }
  }
}

/** 來源三：`SKILL.md` 的定價表（目前不落地，落地了就以它為準）。回傳定價日期。 */
function readPriceTable(InDir, InOut) {
  let _txt = ''
  try { _txt = fs.readFileSync(path.join(InDir, 'SKILL.md'), 'utf8') } catch { return null }
  let _pricedAt = null
  for (const _t of readTables(_txt)) {
    const _m = /^Current Models\s*\(cached:\s*([\d-]+)\)/i.exec(_t.heading)
    if (!_m) continue
    _pricedAt = _m[1]
    for (const _row of _t.rows) {
      const _id = pickId(_row)
      if (!_id) continue
      mergePrice(InOut, _id, {
        input:         parsePrice(_row.input1m),
        output:        parsePrice(_row.output1m),
        contextTokens: parseContext(_row.context),
      })
    }
  }
  return _pricedAt
}

// ─── 對外：解析整包 skill ─────────────────────────────────────────────────────

/**
 * 解析一個 claude-api skill 目錄。
 * 回 `{ models, byCanon, pricedAt, skillVersion }`；`models` 不含已退役者（官方沒給它們價，
 * 留著也算不了成本），退役資訊改由 `byCanon` 供比對——退役表寫的是含日期全名、
 * 二進位掃到的是 alias，兩邊要靠 canonKey 才對得起來。
 * 讀不到 `shared/models.md` 或表格空了回 null。
 */
export function parseSkillModels(InDir) {
  let _modelsMd = ''
  try { _modelsMd = fs.readFileSync(path.join(InDir, 'shared', 'models.md'), 'utf8') } catch { return null }

  const _tables = readTables(_modelsMd).filter(t => /^(Current|Legacy|Deprecated|Retired) Models/i.test(t.heading))
  if (!_tables.length) return null

  // 先把四張表讀成狀態，順便建「顯示名 → id」給敘述 bullet 對照用
  const _rows = []
  const _byCanon = new Map()
  const _idByLabel = new Map()
  for (const _t of _tables) {
    const _isCurrentTable = /^Current Models/i.test(_t.heading)
    for (const _row of _t.rows) {
      const _id = pickId(_row)
      if (!_id) continue
      const _status = statusFor(_t.heading, _row)
      _byCanon.set(canonKey(_id), { id: _id, status: _status, retiresAt: parseRetireDate(_row) })
      if (_status === 'retired') continue
      const _label = shortLabel(_row.friendlyname)
      if (_label) _idByLabel.set(_label, _id)
      _rows.push({ id: _id, row: _row, status: _status, isCurrentTable: _isCurrentTable, label: _label })
    }
  }
  if (!_rows.length) return null

  const _prices = new Map()
  readPriceComments(InDir, _prices)
  readPriceProse(_modelsMd, _idByLabel, _prices)
  const _pricedAt = readPriceTable(InDir, _prices)

  const _models = []
  for (const _r of _rows) {
    const _price = _prices.get(_r.id) ?? {}
    const _entry = { id: _r.id, status: _r.status, current: _r.isCurrentTable && _r.status === 'active' }
    const _tier = parseModelVersion(_r.id)?.family
    const _retiresAt = parseRetireDate(_r.row)
    const _ctx = _price.contextTokens ?? parseContext(_r.row.context)
    const _maxOut = parseContext(_r.row.maxoutput)
    const _note = parseNote(_r.row)
    if (_r.label) _entry.label = _r.label
    if (_tier) _entry.tier = _tier
    if (_retiresAt) _entry.retiresAt = _retiresAt
    if (_note) _entry.note = _note
    if (_ctx != null) _entry.contextTokens = _ctx
    if (_maxOut != null) _entry.maxOutputTokens = _maxOut
    if (_price.input != null) _entry.input = _price.input
    if (_price.output != null) _entry.output = _price.output
    if (_price.cacheRead != null) _entry.cacheRead = _price.cacheRead
    if (_price.input != null) _entry.priceFrom = 'skill'
    _models.push(_entry)
  }

  return { models: _models, byCanon: [..._byCanon.entries()], pricedAt: _pricedAt, skillVersion: null }
}

/**
 * 找到並解析官方表。取不到（沒展開過／Temp 被清／格式大改）回 null，
 * 呼叫端退回 catalog 檔裡上次學到的那份，不讓模型下拉倒退。
 */
export function loadSkillCatalog(InTempDir = os.tmpdir()) {
  const _found = findSkillDir(InTempDir)
  if (!_found) return null
  const _parsed = parseSkillModels(_found.dir)
  if (!_parsed) return null
  return { ..._parsed, skillVersion: _found.version, skillDir: _found.dir }
}

/** skill 目錄的版本指紋：Claude Code 換版就會變，用來決定要不要重掃（只讀目錄名、不讀檔）。 */
export function skillFingerprint(InTempDir = os.tmpdir()) {
  return findSkillDir(InTempDir)?.version ?? 'none'
}
