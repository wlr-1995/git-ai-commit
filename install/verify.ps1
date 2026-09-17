$ErrorActionPreference = 'Stop'

$keys = @(
    'HKCU:\Software\Classes\Directory\shell\AIGitCommit\command',
    'HKCU:\Software\Classes\Directory\Background\shell\AIGitCommit\command'
)

$ok = $true
foreach ($key in $keys) {
    if (-not (Test-Path $key)) {
        Write-Host "MISS $key"
        $ok = $false
        continue
    }
    $cmd = (Get-ItemProperty -Path $key).'(default)'
    $exe = ($cmd -split '"')[1]
    if ($exe -and (Test-Path -LiteralPath $exe)) {
        Write-Host "OK   $key -> $cmd"
    } else {
        Write-Host "BAD  $key -> $cmd（exe 不存在）"
        $ok = $false
    }
}
if (-not $ok) { exit 1 }
Write-Host '右键菜单注册校验通过'
