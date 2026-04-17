#!/usr/bin/env pwsh
# Deploy outlook-plugin to Kubernetes (expert-finder.epfl.ch)
# Usage: ./update.ps1

$ErrorActionPreference = "Stop"
$IMAGE = "ic-registry.epfl.ch/mr-pezeu/outlook-plugin:latest"
$NAMESPACE = "epfl-chatbot"
$DEPLOYMENT = "outlook-plugin"

# Load .env for build args
$env:ENTRA_CLIENT_ID = "7ecc1fc6-2d9b-4bf6-aed9-12a396c9039c"
$env:ENTRA_TENANT_ID = "f6c2556a-c4fb-4ab1-a2c7-9e220df11c43"

Write-Host "=== 1/4 Building Docker image ===" -ForegroundColor Cyan
docker build `
  --build-arg ENTRA_CLIENT_ID=$env:ENTRA_CLIENT_ID `
  --build-arg ENTRA_TENANT_ID=$env:ENTRA_TENANT_ID `
  -t $IMAGE .

Write-Host "=== 2/4 Pushing image ===" -ForegroundColor Cyan
docker push $IMAGE

Write-Host "=== 3/4 Restarting deployment ===" -ForegroundColor Cyan
kubectl rollout restart deployment/$DEPLOYMENT -n $NAMESPACE

Write-Host "=== 4/4 Waiting for rollout ===" -ForegroundColor Cyan
kubectl rollout status deployment/$DEPLOYMENT -n $NAMESPACE --timeout=120s

Write-Host "Done! Pod status:" -ForegroundColor Green
kubectl get pods -n $NAMESPACE -l app=$DEPLOYMENT
