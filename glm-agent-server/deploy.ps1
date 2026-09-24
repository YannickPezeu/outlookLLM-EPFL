#!/usr/bin/env pwsh
# Déploie glm-agent-server sur k8s (expert-finder.epfl.ch/outlook/agent)
# Usage : ./glm-agent-server/deploy.ps1   (depuis la racine du repo ou n'importe où)
#
# Prérequis une fois :
#   kubectl create secret generic glm-agent-secrets -n epfl-chatbot --from-literal=RCP_API_KEY=sk-...
#   kubectl apply -f k8s/glm-agent.yaml

$ErrorActionPreference = "Stop"
$IMAGE = "ic-registry.epfl.ch/mr-pezeu/glm-agent-server:latest"
# Sidecar OpenHands (moteur d'agent par défaut), même pod
$IMAGE_OH = "ic-registry.epfl.ch/mr-pezeu/glm-agent-openhands:latest"
$NAMESPACE = "epfl-chatbot"
$DEPLOYMENT = "glm-agent"
# Cluster IC dédié (PAS le CaaS RCP) — celui qui héberge expert-finder.epfl.ch
$KUBE_CONTEXT = "ic-mr-expert-finder-k8s-fqdn"

# Racine du repo = parent du dossier de ce script
$REPO_ROOT = Split-Path -Parent $PSScriptRoot

# Un échec de commande native (docker, npm…) n'arrête PAS PowerShell malgré
# $ErrorActionPreference : chaque étape teste $LASTEXITCODE, sinon une image
# cassée partirait quand même en production.
function Assert-Ok([string]$what) {
  if ($LASTEXITCODE -ne 0) { throw "$what a échoué — déploiement interrompu" }
}

Write-Host "=== 1/6 Unit tests ===" -ForegroundColor Cyan
Push-Location "$REPO_ROOT/glm-agent-server"
try { npm test; Assert-Ok "npm test" } finally { Pop-Location }

Write-Host "=== 2/6 Building Docker images ===" -ForegroundColor Cyan
# L'ignore propre au Dockerfile (glm-agent-server/Dockerfile.dockerignore) n'est
# lu que par BuildKit — forcé ici pour ne pas dépendre de la config du poste.
$env:DOCKER_BUILDKIT = "1"
docker build -f "$REPO_ROOT/glm-agent-server/Dockerfile" -t $IMAGE $REPO_ROOT
Assert-Ok "docker build (serveur)"
docker build -t $IMAGE_OH "$REPO_ROOT/glm-agent-server/openhands-engine"
Assert-Ok "docker build (sidecar OpenHands)"

Write-Host "=== 3/6 Smoke tests against RCP (built images) ===" -ForegroundColor Cyan
& "$REPO_ROOT/glm-agent-server/smoke/run-smoke.ps1" -ServerImage $IMAGE -OpenHandsImage $IMAGE_OH

Write-Host "=== 4/6 Pushing images ===" -ForegroundColor Cyan
docker push $IMAGE
Assert-Ok "docker push (serveur)"
docker push $IMAGE_OH
Assert-Ok "docker push (sidecar OpenHands)"

Write-Host "=== 5/6 Applying manifests + restarting ===" -ForegroundColor Cyan
kubectl --context $KUBE_CONTEXT apply -f "$REPO_ROOT/k8s/glm-agent.yaml"
Assert-Ok "kubectl apply"
kubectl --context $KUBE_CONTEXT rollout restart deployment/$DEPLOYMENT -n $NAMESPACE
Assert-Ok "kubectl rollout restart"

Write-Host "=== 6/6 Waiting for rollout ===" -ForegroundColor Cyan
kubectl --context $KUBE_CONTEXT rollout status deployment/$DEPLOYMENT -n $NAMESPACE --timeout=180s
Assert-Ok "kubectl rollout status"

Write-Host "Done! Pod status:" -ForegroundColor Green
kubectl --context $KUBE_CONTEXT get pods -n $NAMESPACE -l app=$DEPLOYMENT
Write-Host "Health check:" -ForegroundColor Green
curl.exe -s https://expert-finder.epfl.ch/outlook/agent/health
