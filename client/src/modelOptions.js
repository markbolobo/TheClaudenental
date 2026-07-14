// AI 模型選單共用清單（少爺 2026-07-14：仕酒師送入/開新聊天室、Chat 介面、QA 留言區可選模型）
// value 直接傳給 claude CLI --model（空字串 = 不帶參數，用 CLI / session 預設）
export const MODEL_OPTIONS = [
  { value: '', label: '模型：預設' },
  { value: 'claude-fable-5', label: 'Fable 5' },
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
