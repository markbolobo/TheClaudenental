# Contributing to TheClaudenental

> 給協助打磨 codebase 的開發者朋友。第一次來請先讀 [SETUP_FOR_DEV.md](SETUP_FOR_DEV.md) 把環境建好。

---

## Branch 命名

| 前綴 | 用途 | 範例 |
|---|---|---|
| `feat/` | 新功能 | `feat/long-press-radial-menu` |
| `fix/` | bug 修復 | `fix/thinking-not-expand` |
| `refactor/` | 重構（無功能變更） | `refactor/extract-card-drawer` |
| `perf/` | 效能 | `perf/messages-virtualization` |
| `docs/` | 文件 | `docs/setup-typo` |
| `chore/` | 雜事（依賴更新等） | `chore/upgrade-vite` |

---

## Commit Message 格式

```
<type>(<scope>): <subject>

<body — 為什麼這麼改、有什麼副作用>

<footer — 如有 BREAKING CHANGE 或 closes #123>
```

**type**：feat / fix / refactor / perf / docs / chore / revert
**scope**：todos / chat / server / client / bounty / etc（看主要動到哪塊）

範例：
```
fix(chat): thinking 點擊後不展開

從原生 <details> 改用 React state 控制展開
原因：某些瀏覽器環境下 <details> 點擊不 toggle

closes #42
```

---

## PR 規則

### 開 PR 前
- [ ] `git pull upstream main` 已同步上游
- [ ] 沒含 secret（API key / token / 密碼）— 用 TruffleHog 掃過
- [ ] commit message 符合上述格式
- [ ] 自己跑過確認沒壞既有功能

### PR 內容
- **Title**：用 commit message 的 subject 行
- **Description**：
  - 改了什麼 / 為什麼 / 怎麼測
  - 有副作用 / breaking change 必說明
  - 截圖（UI 改動）

### Review 流程
- Mark 會在 PR 留 comments
- 你修改 → 再 `git push origin <branch>`（PR 自動更新）
- Approve 後 Mark merge

---

## Code Style

### JavaScript / JSX
- 沒裝 prettier / eslint 強制（保持低門檻），但跟既有檔案風格一致：
  - 單引號 `'` 字串
  - 沒分號
  - 2 空格縮排
  - 函式宣告用 `function name() {}` 給 top-level，arrow function 給 callback / hook

### React
- Hooks 在元件最上面、useEffect cleanup 不能省
- Component 拆獨立 function，不要超過 ~200 行
- 跨 component state 走 prop / context，不要全域變數

### CSS
- Tailwind only（沒 styled-components 也沒 CSS module）
- 顏色用 CSS variables（看 `client/src/index.css` 定義）：
  - `var(--gold)` / `var(--gold-border)` 主色系
  - `var(--surface)` / `var(--surface-2)` 背景層級
  - `var(--text)` / `var(--text-muted)` 文字層級

---

## 設計哲學（影響 PR 方向）

### 三層分離鐵律
- **卡片** = 介面層（metadata + 短摘要 + topicMdPath）
- **話題 md** = 真正內容
- **knowledge / memory** = 永久元層

PR 不要違反這個。詳：上游的 memory `project_tc_design_alignment_audit.md`（不在這 repo，跟 Mark 對齊用）。

### 不對歷史內容自動真砍
- 卡片刪除 → 軟刪除（永遠保留），徹底刪走 `/api/todos/:id/purge`
- events log 不自動 retention
- chat messages state 完整保留，DOM 用 visibleCount 控制

### Progressive Disclosure
- 預設顯示「足夠的資訊」，細節按需展開
- 對應 Anthropic Agent Skills 的設計

---

## 測試

目前**沒裝 test framework**（alpha 階段）。手測就好：

1. server / client 都能起
2. 你改的功能能跑
3. 沒影響到 既有功能（特別是 Chat / TODO / 拖曳 / 沉澱）

未來 stable 後會加 vitest + playwright。

---

## 我有疑問 / 卡住

- 開 GitHub Issue
- 或私訊 Mark

歡迎你來打磨。
