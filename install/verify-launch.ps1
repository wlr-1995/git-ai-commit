param(
    [string]$Repo = (Get-Location).Path,
    [int]$TimeoutSeconds = 25
)

# 端到端校验「右键菜单真的能打开窗口」：读注册表里的 command，
# 把 %V 换成真实仓库路径，按 cmd 的解析方式执行，等窗口标题出现仓库名。
$ErrorActionPreference = 'Stop'

$key = 'HKCU:\Software\Classes\Directory\shell\AIGitCommit\command'
if (-not (Test-Path $key)) { throw "未安装右键菜单，请先运行 install\install.ps1" }

$command = (Get-ItemProperty -Path $key).'(default)'
$repo = (Resolve-Path -LiteralPath $Repo).Path
$line = $command.Replace('%V', $repo)
Write-Host "执行注册表命令: $line"

Get-Process -Name git-ai-commit -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 300

$inner = '"' + $command.Split('"')[1] + '" "' + $repo + '"'
Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', "`"$inner`"") -WindowStyle Hidden | Out-Null

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$name = Split-Path -Leaf $repo
$found = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
    $found = Get-Process -Name git-ai-commit -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -like "*$name*" } |
        Select-Object -First 1
    if ($found) { break }
}

if (-not $found) {
    Get-Process -Name git-ai-commit -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Host "FAIL 超时未出现窗口（期望标题含「$name」）"
    exit 1
}

Write-Host "OK 窗口已打开: $($found.MainWindowTitle)"
$found | Stop-Process -Force
Start-Sleep -Milliseconds 300
Write-Host '右键菜单启动链路校验通过'
