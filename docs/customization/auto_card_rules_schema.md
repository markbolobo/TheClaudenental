# auto_card_rules.json 改造指南

> 給對方 Claude（或任何 AI 代工）看的「哪些可改、怎麼改、不要改什麼」指南。
> 對應檔案：`~/.claude/tc_user_config/auto_card_rules.json`（使用者本機，AI 改的就是這個）
> 範例樣板：`config.example/auto_card_rules.json`（工具 repo，第一次啟動 server auto-copy 過去）
> 本指南位置：`docs/customization/auto_card_rules_schema.md`（工具 repo，git tracked）

---

## 用途

此檔控制 TheClaudenental 「對話中自動建卡」行為：當使用者在 Claude Code 送出 prompt 時，hook 會把 prompt 丟給 server，server 根據此檔的規則判斷「這個 prompt 是任務型輸入嗎？」決定要不要自動建一張 TODO 卡。

設計目的：把「建卡」從 LLM 自律行為變成環境保證，不依賴 Claude 記憶。

---

## 規則打分機制

server 收到 prompt 時：
1. 先過 `min_prompt_length` 過濾太短的 prompt
2. 跑 `task_signals_positive` 每個 pattern，命中加 weight
3. 跑 `task_signals_negative` 每個 pattern，命中加 weight（負數）
4. 加總分數 ≥ `min_score_to_create_card` → 建卡，否則不建

---

## 可安全改的欄位

### `enabled` (boolean)
整體開關。`false` = hook 收到 prompt 但不建卡（保留事件，純觀察）。

### `min_prompt_length` (number)
prompt 字數低於此值直接不建。建議範圍 5-15。太低 → 一個字回應也建卡；太高 → 漏判短任務（如「修這個 bug」）。

### `min_score_to_create_card` (number)
建議範圍 1-3。
- `1`：寬鬆（一個 positive signal 就建）
- `2`：標準（兩個 positive 或一個 positive 高權重）
- `3`：嚴格（多重信號才建）

### `task_signals_positive` (array)
正向信號。每筆 `{ pattern, weight }`：
- `pattern`：JavaScript regex 字串（會以 new RegExp 編譯）。注意 `\\` 要 double-escape。
- `weight`：建議 1-3（普通信號 1，明確任務動詞 2，強指令 3）

**改造範例**：
```json
// 使用者抱怨「漏判規劃任務」→ 加：
{ "pattern": "計畫|藍圖|roadmap|藍本", "weight": 2 }

// 使用者主要做動畫加工 → 加領域詞：
{ "pattern": "烘焙|baking|加工|套用 modifier", "weight": 2 }
```

### `task_signals_negative` (array)
負向信號（純對話 / 確認 / 提問）。weight 通常負數。

**改造範例**：
```json
// 使用者抱怨「閒聊也建卡」→ 加：
{ "pattern": "謝謝|感謝|辛苦|加油", "weight": -3 }

// 使用者抱怨「我問純查詢類問題也建卡」→ 加：
{ "pattern": "什麼是|怎麼用|有哪些|介紹一下", "weight": -2 }
```

### `default_column` (string)
建出來的卡進哪個 column。可選：`idea` / `discussing` / `doing` / `verifying` / `done` / `paused` / `storage`。
建議 `idea`（待整理）或 `discussing`（已開始討論）。

### `default_tag_ids` (array of strings)
新建卡片自動掛的 tag。對應使用者 tag 列表（`/api/todo-tags` 取得）。

### `title_max_chars` (number)
卡片標題從 prompt 取前 N 字。建議 40-80。

---

## ⚠️ 不要改的欄位（架構欄位，亂改會壞掉）

- `$schema_version`：版本號，server 會根據此值跑 migration
- `$schema_path`：指向本文件，工具用來顯示 「點此看改造指南」
- `$ai_editable`：保留欄位，標記此檔可被 AI 改造
- `$description`：人類可讀說明
- `_examples`：範例陣列，純註解用，不影響邏輯

---

## 改造工作流（對方 Claude 用此指南時的標準流程）

1. **先讀目前值**：`~/.claude/tc_user_config/auto_card_rules.json`
2. **理解使用者抱怨**（誤判 / 漏判 / 嫌嚴 / 嫌寬）
3. **判斷該改哪個欄位**：
   - 嫌嚴（漏判）→ 加 positive 或降 `min_score_to_create_card`
   - 嫌寬（誤判）→ 加 negative 或升 `min_score_to_create_card`
   - 純不想建 → `enabled: false`
4. **改完先 dry run**：跑 server 的 `/api/auto-card-rules/test` 端點（如已實作）丟過去 1 週的 prompts 看 hit ratio
5. **寫回**：`~/.claude/tc_user_config/auto_card_rules.json`
6. **告訴使用者**：「我改了 X 條規則，理由是 Y，預期 Z 種 prompt 會被新增/排除建卡」

---

## 風險提示

- **regex 寫錯會讓整個檔解析失敗** → server fallback 到內建預設規則 + 在系統 log 寫一筆警告，但使用者會看到 hook 行為「不像他想要的」
- **min_score 設太低 + positive 太多** → 建出大量垃圾卡污染 idea 欄
- **min_score 設太高 + negative 太強** → 完全不建卡，hook 等於沒裝
- 建議：每次改完讓使用者試用一週、看 idea 欄品質、再迭代

---

## 與其他 schema 的關係

未來會有更多 `xxx_rules.json` + 對應 `xxx_schema.md`：
- `column_progress_rules.json` — 卡片自動推進階段條件
- `card_sediment_rules.json` — 沉澱按鈕的 md 模板
- `notification_rules.json` — 何時推通知 / Toast

每個都遵守同樣設計鐵律：**範例在工具 repo / 客製化值在 ~/.claude/tc_user_config/ / schema md 在工具 repo .agent/knowledge/**。
