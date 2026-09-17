$ErrorActionPreference = 'Stop'

$bases = @(
    'HKCU:\Software\Classes\Directory\shell\AIGitCommit\command',
    'HKCU:\Software\Classes\Directory\Background\shell\AIGitCommit\command'
)

$ok = $true
foreach ($key in $bases) {
    if (Test-Path $key) {
        $cmd = (Get-ItemProperty -Path $key).'(default)'
        Write-Host "OK   $key -> $cmd"
    } else {
        Write-Host "MISS $key"
        $ok = $false
    }
}
if (-not $ok) { exit 1 }
Write-Host '右键菜单注册校验通过'
