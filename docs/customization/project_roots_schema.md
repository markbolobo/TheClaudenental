# project_roots.json 改造指南（給 AI 代工用）

## 用途

控制 TheClaudenental 「點 markdown 檔案連結 → 觸發本機 VSCode 開檔（含跳行）」這個 feature。

當使用者在儀表板看到 markdown 內容（卡片 note、對話記錄、心腹輸出）裡有 `[name](relative/path#L42)` 之類的連結，點下去會 POST 到 server，server 在 PC 端執行 `code -g <abs>:<line>`，VSCode 跳出定位該檔該行。

**安全邊界**：僅 owner 觸發；path 必須在 `project_roots[]` 某根之內；副檔名必須在 `allowed_extensions[]` 白名單；server 端 path traversal block。

---

## 可安全改的欄位

### `enabled` (bool, default `true`)
關掉整個 feature。Guest 看到連結仍渲染，點下去不會有任何反應（不會 toast）。

### `project_roots` (string[], 必填)
候選根目錄（絕對路徑，**用正斜線** `/` 即使在 Windows 上）。
server 拿 `relativePath` 依序對每個 root 拼 abs path，**第一個 `fs.existsSync(abs)` 為 true 的就用**。

**範例**：
```json
"project_roots": [
  "C:/Project/RomanPrototype",
  "C:/Project/TheClaudenental",
  "C:/Project/MasterBrain"
]
```

**注意順序**：兩個 root 有同名相對檔（如 `.agent/knowledge/foo.md`）時，前面的優先。把最常用 / 最當前的 project 放最前面。

### `vscode_cli` (string, default `"code"`)
VSCode CLI 指令。預設 `code` 假設在系統 PATH。

**Windows 替代**：
- `"code.cmd"`（某些 PATH 設定需要）
- `"C:/Users/<USER>/AppData/Local/Programs/Microsoft VS Code/bin/code.cmd"`（絕對路徑）
- `"cursor"` / `"windsurf"` 等其他 VSCode-fork

### `allowed_extensions` (string[], 必填)
副檔名白名單。預設覆蓋常見 code / config / UE asset 副檔名。

**安全考量**：不要加 `.exe` / `.dll` / `.bin` 等執行檔。VSCode 開純文字檔安全；開二進位檔可能讓 VSCode 卡很久。

### `owner_only` (bool, default `true`)
**不建議改成 false**。設 true → guest 點檔案連結會收 403 + toast「只有 owner 能開」（誠實但不誤導）。設 false → 任何 user 點都會在 owner 的 PC 上開 VSCode（安全隱憂：guest 可隨意開檔案）。

---

## 不要改的欄位

- `$schema_version` — 版本號，server migration 用
- `$schema_path` — 指回本檔的指針
- `$ai_editable` — 給對方 Claude 的指示「這檔我可改」

---

## 改造範例

### 使用者抱怨「我有第四個 project，連結沒反應」
→ 在 `project_roots[]` 加上該 project 絕對路徑（正斜線）

### 使用者抱怨「我用 Cursor 不是 VSCode」
→ 改 `vscode_cli: "cursor"`

### 使用者抱怨「我想點 .blueprint 檔案也能開」
→ 在 `allowed_extensions[]` 加 `".blueprint"`

### 使用者要求「邀請的協作者也能點本機 VSCode」（不建議）
→ 改 `owner_only: false`，但**警告使用者安全風險**

---

## 風險提示

1. **`project_roots` 順序**：兩個 root 有同名檔，前面的會被選中 — 不是 bug 是設計，但要解釋清楚
2. **`vscode_cli` 路徑錯**：`exec` fail → server log 看 stderr，不會 crash but feature 失效
3. **`allowed_extensions` 拒副檔名後不能用 toast 暴露 — 一律走「無反應」防嗅探
4. **路徑必須正斜線**：Windows 上 `C:\\Project` JSON 內必須是 `"C:/Project"` 或 `"C:\\\\Project"`，否則 escape 出問題

---

## 與其他設定的關係

- 與 `auto_card_rules.json` 平行（都是 `~/.claude/tc_user_config/` 內的本機設定）
- 與 `tc_users.json` 配合（`owner_only` 判定依賴 owner role）
- 與 `requireOwner()` server helper 配合（server endpoint 第一行 gate）
