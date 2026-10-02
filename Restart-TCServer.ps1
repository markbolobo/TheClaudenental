# Restart-TCServer.ps1 — 安全重啟 TC server（pm2 claudenental-server）
# pm2 restart 會連同子行程一起結束：TC 自己 spawn 的無頭聊天室（侍酒師開新聊天室、待定奪子任務、QA 喚醒）
# 正在跑的話會被砍斷在半路。本腳本先問 /api/claude/processes，有在跑的就等，逾時拒絕（除非 -Force）；
# 查詢失敗一律當成「可能有在跑」而拒絕（寧可不重啟，也不要砍斷別人的工作）。
# 用法：powershell -File Restart-TCServer.ps1 [-WaitSeconds 600] [-Force] [-DryRun]
param(
    [int]$WaitSeconds = 600,
    [switch]$Force,
    [switch]$DryRun
)

$Api = 'http://127.0.0.1:3001'

# 回傳正在跑的無頭聊天室 session id 陣列；查詢失敗回 $null
# ⚠️ Windows PowerShell 5.1：函式輸出單一物件會被攤平，單一 PSCustomObject 的 .Count 是空值 ⇒ 一律回字串陣列、呼叫端再包 @()
function Get-RunningHeadless {
    try {
        $r = Invoke-RestMethod -Uri "$Api/api/claude/processes" -TimeoutSec 5
        return , [string[]]@($r.processes | Where-Object { $_.status -eq 'running' } | ForEach-Object { [string]$_.sessionId })
    } catch {
        return $null
    }
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ($true) {
    $running = Get-RunningHeadless
    if ($null -eq $running) {
        if (-not $Force) { Write-Output '拒絕重啟：查不到無頭聊天室清單（server 沒回應或查詢失敗）；確認沒有工作在跑後加 -Force'; exit 4 }
        break
    }
    $running = @($running)
    if ($running.Length -eq 0 -or $Force) { break }
    if ((Get-Date) -ge $deadline) {
        Write-Output ("拒絕重啟：仍有 {0} 個無頭聊天室在跑（{1}）。等它們結束，或確認可中斷後加 -Force" -f $running.Length, ($running -join ', '))
        exit 2
    }
    Write-Output ("等待 {0} 個無頭聊天室結束：{1}" -f $running.Length, ($running -join ', '))
    Start-Sleep -Seconds 10
}

if ($DryRun) { Write-Output '（DryRun）判斷通過，現在重啟是安全的——未實際重啟'; exit 0 }

pm2 restart claudenental-server | Out-Null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $h = Invoke-RestMethod -Uri "$Api/health" -TimeoutSec 2
        if ($h.status -eq 'online') { Write-Output "TC server 已重啟（$i 秒）"; exit 0 }
    } catch { }
}
Write-Output 'TC server 重啟後 30 秒內沒有回應 /health'
exit 3
