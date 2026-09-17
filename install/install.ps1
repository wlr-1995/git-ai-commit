param(
    [string]$Dir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\win-unpacked')
)

$ErrorActionPreference = 'Stop'

$exe = Join-Path $Dir 'git-ai-commit.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    throw "找不到 $exe。请先运行 npm run package，或用 -Dir 指向便携目录。"
}

$command = "`"$exe`" `"%V`""
$bases = @(
    'HKCU:\Software\Classes\Directory\shell\AIGitCommit',
    'HKCU:\Software\Classes\Directory\Background\shell\AIGitCommit'
)

foreach ($base in $bases) {
    New-Item -Path $base -Force | Out-Null
    Set-ItemProperty -Path $base -Name '(default)' -Value 'AI 提交'
    Set-ItemProperty -Path $base -Name 'Icon' -Value "`"$exe`""
    New-Item -Path "$base\command" -Force | Out-Null
    Set-ItemProperty -Path "$base\command" -Name '(default)' -Value $command
}

Write-Host '已安装右键菜单（免管理员，仅写入 HKCU）：'
Write-Host "  $command"
Write-Host 'Windows 11 中请在「显示更多选项」里查看。'
