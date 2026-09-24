// AI 模型選單共用清單（少爺 2026-07-14：仕酒師送入/開新聊天室、Chat 介面、QA 留言區可選模型）
// value 直接傳給 claude CLI --model（空字串 = 不帶參數，用 CLI / session 預設）
//
// ⭐ 少爺 2026-08-15「要能自動更新這個功能」：清單改由 server 的 `/api/models` 供應
// （來源＝內建表 ∪ 掃已安裝 claude.exe 得到的 alias ∪ 手動覆寫，見 server/modelCatalog.js）。
// 下面這份保留為**離線退路**：server 沒起來、或 fetch 失敗時照樣有東西可選，不會空選單。
import { useSyncExternalStore } from 'react'

export const MODEL_OPTIONS = [
  { value: '', label: '模型：預設' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
]

// 模型強度（claude CLI --effort；空字串 = 不帶參數，用 session 預設）
export const EFFORT_OPTIONS = [
  { value: '', label: '強度：預設' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'xHigh' },
  { value: 'max', label: 'Max' },
]

// ─── 目錄 store（server 推來的清單 → 所有下拉選單即時同步）──────────────────

let catalog = null
let optionsSnapshot = MODEL_OPTIONS        // useSyncExternalStore 要求同值同參考，故快取
const subscribers = new Set()

function subscribe(InFn) {
  subscribers.add(InFn)
  return () => subscribers.delete(InFn)
}

/**
 * server 回來的 catalog 換算成下拉選項：現役在前，官方仍 Active 的舊世代接在後面標《舊》
 * （少爺 2026-08-15「我可以選擇更低階的模型嗎」）。已過退役日的只留在目錄供成本回算，不進選單。
 */
export function setModelCatalog(InCatalog) {
  const _models = InCatalog?.models
  if (!Array.isArray(_models) || !_models.length) return
  catalog = InCatalog
  const _opt = (m, InSuffix = '') => ({
    value: m.id,
    // 價格是掃到新模型後沿用同 tier 猜的 → 標記讓少爺知道要校正，別把猜測當事實
    label: `${m.label}${InSuffix}${m.pricingEstimated ? ' ⚠' : ''}`,
    title: optionTitle(m, InSuffix),
  })
  // 官方有、本機選不了的（例：Claude Code 版本不夠）排在最上面並停用——
  // 少爺 2026-09-24「為什麼我沒看到 Opus 5.5」：少一項而不說原因，只能靠猜
  const _blocked = (InCatalog.blocked ?? []).map(b => ({
    value: `blocked:${b.key}`,
    label: `${b.label}（${b.requiresVersion ? `需 Claude Code ${b.requiresVersion}+` : '本機尚未支援'}）`,
    title: b.note || b.reason,
    disabled: true,
  }))
  optionsSnapshot = [
    { value: '', label: '模型：預設' },
    ..._blocked,
    ..._models.filter(m => m.current).map(m => _opt(m)),
    ..._models.filter(m => !m.current && m.selectable).map(m => _opt(m, '《舊》')),
  ]
  for (const _fn of subscribers) _fn()
}

/** 滑過下拉選項時的說明：id、單價、脈絡長度、限定條件、⚠ 的意思——下拉只有名字，別的都藏在這。 */
function optionTitle(InModel, InSuffix) {
  const _parts = [InModel.id]
  const _price = InModel.pricing ?? {}
  if (_price.input != null) _parts.push(`$${_price.input}/$${_price.output} 每百萬 token`)
  if (InModel.contextTokens) _parts.push(`脈絡 ${Math.round(InModel.contextTokens / 1000)}K`)
  if (InSuffix) _parts.push('官方仍可用的舊世代')
  if (InModel.note) _parts.push(InModel.note)
  if (InModel.pricingEstimated) _parts.push('⚠ 價格為同 tier 推估，官方模型表尚未收錄')
  return _parts.join(' · ')
}

export function getModelCatalog() { return catalog }

/** 下拉選單用這個取清單；server 推新目錄時自動重繪。 */
export function useModelOptions() {
  return useSyncExternalStore(subscribe, () => optionsSnapshot, () => optionsSnapshot)
}
