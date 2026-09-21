param(
    [string]$Dir
)

$ErrorActionPreference = 'Stop'

if (-not $Dir) {
    # 交付目录（本脚本与 exe 同级，拷到别的电脑就是这样）优先；否则按仓库布局找
    $Dir = @(
        $PSScriptRoot,
        (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\win-unpacked')
    ) | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'git-ai-commit.exe') } | Select-Object -First 1
}

if (-not $Dir) {
    throw '找不到 git-ai-commit.exe。请把本脚本放在便携目录（含 exe 的那一层）里，或用 -Dir 指向它。'
}

$exe = Join-Path $Dir 'git-ai-commit.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    throw "找不到 $exe。请先运行 npm run package，或用 -Dir 指向便携目录。"
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host '警告：PATH 里没有 git，程序本身能开但清单/提交都会失败。'
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
