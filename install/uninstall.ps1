$ErrorActionPreference = 'Stop'

$bases = @(
    'HKCU:\Software\Classes\Directory\shell\AIGitCommit',
    'HKCU:\Software\Classes\Directory\Background\shell\AIGitCommit'
)

foreach ($base in $bases) {
    if (Test-Path $base) {
        Remove-Item -Path $base -Recurse -Force
        Write-Host "已删除 $base"
    } else {
        Write-Host "未安装 $base"
    }
}

Write-Host '右键菜单已移除；便携目录（如 dist\win-unpacked）可直接删除。'
Write-Host '用户配置与主题保留在 %USERPROFILE%\.git_ai_commit\，如需彻底清理可手动删除该目录。'
