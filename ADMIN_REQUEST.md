# Demande de configuration Azure AD - EPFL Mail AI

**Date :** Mars 2026
**Demandeur :** Yannick Sidney Pezeu - Ingenieur ML, EPFL
**Projet :** Add-in Outlook pour la communaute EPFL - Preparation de reunions par IA

---

## 1. Contexte

Nous developpons un add-in Outlook pour la communaute EPFL qui permet de :
- **Resumer un email** en un clic via l'API LLM interne RCP
- **Preparer une reunion** : a partir d'un evenement calendrier, l'IA analyse les participants, recherche les emails echanges avec eux et sur le sujet de la reunion, puis genere un briefing complet pour preparer l'utilisateur

L'add-in fonctionne **100% cote client** (Single Page Application dans le task pane Outlook). Il n'y a pas de serveur backend. L'authentification utilise MSAL.js avec le flux Authorization Code + PKCE.

Le resume d'un seul email fonctionne deja (demo disponible). Pour la preparation de reunions, nous avons besoin d'acceder a Microsoft Graph API pour lire les evenements calendrier et rechercher les emails, ce qui necessite une App Registration dans le tenant EPFL.

**Note :** L'add-in est en **lecture seule**. Il ne modifie, ne deplace et ne supprime aucun email ni evenement. Il n'envoie aucun email.

---

## 2. App Registration demandee

| Parametre | Valeur |
|---|---|
| **Nom** | `EPFL Mail AI` |
| **Type de comptes** | Comptes dans cet annuaire d'organisation uniquement (EPFL - single tenant) |
| **Plateforme** | Single Page Application (SPA) |
| **Secret client** | Aucun (client public, authentification PKCE) |
| **Redirect URIs** | `https://localhost:3000/taskpane.html` (dev), URL de production a definir |

---

## 3. Permissions Microsoft Graph demandees

Toutes les permissions sont **deleguees** (Delegated) et **en lecture seule**. L'application agit toujours **au nom de l'utilisateur connecte** et ne peut acceder qu'a ses propres donnees.

| Permission | Type | Raison | Admin consent requis par defaut ? |
|---|---|---|---|
| `User.Read` | Delegated | Lire le profil de l'utilisateur connecte (nom, email). Necessaire au fonctionnement de MSAL. | Non |
| `Mail.Read` | Delegated | Rechercher et lire les emails dans la boite de l'utilisateur. Necessaire pour retrouver les echanges avec les participants d'une reunion et les emails lies au sujet. | Non |
| `Calendars.Read` | Delegated | Lire les evenements du calendrier de l'utilisateur. Necessaire pour extraire les participants, le sujet et les details d'une reunion a preparer. | Non |

### Pourquoi ces permissions sont suffisantes et securisees

- **Lecture seule** : aucune permission Write. L'add-in ne peut pas modifier, deplacer ou supprimer des emails ou des evenements.
- **Deleguees, pas applicatives** : l'add-in ne peut jamais acceder aux donnees d'un autre utilisateur. C'est le meme niveau d'acces qu'Outlook lui-meme.
- **Pas de Mail.Send** : l'add-in ne peut pas envoyer d'emails.
- **Pas de permissions applicatives** : aucun acces hors contexte utilisateur.
- **Pas de secret serveur** : rien n'est stocke cote backend (il n'y en a pas).

---

## 4. Admin Consent

Si le tenant EPFL a une politique qui bloque le consentement utilisateur (parametre "User consent settings" dans Entra ID > Enterprise Applications), nous demandons un **admin consent tenant-wide** pour les 3 permissions ci-dessus.

Sans admin consent, chaque utilisateur verra un message "Admin approval required" et ne pourra pas utiliser l'add-in.

**Ou verifier :** Entra ID > Enterprise Applications > Consent and permissions > User consent settings

---

## 5. Deploiement

### Phase de developpement (maintenant)
- **Sideloading** : le developpeur charge le manifest.xml manuellement dans Outlook. Deja fonctionnel.

### Phase de production (apres validation)
- **Centralized Deployment** via le Microsoft 365 Admin Center : l'admin deploie l'add-in pour tout le tenant EPFL ou pour des groupes specifiques.
- L'add-in sera heberge sur un serveur HTTPS (GitHub Pages ou infra EPFL).

---

## 6. Flux de donnees

```
Utilisateur ouvre un evenement calendrier dans Outlook
        |
        v
Add-in (task pane, SPA React)
        |
        +---> Office.js : lit le contenu du mail/evenement ouvert (local, pas de reseau)
        |
        +---> MSAL.js : obtient un token d'acces aupres d'Entra ID (SSO)
        |         |
        |         v
        |     Microsoft Graph API (LECTURE SEULE) :
        |     - GET /me/events/{id} : details de la reunion (participants, sujet)
        |     - GET /me/messages?$search=... : recherche d'emails lies
        |     (https://graph.microsoft.com/v1.0/me/...)
        |
        +---> API RCP EPFL : envoi du contexte collecte pour analyse et resume par LLM
              (https://inference.rcp.epfl.ch/v1 - API interne EPFL)
```

**Aucune donnee ne transite par un serveur intermediaire.** Tout est direct : navigateur → Graph API et navigateur → RCP API.

---

## 7. Actions demandees a l'administrateur

### 7.1 Creer l'App Registration

**Quoi :** Enregistrer une nouvelle application dans Entra ID (Azure AD) pour le tenant EPFL.

**Ou :** Portail Azure > Entra ID > App registrations > New registration

**Details :**
- Nom : `EPFL Mail AI`
- Type de comptes : "Accounts in this organizational directory only (EPFL)" → single tenant
- Pas de secret client (c'est une app publique)

**Resultat attendu :** Un `Application (client) ID` (format UUID) que je devrai integrer dans le code de l'add-in. C'est l'identifiant unique de l'app dans le tenant.

**Alternative :** Si l'admin prefere, il peut me donner les droits "Application Developer" dans Entra ID pour que je cree l'App Registration moi-meme.

- [ ] **A faire**

---

### 7.2 Configurer la plateforme SPA avec les redirect URIs

**Quoi :** Declarer que cette app est une Single Page Application (SPA) et configurer les URLs de redirection autorisees apres authentification.

**Ou :** App registration > EPFL Mail AI > Authentication > Add a platform > Single-page application

**Details :**
- Choisir **"Single-page application"** (pas "Web" ni "Mobile/Desktop"). Cela active le flux PKCE, qui est securise sans secret serveur.
- Redirect URIs a ajouter :
  - `https://localhost:3000/taskpane.html` (pour le developpement)
  - L'URL de production (a definir, ex: `https://epfl-mail-ai.github.io/taskpane.html`)

**Pourquoi SPA ?** Notre add-in est 100% frontend (React dans le task pane Outlook). L'authentification se fait entierement dans le navigateur via MSAL.js. Le mode SPA utilise le flux Authorization Code + PKCE : pas de secret cote client, la securite repose sur un challenge cryptographique ephemere genere a chaque connexion.

- [ ] **A faire**

---

### 7.3 Ajouter les permissions Graph deleguees

**Quoi :** Declarer les permissions Microsoft Graph que l'application a le droit de demander. Ces permissions sont attachees a cette App Registration uniquement — elles n'affectent aucune autre application du tenant.

**Ou :** App registration > EPFL Mail AI > API permissions > Add a permission > Microsoft Graph > Delegated permissions

**Permissions a ajouter :**

| Permission | A quoi elle sert concretement |
|---|---|
| `User.Read` | Lire le nom et l'email de l'utilisateur connecte. Necessaire pour que MSAL puisse identifier l'utilisateur. |
| `Mail.Read` | Rechercher et lire les emails de l'utilisateur. Permet de retrouver les echanges avec les participants d'une reunion. |
| `Calendars.Read` | Lire les evenements calendrier. Permet d'extraire les participants et le sujet d'une reunion a preparer. |

**Important :** Ce sont des permissions **deleguees** (Delegated) et **en lecture seule**, pas applicatives (Application). L'add-in agit **au nom de l'utilisateur connecte** et ne peut acceder qu'a **ses propres donnees**. Il ne peut rien modifier ni supprimer.

- [ ] **A faire**

---

### 7.4 Accorder l'admin consent tenant-wide

**Quoi :** Pre-autoriser les 3 permissions ci-dessus pour tous les utilisateurs du tenant EPFL, afin qu'ils n'aient pas a consentir individuellement (ou qu'ils ne soient pas bloques si le consentement utilisateur est desactive).

**Ou :** App registration > EPFL Mail AI > API permissions > cliquer "Grant admin consent for EPFL"

**Pourquoi c'est peut-etre necessaire :** Beaucoup de tenants universitaires desactivent le consentement utilisateur (parametre dans Entra ID > Enterprise Applications > Consent and permissions > "Do not allow user consent"). Dans ce cas, sans admin consent, chaque utilisateur verra le message "Admin approval required" et ne pourra pas utiliser l'add-in.

**Comment verifier la politique actuelle :** Entra ID > Enterprise Applications > Consent and permissions > User consent settings. Si c'est sur "Do not allow user consent", l'admin consent est obligatoire.

**Ce que ca fait concretement :** Un bouton "Grant admin consent for EPFL" dans la page API permissions. Une fois clique, tous les utilisateurs EPFL pourront utiliser l'add-in sans popup de consentement. Cela ne s'applique qu'a **cette app** (EPFL Mail AI), pas aux autres.

- [ ] **A faire (si la politique du tenant le requiert)**

---

### 7.5 Confirmer que le sideloading reste autorise

**Quoi :** Le sideloading permet aux developpeurs de charger un add-in Outlook depuis un fichier manifest.xml sans passer par le Store Microsoft ou le Centralized Deployment.

**Ou :** Microsoft 365 Admin Center > Settings > Org settings > User owned apps and services

**Pourquoi :** Pendant la phase de developpement, j'ai besoin de pouvoir tester l'add-in en le chargeant manuellement dans Outlook. Le sideloading est deja fonctionnel (teste le 11 mars 2026), mais je souhaite confirmer que cette fonctionnalite restera disponible.

**Note :** Le sideloading ne concerne que le developpeur. Les utilisateurs finaux recevront l'add-in via le Centralized Deployment (etape 7.6).

- [x] **Confirme** — sideloading teste et fonctionnel le 11 mars 2026 sur outlook.cloud.microsoft

---

### 7.6 Planifier le Centralized Deployment pour la mise en production

**Quoi :** Deployer l'add-in pour tous les utilisateurs EPFL (ou un groupe specifique) directement depuis le Microsoft 365 Admin Center. Les utilisateurs verront automatiquement "EPFL Mail AI" dans leur Outlook sans rien installer.

**Ou :** Microsoft 365 Admin Center > Settings > Integrated apps > Upload custom app

**Details :**
- L'admin uploade le fichier `manifest.xml` (ou fournit l'URL du manifest heberge)
- Il choisit les utilisateurs cibles : tout le tenant, un groupe de securite, ou des utilisateurs specifiques
- L'add-in apparait ensuite automatiquement dans le ruban Outlook de ces utilisateurs

**Prerequis :** L'add-in doit etre heberge sur un serveur HTTPS accessible (GitHub Pages ou infra EPFL). Le manifest doit pointer vers cette URL de production et non vers localhost.

**Timeline suggeree :** Apres validation de la phase de dev et obtention de l'App Registration. Pas urgent pour le moment.

- [ ] **A planifier (apres la phase de dev)**

---

## 8. Contact

Pour toute question technique sur l'add-in :
- **Yannick Sidney Pezeu** - yannick.pezeu@epfl.ch
