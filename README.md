# EPFL Mail AI - Outlook Add-in

Add-in Outlook pour la communaute EPFL permettant de resumer et organiser ses emails grace a l'API LLM interne RCP (compatible OpenWebUI/OpenAI).

## Features

- **Resume des interactions** : Entrez l'adresse email d'un contact pour obtenir un resume structure de tous vos echanges (envoyes + recus)
- **Resume du mail courant** : Resume IA en un clic de l'email actuellement ouvert
- **Organisation en dossiers** : Classement des emails avec suggestion IA de dossier, creation de dossiers, deplacement

## Architecture

```
100% Frontend (React + TypeScript)
    |
    +---> Office.js         (lire le mail ouvert dans Outlook)
    +---> MSAL.js / NAA     (authentification Azure AD, SSO)
    +---> Microsoft Graph    (recherche emails, dossiers, deplacement)
    +---> EPFL RCP API       (inference LLM, format OpenAI chat completions)
```

## Structure des fichiers

### Racine

| Fichier | Role |
|---|---|
| `manifest.xml` | Manifeste de l'add-in Outlook. Definit les permissions (`ReadWriteMailbox`), les points d'extension (boutons dans la barre Outlook en lecture et composition), les URLs source, et les icones. C'est le fichier que l'admin deploie dans le tenant Microsoft 365. |
| `package.json` | Dependances npm et scripts (`dev`, `build`, `build:ghpages`, `sideload`). |
| `webpack.config.js` | Configuration webpack : compile TypeScript + React, genere le HTML, copie le manifest et les assets. Gere le HTTPS local pour le dev (via `office-addin-dev-certs`) et le `publicPath` pour GitHub Pages. |
| `tsconfig.json` | Configuration TypeScript : cible ES2020, JSX React, mode strict. |
| `.gitignore` | Exclut `node_modules/`, `dist/`, `.env`, logs. |

### `src/config.ts`

Configuration centrale de l'application. Contient les placeholders pour :
- **Azure AD** : `clientId`, `tenantId`, `authority`, `redirectUri` (a remplir apres le meeting admin)
- **Microsoft Graph** : URL de base et scopes demandes (`User.Read`, `Mail.Read`, `Mail.ReadWrite`)
- **RCP API** : URL, cle API, modele par defaut, endpoint de completions
- **Defaults** : limites de pagination (nombre max d'emails a fetcher)

### `src/taskpane/` - Point d'entree

| Fichier | Role |
|---|---|
| `taskpane.html` | Page HTML minimale. Charge le SDK `office.js` depuis le CDN Microsoft et contient la `<div id="root">` pour React. |
| `index.tsx` | Point d'entree React. Attend que `Office.onReady()` soit resolu, puis monte l'app dans un `FluentProvider` (theme Fluent UI). |
| `App.tsx` | Composant racine. Initialise l'authentification MSAL au montage. Affiche 4 onglets (Interactions, Resume, Organiser, Config) via `TabList` Fluent UI. Gere l'etat d'auth et les erreurs globales. |

### `src/services/` - Logique metier

| Fichier | Role |
|---|---|
| `authService.ts` | **Authentification Microsoft.** Initialise MSAL.js en essayant d'abord le mode NAA (Nested App Auth, SSO transparent dans le nouveau Outlook) puis fallback sur MSAL SPA standard. Expose `getGraphToken()` qui acquiert silencieusement un token Graph API avec fallback popup interactif. Gere aussi `signOut()` et l'etat d'auth. |
| `graphMailService.ts` | **Client Microsoft Graph API.** Fournit toutes les operations sur la boite mail : `searchEmailsFromSender()` et `searchEmailsSentTo()` pour trouver les emails echanges avec un contact, `getAllInteractions()` qui combine les deux, `listFolders()` / `createFolder()` / `moveMessage()` pour l'organisation. Gere la pagination automatique via `@odata.nextLink`. |
| `rcpApiService.ts` | **Client API RCP (LLM).** Envoie des requetes au format OpenAI chat completions. Supporte le mode streaming SSE (`chatCompletionStream`) pour afficher le resume progressivement, et le mode classique (`chatCompletion`). Fournit 3 fonctions haut niveau : `summarizeEmail()`, `summarizeInteractions()`, `suggestFolder()`. Les settings (URL, cle, modele) sont persistes dans `localStorage` et editables depuis l'onglet Config. |

### `src/components/` - Vues UI

| Fichier | Role |
|---|---|
| `InteractionsView.tsx` | **Vue P0 (priorite haute).** Champ de saisie d'adresse email (pre-rempli depuis le sender du mail ouvert via Office.js). Au clic, fetche tous les emails envoyes et recus via Graph API, puis envoie le tout au RCP API pour un resume structure et streame. Affiche des badges avec le nombre d'emails trouves. |
| `SummarizeView.tsx` | **Vue P1.** Bouton "Resumer cet email". Lit le body du mail actuellement ouvert via `Office.context.mailbox.item.body.getAsync()`, l'envoie au RCP API, et affiche le resume en streaming. |
| `OrganizeView.tsx` | **Vue P2.** Affiche l'arbre des dossiers mail (via Graph API). Permet de creer un nouveau dossier, de deplacer le mail courant dans un dossier selectionne, et de demander une suggestion IA de classement (le LLM analyse le mail et propose un dossier existant ou nouveau). |
| `SettingsView.tsx` | **Vue Config.** Affiche le statut d'authentification Microsoft (connecte/deconnecte, mode NAA ou non, username). Formulaire pour configurer l'API RCP : URL, cle API, modele. Les valeurs sont sauvegardees dans `localStorage`. |

## Demarrage rapide

```bash
# Installer les dependances
npm install

# Dev avec HTTPS local (requis pour Office Add-ins)
npm run sideload

# Build pour GitHub Pages
npm run build:ghpages
```

## Permissions Azure AD requises

| Permission Graph | Type | Usage |
|---|---|---|
| `User.Read` | Delegated | Profil utilisateur connecte |
| `Mail.Read` | Delegated | Recherche et lecture des emails |
| `Mail.ReadWrite` | Delegated | Creation de dossiers, deplacement d'emails |

## Configuration

Apres avoir obtenu l'App Registration Azure AD :
1. Editer `src/config.ts` avec le `clientId` et `tenantId`
2. Configurer l'API RCP dans l'onglet Config de l'add-in (URL, cle API, modele)
