#!/usr/bin/env pwsh
# Test de fumée des deux images du serveur agent, contre RCP, AVANT le push.
# Appelé par deploy.ps1 ; lançable seul : ./glm-agent-server/smoke/run-smoke.ps1
#
# La clé RCP vient de $env:RCP_API_KEY, sinon de glm-agent-server/.env. Elle
# passe aux conteneurs par variable d'environnement, jamais en argument.
param(
  [string]$ServerImage = "ic-registry.epfl.ch/mr-pezeu/glm-agent-server:latest",
  [string]$OpenHandsImage = "ic-registry.epfl.ch/mr-pezeu/glm-agent-openhands:latest"
)
$ErrorActionPreference = "Stop"

if (-not $env:RCP_API_KEY) {
  $envFile = Join-Path (Split-Path -Parent $PSScriptRoot) ".env"
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match '^RCP_API_KEY=' } | Select-Object -First 1
    if ($line) { $env:RCP_API_KEY = ($line -replace '^RCP_API_KEY=', '').Trim() }
  }
}
if (-not $env:RCP_API_KEY) { throw "RCP_API_KEY introuvable (variable d'environnement ou glm-agent-server/.env)" }

$smoke = $PSScriptRoot

Write-Host "--- Sidecar OpenHands ---" -ForegroundColor DarkCyan
docker run --rm -e RCP_API_KEY -v "${smoke}:/smoke:ro" --entrypoint sh $OpenHandsImage -c `
  "python -m uvicorn --app-dir /app main:app --host 127.0.0.1 --port 8792 > /tmp/uvicorn.log 2>&1 & python /smoke/smoke_sidecar.py || { echo '--- journal du sidecar ---'; tail -30 /tmp/uvicorn.log; exit 1; }"
if ($LASTEXITCODE -ne 0) { throw "test de fumée du sidecar OpenHands en échec" }

Write-Host "--- Serveur Node ---" -ForegroundColor DarkCyan
docker run --rm -e RCP_API_KEY -v "${smoke}:/smoke:ro" --entrypoint sh $ServerImage -c `
  "npx tsx src/server.ts > /tmp/server.log 2>&1 & node /smoke/smoke_node.mjs || { echo '--- journal du serveur ---'; tail -30 /tmp/server.log; exit 1; }"
if ($LASTEXITCODE -ne 0) { throw "test de fumée du serveur Node en échec" }

Write-Host "Tests de fumée : OK" -ForegroundColor Green
