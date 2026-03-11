# Demande de configuration Azure AD - EPFL Mail AI

**Date :** Mars 2026
**Demandeur :** Yannick Sidney Pezeu - Ingenieur ML, EPFL
**Projet :** Add-in Outlook pour la communaute EPFL - Resume et organisation d'emails par IA

---

## 1. Contexte

Nous developpons un add-in Outlook pour la communaute EPFL qui permet de :
- **Resumer un email** en un clic via l'API LLM interne RCP
- **Resumer toutes les interactions** avec un contact donne (emails envoyes et recus)
- **Organiser les emails** dans des dossiers avec suggestion IA

L'add-in fonctionne **100% cote client** (Single Page Application dans le task pane Outlook). Il n'y a pas de serveur backend. L'authentification utilise MSAL.js avec le flux Authorization Code + PKCE.

Le resume d'un seul email fonctionne deja (demo disponible). Pour les deux autres fonctionnalites, nous avons besoin d'acceder a Microsoft Graph API, ce qui necessite une App Registration dans le tenant EPFL.

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

Toutes les permissions sont **deleguees** (Delegated). L'application agit toujours **au nom de l'utilisateur connecte** et ne peut acceder qu'a sa propre boite mail.

| Permission | Type | Raison | Admin consent requis par defaut ? |
|---|---|---|---|
| `User.Read` | Delegated | Lire le profil de l'utilisateur connecte (nom, email). Necessaire au fonctionnement de MSAL. | Non |
| `Mail.Read` | Delegated | Rechercher et lire les emails dans la boite de l'utilisateur. Necessaire pour la fonctionnalite "Resume des interactions" : on recherche tous les emails echanges avec un contact donne via `GET /me/messages?$filter=from/emailAddress/address eq '...'`. | Non |
| `Mail.ReadWrite` | Delegated | Creer des dossiers mail et deplacer des emails entre dossiers. Necessaire pour la fonctionnalite "Organisation" : `POST /me/mailFolders` (creer un dossier), `POST /me/messages/{id}/move` (deplacer un email). | Non |

### Pourquoi ces permissions sont suffisantes et securisees

- **Deleguees, pas applicatives** : l'add-in ne peut jamais acceder aux mails d'un autre utilisateur. C'est le meme niveau d'acces qu'Outlook lui-meme.
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
Utilisateur ouvre un email dans Outlook
        |
        v
Add-in (task pane, SPA React)
        |
        +---> Office.js : lit le contenu du mail ouvert (local, pas de reseau)
        |
        +---> MSAL.js : obtient un token d'acces aupres d'Entra ID (SSO)
        |         |
        |         v
        |     Microsoft Graph API : recherche d'emails, gestion de dossiers
        |     (https://graph.microsoft.com/v1.0/me/messages, /me/mailFolders)
        |
        +---> API RCP EPFL : envoi du contenu email pour resume par LLM
              (https://inference.rcp.epfl.ch/v1 - API interne EPFL)
```

**Aucune donnee ne transite par un serveur intermediaire.** Tout est direct : navigateur → Graph API et navigateur → RCP API.

---

## 7. Actions demandees a l'administrateur

- [ ] Creer l'App Registration (ou donner les droits pour que je la cree moi-meme)
- [ ] Configurer la plateforme SPA avec les redirect URIs
- [ ] Ajouter les permissions Graph deleguees : `User.Read`, `Mail.Read`, `Mail.ReadWrite`
- [ ] Accorder l'admin consent tenant-wide (si la politique du tenant le requiert)
- [ ] Confirmer que le sideloading d'add-ins custom reste autorise pour les developpeurs
- [ ] Planifier le Centralized Deployment pour la mise en production

---

## 8. Contact

Pour toute question technique sur l'add-in :
- **Yannick Sidney Pezeu** - yannick.pezeu@epfl.ch
