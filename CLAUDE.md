# EPFL Mail AI - Outlook Add-in

## Projet

Add-in Outlook pour la préparation automatique de réunions du personnel dirigeant EPFL. Analyse les emails échangés avec les participants d'une réunion et génère un briefing structuré via l'API LLM interne RCP EPFL.

Projet pilote validé par Bruce Colombet (VPO-DSI). Lecture seule, pas de backend, 100% client-side.

## Stack

- **Frontend** : React 18 + TypeScript, Fluent UI v9, webpack
- **Auth** : MSAL.js v3 avec Nested App Auth (NAA) + fallback SPA PKCE
- **Données** : Microsoft Graph API v1.0 (Mail.Read, Calendars.Read)
- **IA** : EPFL RCP API (OpenAI-compatible) — embeddings + chat completions, streaming SSE
- **Modèles** : Mistral Small 24B (résumés simples, reranking), Qwen 3.5 (synthèses complexes)

## Entra ID (Azure AD) App Registration

- **Client ID** : `7ecc1fc6-2d9b-4bf6-aed9-12a396c9039c`
- **Tenant ID** : `f6c2556a-c4fb-4ab1-a2c7-9e220df11c43`
- **Type** : SPA (Single Page Application), flux PKCE
- **Redirect URIs** (type SPA) :
  - `brk-multihub://localhost:3000` (NAA broker Office)
  - `https://localhost:3000/taskpane.html` (fallback dev)
- **Permissions déléguées** : `User.Read`, `Mail.Read`, `Calendars.Read`
- **Admin** : Pascal Bangerter gère l'App Registration côté EPFL (ticket ServiceNow INC0780933)

## Commandes

```bash
npm install          # Installer les dépendances
npm run start        # Dev server HTTPS (https://localhost:3000)
npm run sideload     # Installe les certs dev + lance le serveur
npm run build        # Build production
npm run build:ghpages # Build pour GitHub Pages
```

## Architecture fichiers clés

```
manifest.xml                    # Manifeste Office add-in (sideload dans Outlook)
src/config.ts                   # Config centrale (clientId, tenantId, RCP API)
src/taskpane/App.tsx             # Composant racine, onglets, init auth
src/services/authService.ts      # MSAL init (NAA + fallback), getGraphToken()
src/services/graphMailService.ts # Client Graph API (emails, calendrier, pagination)
src/services/rcpApiService.ts    # Client RCP LLM (chat completions, streaming)
src/services/embeddingService.ts # Embeddings + cosine similarity + reranking
src/services/meetingPrepService.ts # Pipeline complet de préparation de réunion
src/components/MeetingPrepView.tsx # UI préparation de réunion
src/components/InteractionsView.tsx # Résumé des interactions avec un contact
src/components/SummarizeView.tsx   # Résumé du mail courant
src/components/SettingsView.tsx    # Config RCP API + statut auth
```

## Pipeline de préparation de réunion

1. **Extraction contexte** : Office.js + Graph API → sujet, participants, body
2. **Collecte emails** : Graph API → emails échangés avec chaque participant (max 200/participant)
3. **Embedding + reranking** : RCP embeddings → cosine similarity → top 50 → reranking LLM → top 20
4. **Lecture complète** : Graph API → body complet des top 20 emails
5. **Synthèse LLM** : résumé par participant (parallélisé) → méta-résumé final (streaming)

## Dev mode

Le code supporte un mode dev sans Entra : mettre un token Graph Explorer dans `localStorage.setItem("graph_dev_token", "...")` pour bypasser l'auth MSAL.

## Contraintes importantes

- **Lecture seule** : l'add-in ne modifie jamais les emails/calendrier
- **Pas de backend** : tout tourne dans le navigateur
- **Secrets** : le `.env` contient les credentials Entra et la clé RCP, il est dans `.gitignore`
- **Langue** : l'interface est en français, le code et les commentaires en français/anglais
- **PLAN.md** : contient le plan technique détaillé du pipeline de préparation de réunion

## Contacts EPFL

- **Pablo Tanner** : Service Desk, premier contact pour le ticket
- **Pascal Bangerter** : Admin IT, gère l'App Registration Entra
- **Bruce Colombet** : Directeur adjoint VPO-DSI, a validé le projet
- **Martin Rajman** : Professeur LSIR, superviseur académique
- **Carlos Perez** : Chef service info faculté IC, accréditation admin IT
