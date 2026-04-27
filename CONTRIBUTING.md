# Contributing to TheClaudenental

> 給協助打磨 codebase 的開發者朋友。第一次來請先讀 [SETUP_FOR_DEV.md](SETUP_FOR_DEV.md) 把環境建好。

---

## ⚠️ 兩個鐵律（給協作者 + 給對方 Claude Code 看）

**這兩條是 Mark 的工作習慣，希望整個產品的協作者都對齊。對方的 Claude Code 在這個 repo 工作時，請主動套用以下兩條，不需 Mark 重提。**

### 鐵律 1：AI 加工清潔原則

TheClaudenental 是個人 AI 駕駛艙產品，**整個產品由 Mark + 協作者各自的 Claude Code 加工**。
AI 加工會累積大量過程知識（debug log、嘗試方案、設計討論、skills、memory），
**這些不該進產品 repo，產品保持乾淨**。

#### 給協作者 Claude Code 的明確指引

當你（協作者的 AI）在這個 repo 工作時：

1. **過程文件不入 repo**
   - 你建立的 `.agent/skills/*`、`.claude/*` 是你自己的私有知識，不 commit
   - debug log、scratch md、嘗試方案的紀錄 → 寫在 `~/.claude/` 或 repo 外
   - 已被 `.gitignore` 排除（`.agent/` `.claude/` `scratch/` `WIP-*.md` 等）

2. **只有精煉過的進 repo**
   - ✅ 最終 code 改動
   - ✅ 對 PR 必要的 spec / design doc（在 `docs/`）
   - ❌ 你的思考過程、失敗嘗試、私有 AI memory
   - 「給 Mark 看的 PR description」≠「我的 AI 過程紀錄」

3. **精煉的標準**
   - 「未來 6 個月後讀這個 repo 的人」需要這份檔嗎？
     - 需要 → 精煉、納入 `docs/`
     - 不需要 → 留在你 home 的 `~/.claude/`
   - 「失敗的嘗試」可寫進 commit message body，不單獨檔

4. **PR 前自查**
   ```powershell
   # 確認沒誤 commit AI 累積目錄
   git diff main..HEAD --stat | Select-String -Pattern "\.agent/|\.claude/|scratch/|\.tmp\.md|WIP-"
   # 應該回空（沒命中）
   ```

5. **`.gitignore` 維護**
   - 你建了新的 AI 私有目錄？請**新增**進 `.gitignore`，**不要移除**現有條目

---

### 鐵律 2：階段性備份紀律

**每完成一個 phase 立刻 commit + push 一次**，不堆積、不批次。

#### 給協作者 Claude Code 的明確指引

當你（協作者的 AI）在這個 repo 工作時：

1. **每個 phase 一個 commit**
   - 大工程拆 phase 後，每完成一個 phase（功能可獨立 ship）→ 立刻 commit + push
   - 不要多 phase 累積到一個大 commit
   - commit message 聚焦單一 phase

2. **不需 Mark 重提，主動執行**
   - Mark 已內化「commit + push 是必備紀律」
   - 你不要等 Mark 提醒
   - 完成 phase → 自動執行：
     ```powershell
     git add <relevant files>
     git commit -m "feat(scope): phase X — what changed"
     git push origin <branch>
     ```

3. **階段定義（什麼算一個 phase）**
   - 一個獨立、可驗證的功能單位（例：「加 LongPressZoom 元件」「修 thinking 點不開」）
   - 不要太小（每改 1 行 commit）也不要太大（一次 7 個功能 2150 行 → 反例）
   - 大略 50-300 行改動 = 一個合理 phase

4. **commit 前自查**（同鐵律 1 的 PR 前自查）
   - 沒含 secret
   - 沒含 AI 過程文件
   - commit message 符合本文件「Commit Message 格式」段

5. **階段成果報告給 Mark**
   - 完成一個 phase → 在對話中告訴 Mark：「✅ phase X done, pushed as commit XXXX」
   - 累積 3-5 個 phase 後可以開 PR 給 Mark review

---

### 鐵律 3：Bug 報告先問「上次正常是什麼時候」

**功能壞了不要憑空猜根因，先用 git history 找版本差異。**

這是 Mark 的除錯習慣，已在自家 repo 多次用到（例：thinking 5 天前正常 vs 現在不正常 → git diff 找出 cap 1000 + slice(-500) 是元兇）。

#### 給協作者 Claude Code 的明確指引

當開發者（Mark 或其他協作者）報「某功能壞了」時：

1. **先問時間點**
   - 「你印象中這個功能上次正常是什麼時候？」
   - 「3 天前 / 1 週前 / 上個 commit 還是好的」這類資訊極重要
   - 不要直接猜根因 + 改 code

2. **用 git history 縮範圍**
   ```powershell
   # 看該檔案在那個時間點的版本
   git log --since="7 days ago" --until="3 days ago" --oneline -- <file>
   git show <commit>:<file>     # 看舊版本內容
   git diff <commit> HEAD -- <file>   # 跟現在比

   # 或關鍵字搜 commit
   git log --oneline --grep="thinking\|cap\|slice"

   # 找誰改了某行
   git blame -L <line>,<line> <file>
   ```

3. **bisect 大絕招**（功能壞、不知道哪個 commit 引入時）
   ```powershell
   git bisect start
   git bisect bad HEAD                    # 現在壞的
   git bisect good <一個你確定好的 commit>  # 例：1 週前的
   # git 自動 checkout 中間 commit，跑測試判斷 good/bad，逐步逼近元兇
   ```

4. **找到元兇 commit 後**
   - 不要直接 revert 整個 commit（可能含其他正確改動）
   - 用 `git show <commit>` 看該 commit 改了什麼
   - 精準把「壞的那行 / 那段邏輯」修掉，保留其他改動

5. **修完後 PR description 寫清楚**
   - 「報修：某功能壞了」
   - 「上次正常：commit XXXX（YYYY-MM-DD）」
   - 「元兇：commit YYYY 的 ABC 改動」
   - 「修法：精準改 ABC 那段，保留 commit YYYY 其他部分」

#### 為什麼這條重要

直接憑印象修 bug 容易：
- 改錯地方（症狀不在那）
- 引入新問題（沒看清原本邏輯）
- 漏掉真正元兇（同樣 bug 換地方再現）

git history 是真實紀錄，**比 AI 記憶 + 人類印象都可靠**。

---

### 鐵律 4：Git history 是「成功根基 + 錯誤依據」，不可刪改

**任何已 push 的 commit 不可被改寫、刪除、覆蓋。** Git history 是 Mark 的長期資產。

#### 給協作者 Claude Code 的明確指引

#### ❌ 禁止操作（已 push 的 commit）
```powershell
# 全部禁止
git rebase -i <已 push 的 commit>           # 改寫 history
git commit --amend                          # amend 已 push 的 commit
git push --force                            # 覆蓋遠端 history
git push --force-with-lease                 # 同上
git filter-branch / git filter-repo         # 重寫整段 history
git reset --hard <舊 commit> + git push     # 倒退並覆蓋
git branch -D main                          # 刪 main 分支
git push origin :main                       # 刪遠端 main
```

#### ✅ 允許（自己未 push 的 local 分支）
```powershell
# 本地 feature branch 還沒 push 前可以隨意整理
git rebase -i HEAD~3        # 整理本地 commit
git commit --amend          # amend 本地最後一個未 push commit
```

#### 補錯的正確做法
- **修錯了 push 的 commit** → 開新 commit 修（`git revert <commit>` 或精準改 code 開新 commit）
- **commit message 寫錯** → 接受、下次寫好
- **不小心 commit 了 secret** → revoke secret + 新 commit 移除（不要試圖 rewrite history，太晚了）
- **想清掉某個 PR 的 commits** → 開新 PR 來 revert，不是 rebase 主分支

#### 為什麼這條最神聖

1. **Mark 用 git history 檢視錯誤** — 第三條鐵律就靠 git history
2. **協作者依靠穩定 history** — 你改了 history，所有人本地都壞掉
3. **過去成功的紀錄不該被偽造** — 失敗的嘗試也是學習材料，留著
4. **Git push --force 是 indie 開發者最常踩的災難** — 一覆蓋無法復原

如果你（協作者 Claude）真的覺得需要改 history：**先問 Mark**。

---

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
