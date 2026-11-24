param([switch] $RefreshTemplate)

$ErrorActionPreference = 'Stop'
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(22|24)\.') {
    throw 'Instale o Node.js 22 ou 24 antes de executar este script.'
}

$project = Split-Path -Parent $PSScriptRoot
$local = Join-Path $project '.env.local'
$template = Join-Path $project '.env.example'
if (Test-Path -LiteralPath $local) {
    if ($RefreshTemplate) {
        $backup = Join-Path $project ('backups/' + (Get-Date -Format 'yyyyMMdd-HHmmssfff'))
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        Copy-Item -LiteralPath $local -Destination (Join-Path $backup '.env.local')
        Copy-Item -LiteralPath $template -Destination (Join-Path $backup '.env.example')
        Write-Host 'A cópia da configuração e o modelo atualizado estão na pasta backups.'
    }
    Write-Host '.env.local já existe e foi preservado.'
    return
}

function New-Secret([switch] $UrlSafe) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) }
    finally { $rng.Dispose() }
    $base64 = [Convert]::ToBase64String($bytes)
    if ($UrlSafe) { return $base64.TrimEnd('=').Replace('+', '-').Replace('/', '_') }
    return $base64
}

$text = Get-Content -Raw -LiteralPath $template
$text = $text -replace '(?m)^SESSION_SECRET=(?=\r?$)', ('SESSION_SECRET=' + (New-Secret -UrlSafe))
$text = $text -replace '(?m)^ENCRYPTION_KEY=(?=\r?$)', ('ENCRYPTION_KEY=' + (New-Secret))
$text = $text -replace '(?m)^WEBHOOK_SECRET=(?=\r?$)', ('WEBHOOK_SECRET=' + (New-Secret -UrlSafe))
[System.IO.File]::WriteAllText($local, $text, [System.Text.UTF8Encoding]::new($false))
Write-Host 'Preencha DATABASE_URL e ADMIN_PASSWORD em .env.local.'
