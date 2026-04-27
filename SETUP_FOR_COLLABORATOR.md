# [DEPRECATED — 場景 B 接卡尚未完整實作] TheClaudenental 協作者環境設定指南

> ⚠️ **這份文件是給「場景 B：接收 Mark 分享的卡片」協作者用的，目前 alpha 不完整。**
>
> **如果你是要協助打磨 codebase 的開發者**，請看 [`SETUP_FOR_DEV.md`](SETUP_FOR_DEV.md) — 這份文件不適用。
>
> 場景 B 還缺：對方端如何用 invite link 連到 Mark 的 server、跨網路 sync 機制等。等 P3 / P4 階段才會完整。

如果你有 Claude Code，直接開啟這個資料夾讓 AI 自動引導，不需要手動看這份文件。
本文件適用於**沒有 AI 工具**、或需要手動排查問題的情況。

完成後你應該能：
- 在自己的電腦跑起 TheClaudenental 個人駕駛艙
- 收到 Mark（host 端）分享過來的卡片
- 在自己的 Claude Code 接手這些卡，推進階段 / 延伸新卡
- 你的 chat 內容、API key、規矩設定**永遠不會**被 host 端看到

---

## 整體流程一覽

```
Step 0  確認前置需求
Step 1  申請 Anthropic API key（你自己的）
Step 2  安裝 Node.js
Step 3  安裝 Git
Step 4  安裝 Claude Code
Step 5  Clone TheClaudenental 並啟動
Step 6  加入 Mark 的 Tailnet（接收分享卡片用）
Step 7  驗證能收到分享卡 / 自己的 dashboard 也能跑
```

每個 Step 都有「✅ 確認成功的方法」，請確認後再往下走。

---

## Step 0：確認前置需求

你需要：
- Windows 10 / 11（macOS / Linux 暫未驗證，你要試的話歡迎回報）
- 至少 8 GB RAM、5 GB 磁碟空間
- 穩定網路（會與 Anthropic API 持續通訊）

✅ 規格達標 → 繼續
❌ 不確定 → 回報給 Mark

---

## Step 1：申請 Anthropic API key（你自己的）

**重要**：你必須用自己的 API key，不是 Mark 的。原因：
- 帳單分流（你跑的成本你付）
- 安全隔離（萬一 key 外洩只影響你自己）
- 對話隱私（你的 chat 內容只你看得到）

步驟：
1. 進 [console.anthropic.com](https://console.anthropic.com)
2. 註冊 / 登入
3. 進入 **API Keys** → **Create Key**
4. 命名（例如 `theclaudenental-collaborator`）
5. 複製並**安全存放**（離開頁面就看不到了）

**強烈建議**（學自 2026-04 Google Cloud 18K 美元帳單事件）：
- 在 console 設 **monthly spend cap**（從 $20 起步，超過會自動停）
- 開啟 **email alert**（用量達 50% / 80% / 100% 通知）

✅ 你的 API key 已存在密碼管理器或安全筆記
❌ key 不見了 → 回 console 砍掉重做

---

## Step 2：安裝 Node.js

需要 **Node.js v24+**。

1. 進 [nodejs.org](https://nodejs.org)
2. 下載 **LTS 版本**（v24+）
3. Windows installer 一路 Next
4. 安裝完**重開** VS Code 或 terminal（PATH 才會生效）

✅ 開新 PowerShell，輸入 `node --version` 看到 `v24.x.x`
❌ 找不到 node 指令 → 重開 terminal / 重啟電腦再試

---

## Step 3：安裝 Git

1. 進 [git-scm.com](https://git-scm.com)
2. 下載 **Git for Windows**
3. installer 一路 Next（含 Git Bash）
4. 安裝完重開 terminal

✅ `git --version` 顯示 `git version 2.x.x`
❌ 找不到 → 重開 terminal

---

## Step 4：安裝 Claude Code

兩種方式擇一：

### 方式 A：VS Code 擴充（推薦）
1. 開 VS Code
2. 擴充市集搜尋 **Claude Code**（Anthropic 官方）
3. 安裝 → 重啟 VS Code
4. 第一次用會跳登入 → 用 Step 1 的 API key

### 方式 B：CLI
```powershell
npm install -g @anthropic-ai/claude-code
claude login   # 貼上 API key
```

✅ 在任何資料夾打開 Claude Code，能跟它對話
❌ 卡在登入 → 確認 API key 沒有多餘空格 / 換行

---

## Step 5：Clone TheClaudenental 並啟動

### 5-A：Clone
```powershell
cd C:\Project    # 或你習慣的工作目錄
git clone https://github.com/markbolobo/TheClaudenental.git
cd TheClaudenental
```

### 5-B：裝相依
```powershell
cd server
npm install
cd ..\client
npm install
cd ..
```

### 5-C：啟動
打開兩個 terminal：

**Terminal 1**（server，port 3001）：
```powershell
cd C:\Project\TheClaudenental\server
node index.js
# 看到 "Server listening on 3001" 就成功
```

**Terminal 2**（client，port 4444）：
```powershell
cd C:\Project\TheClaudenental\client
npm run dev
# 看到 "Local: http://localhost:4444" 就成功
```

### 5-D：開瀏覽器
```
http://localhost:4444
```

✅ 看到 TheClaudenental dashboard（黑底金字，THE CLAUDENENTAL）
❌ 連不上 → 確認 Step 5-C 兩個 terminal 都有正確輸出，沒有紅字錯誤

---

## Step 6：加入 Mark 的 Tailnet（接收分享卡片用）

> ⚠️ 此步只有在 Mark 真的要分享卡片給你時才需要。如果你只是想 self-host 玩 TheClaudenental，可跳過。

### 6-A：裝 Tailscale
1. 進 [tailscale.com/download](https://tailscale.com/download)
2. 下載 Windows 版 → 安裝
3. 用你的 email 登入（Google / Microsoft / GitHub OAuth 都可）

### 6-B：請 Mark 發 invite
請 Mark 在他的 Tailscale Admin Console：
- **Settings → Invite User** → 輸入你 Tailscale 帳號的 email
- 或 **Share node** → 把他的 TheClaudenental server node 分享給你

你會收到邀請 email → 接受。

### 6-C：驗證連線
```powershell
tailscale status
```
應該看到 Mark 的 node（IP `100.x.x.x`）

✅ 看得到 Mark 的 node
❌ 沒看到 → 等 Mark 確認 invite 已發 / 已接受

### 6-D：自己 dashboard vs Mark 的
你可以兩個都用：
- **自己的**（Step 5）：看自己的 chat / 規矩 / TODO 卡 — 個人駕駛艙
- **Mark 分享的卡**：會出現在你 dashboard 的「分享 inbox」（待 P2 階段 4 實作）

---

## Step 7：驗證能接卡 / 推進

> ⚠️ 此步要等 Mark 把 P2 階段 4（分享 UI）做完才能完整測試。在那之前你可以先用 Step 5 的個人版熟悉介面。

當分享機制上線後：
1. Mark 在他 dashboard 點某張卡 → 「分享給協作者」→ 選你
2. 你 dashboard 的「📥 收到的卡」會出現紅點通知
3. 點開卡 → 看完整脈絡（title / note / tag / 階段歷史）
4. 你決定接 → 點「接手」→ 卡進入你的「實作中」欄位
5. 你的 Claude Code 用該卡的 prompt 模板接手討論
6. 你做完 → 推進到「驗證中」→ Mark 那邊同步看到狀態變更
7. 你需要延伸新卡 → 點「延伸新卡」→ 自動帶 parent 連結

---

## 故障排除

### Q1: Step 5 啟動 server / client 失敗
- 確認 Node.js 是 v24+：`node --version`
- 刪掉 `node_modules` 重新 `npm install`
- 看終端錯誤訊息回報 Mark

### Q2: 連 localhost:4444 是空白頁
- 開 DevTools (F12) 看 Console 紅色錯誤
- 看終端 client 是否有錯誤輸出

### Q3: Tailscale 連不到 Mark 的 node
- 雙方都要在線 + 都有打開 Tailscale
- 試 `tailscale ping mark-的-node-name`
- 直連 vs 中轉狀態：`tailscale status`（看是 direct 還 relay）

### Q4: API key 用量爆了
- 立刻去 console.anthropic.com 把該 key revoke
- 重新建一個新的，並設更嚴格的 spend cap
- 詳閱 `.agent/knowledge/Report_GoogleCloud_API_Key_Bill_Disaster.md`（如果你有 clone Roman 專案）

---

## 安全注意事項（必讀）

1. **你的 API key 永遠不該離開你的電腦**
   - 不要 commit 到 git
   - 不要貼到 Slack / Discord / 任何地方
   - 建議裝 [TruffleHog](https://github.com/trufflesecurity/trufflehog) 掃 git 防止誤 commit

2. **共享卡片內容要謹慎**
   - 卡片 note 可能含路徑、API 名、私有 repo 名
   - Mark 會在 P2 階段 5 加自動 secret pattern 警告，但**最終你才知道什麼能分享**

3. **跨 Tailnet 風險**
   - Tailscale = zero-trust mesh，前提你 Tailnet 內無惡意設備
   - 不要把 Tailnet 共享給陌生人

---

## 你已經完成的協作環境

```
✅ 自己的 Anthropic API key（spend cap 已設）
✅ Node.js v24+
✅ Git
✅ Claude Code
✅ TheClaudenental clone + 跑起來
✅ Tailscale 加入 Mark 的 Tailnet
□  分享卡接手流程（等 P2 階段 4 上線）
```

歡迎加入。有任何卡關直接回報 Mark，他會回覆並把問題寫進這份文件的故障排除區。
