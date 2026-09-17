$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $projectRoot 'app\main.py'
if (-not (Test-Path -LiteralPath $entry)) {
    throw "找不到入口文件: $entry"
}

$python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
if (-not $python) { throw '找不到 python.exe，请先安装 Python 并加入 PATH' }
$pythonw = Join-Path (Split-Path -Parent $python) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonw)) { $pythonw = $python }

$command = "`"$pythonw`" `"$entry`" `"%V`""
$bases = @(
    'HKCU:\Software\Classes\Directory\shell\AIGitCommit',
    'HKCU:\Software\Classes\Directory\Background\shell\AIGitCommit'
)

foreach ($base in $bases) {
    New-Item -Path $base -Force | Out-Null
    Set-ItemProperty -Path $base -Name '(default)' -Value 'AI 提交'
    Set-ItemProperty -Path $base -Name 'Icon' -Value "`"$pythonw`""
    New-Item -Path "$base\command" -Force | Out-Null
    Set-ItemProperty -Path "$base\command" -Name '(default)' -Value $command
}

Write-Host "已安装右键菜单。命令: $command"
Write-Host "Windows 11 中请在「显示更多选项」里查看。"
