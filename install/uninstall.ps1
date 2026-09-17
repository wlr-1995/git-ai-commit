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
