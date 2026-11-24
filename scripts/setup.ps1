param([switch] $RefreshTemplate)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$local = Join-Path $project '.env.local'
$template = Join-Path $project '.env.example'
if ((Test-Path -LiteralPath $local) -and -not $RefreshTemplate) {
    Write-Host '.env.local já existe e foi preservado.'
    exit
}
if (Test-Path -LiteralPath $local) {
    $backup = Join-Path $project ('backups/' + (Get-Date -Format 'yyyyMMdd-HHmmssfff'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Copy-Item -LiteralPath $local -Destination (Join-Path $backup '.env.local')
    Write-Host 'Backup protegido pela configuração local do projeto, na pasta backups.'
}
$node = 'const c=require("node:crypto");console.log(c.randomBytes(32).toString("base64url"));console.log(c.randomBytes(32).toString("base64"));console.log(c.randomBytes(32).toString("base64url"));'
$secrets = & node -e $node
if ($LASTEXITCODE -ne 0 -or $secrets.Count -ne 3) { throw 'Não foi possível gerar os segredos.' }
$text = Get-Content -Raw -LiteralPath $template
$text = $text -replace '(?m)^SESSION_SECRET=\r?$', ('SESSION_SECRET=' + $secrets[0])
$text = $text -replace '(?m)^ENCRYPTION_KEY=\r?$', ('ENCRYPTION_KEY=' + $secrets[1])
$text = $text -replace '(?m)^WEBHOOK_SECRET=\r?$', ('WEBHOOK_SECRET=' + $secrets[2])
[System.IO.File]::WriteAllText($local, $text, [System.Text.UTF8Encoding]::new($false))
Write-Host 'Preencha DATABASE_URL e ADMIN_PASSWORD em .env.local.'
