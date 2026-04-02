# EPFL Mail AI - Outlook Add-in

## Projet

Add-in Outlook pour le personnel dirigeant EPFL. Fournit un assistant IA conversationnel, la préparation automatique de réunions, le résumé d'emails et l'analyse des interactions — le tout via l'API LLM interne RCP EPFL.

Projet pilote validé par Bruce Colombet (VPO-DSI). Lecture seule, pas de backend, 100% client-side.

## Stack

- **Frontend** : React 18 + TypeScript, Fluent UI v9, webpack
- **Auth** : MSAL.js v3 avec Nested App Auth (NAA) + fallback SPA PKCE
- **Données** : Microsoft Graph API v1.0 (Mail.Read, Calendars.Read)
- **IA** : EPFL RCP API (OpenAI-compatible) — embeddings + chat completions, streaming SSE
- **Modèles** : Mistral Small 3.2 24B (assistant, résumés, reranking), Qwen 3 Embedding 8B (embeddings)
- **Extraction** : pdfjs-dist (PDF), mammoth (DOCX), DOMPurify (sanitization HTML)
- **Matching** : fastest-levenshtein (recherche floue de contacts)
- **Rendu** : marked (Markdown dans les réponses assistant)

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
npm install           # Installer les dépendances
npm run start         # Dev server HTTPS (https://localhost:3000)
npm run sideload      # Installe les certs dev + lance le serveur
npm run build         # Build production
npm run build:ghpages # Build pour GitHub Pages
npm run build:k8s     # Build pour déploiement Kubernetes
npm run lint          # Linting ESLint
```

## Architecture fichiers clés

```
manifest.xml                       # Manifeste Office add-in (sideload dans Outlook)
src/config.ts                      # Config centrale (clientId, tenantId, RCP API, modèles)
src/taskpane/App.tsx                # Composant racine, 5 onglets, init auth

src/services/authService.ts        # MSAL init (NAA + fallback), getGraphToken()
src/services/graphMailService.ts   # Client Graph API (emails, calendrier, contacts, dossiers)
src/services/rcpApiService.ts      # Client RCP LLM (chat completions, streaming, suggestFolder)
src/services/embeddingService.ts   # Embeddings + cosine similarity + reranking
src/services/meetingPrepService.ts # Pipeline complet de préparation de réunion
src/services/agentService.ts       # Boucle agent multi-tour avec tool calling
src/services/agentTools.ts         # Définitions et exécuteurs des outils agent
src/services/attachmentService.ts  # Extraction texte pièces jointes (PDF, DOCX, TXT, CSV, HTML)

src/components/AssistantView.tsx   # Interface chat assistant IA conversationnel
src/components/MeetingPrepView.tsx # UI préparation de réunion
src/components/SummarizeView.tsx   # Résumé du mail courant
src/components/InteractionsView.tsx # Résumé des interactions avec un contact
src/components/OrganizeView.tsx    # Organisation emails dans dossiers (suggestion IA)
src/components/SettingsView.tsx    # Config RCP API + statut auth
```

## Fonctionnalités (onglets de l'add-in)

### 1. Assistant (AssistantView)
Interface de chat conversationnel avec le LLM. L'agent utilise des outils (tool calling) pour :
- `search_contacts` — recherche de contacts avec matching flou (Levenshtein)
- `get_email_interactions` — liste des emails échangés avec un contact
- `summarize_email_interactions` — résumé IA des échanges avec un contact
- `get_calendar_events` — consultation du calendrier sur une plage de dates
- `search_emails` — recherche plein texte dans les emails
- `search_contacts_in_servicedesk` — recherche dans les tickets ServiceNow
- `show_emails` — affichage d'une liste d'emails cliquables dans le chat

La boucle agent (agentService.ts) gère max 8 itérations d'appels d'outils, avec streaming des réponses et callbacks de progression.

### 2. Réunion (MeetingPrepView)
Pipeline automatique de préparation de réunion :
1. Extraction contexte : Office.js + Graph API → sujet, participants, body
2. Collecte emails : Graph API → emails échangés avec chaque participant (max 200/participant)
3. Embedding + reranking : RCP embeddings → cosine similarity → top 50 → reranking LLM → top 20
4. Lecture complète : Graph API → body complet des top 20 emails
5. Synthèse LLM : résumé par participant (parallélisé) → méta-résumé final (streaming)

### 3. Résumé (SummarizeView)
Résumé du mail actuellement ouvert dans Outlook via le LLM.

### 4. Interactions (InteractionsView)
Résumé des échanges avec un contact spécifique.

### 5. Config (SettingsView)
Configuration de la clé API RCP et affichage du statut d'authentification.

### (Non intégré) Organisation (OrganizeView)
Suggestion IA de dossier de destination pour un email, avec vue arborescente des dossiers.

## Déploiement

- **Dev local** : `npm run sideload` → HTTPS localhost:3000
- **GitHub Pages** : `npm run build:ghpages` → déployé via GitHub Actions
- **Kubernetes** : `npm run build:k8s` → déployé sur expert-finder.epfl.ch avec proxy nginx CORS pour l'API RCP
- **Auto-détection proxy** : le code détecte automatiquement si on est sur `expert-finder.epfl.ch` et utilise le proxy CORS `/outlook/api/rcp` au lieu de l'URL directe

## Dev mode

Le code supporte un mode dev sans Entra : mettre un token Graph Explorer dans `localStorage.setItem("graph_dev_token", "...")` pour bypasser l'auth MSAL.

## Contraintes importantes

- **Lecture seule** : l'add-in ne modifie jamais les emails/calendrier (sauf déplacement dans dossiers via OrganizeView)
- **Pas de backend** : tout tourne dans le navigateur
- **Secrets** : le `.env` contient les credentials Entra et la clé RCP, il est dans `.gitignore`
- **Langue** : l'interface est en français, le code et les commentaires en français/anglais
- **PLAN.md** : contient le plan technique détaillé du pipeline de préparation de réunion
- **Sécurité** : sanitization XSS via DOMPurify sur tout contenu HTML rendu

## Contacts EPFL

- **Pablo Tanner** : Service Desk, premier contact pour le ticket
- **Pascal Bangerter** : Admin IT, gère l'App Registration Entra
- **Bruce Colombet** : Directeur adjoint VPO-DSI, a validé le projet
- **Martin Rajman** : Professeur LSIR, superviseur académique
- **Carlos Perez** : Chef service info faculté IC, accréditation admin IT
