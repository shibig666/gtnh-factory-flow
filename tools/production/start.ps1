$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot '../../dist-server/server.mjs'
if (-not (Test-Path -LiteralPath $entry)) {
    Write-Error 'Missing production build. Run npm ci and npm run build:production first.'
    exit 1
}
& node $entry @args
exit $LASTEXITCODE
