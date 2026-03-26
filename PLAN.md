# Plan technique - EPFL Mail AI : Preparation de reunions

## Vue d'ensemble

L'utilisateur clique sur "Analyser" depuis un evenement calendrier. L'add-in collecte les emails echanges avec chaque participant, utilise l'embedding semantique pour identifier les plus pertinents, puis genere un briefing structure par participant et un meta-resume global.

---

## Fonctionnalites

### F1. Resume d'un email (deja fonctionnel)
- Office.js lit le mail ouvert → envoi au RCP API → resume affiche en streaming
- Pas besoin de Graph API ni d'Azure AD

### F2. Preparation de reunion (nouveau, principal)
- L'utilisateur ouvre un evenement calendrier dans Outlook
- Clique sur "Preparer cette reunion" dans l'add-in
- L'IA produit un briefing complet

---

## Pipeline de preparation de reunion (F2)

### Phase 1 : Extraction du contexte (~1s)
**Source :** Office.js (local) + Graph API `Calendars.Read`

```
GET /me/events/{eventId}
→ subject, body, start, end, attendees[], location, isRecurring
```

L'add-in extrait :
- Le **sujet** de la reunion (= query de reference pour l'embedding)
- Les **participants** (emails + noms)
- La **description/body** de l'evenement (souvent contient l'ordre du jour)
- Les **reunions precedentes** si c'est une serie recurrente

### Phase 2 : Collecte exhaustive des emails par participant (~10s)
**Source :** Graph API `Mail.Read`

Pour chaque participant, on recupere les emails echanges :

```
Pour chaque participant :
├── GET /me/messages?$filter=from/emailAddress/address eq '{email}'
│   &$top=200 &$orderby=receivedDateTime desc
│   &$select=id,subject,bodyPreview,receivedDateTime,conversationId
│
└── GET /me/messages?$filter=toRecipients/any(r:r/emailAddress/address eq '{email}')
    &$top=200 &$orderby=receivedDateTime desc
    &$select=id,subject,bodyPreview,receivedDateTime,conversationId
```

**Optimisations :**
- `$select` pour ne recuperer que les champs necessaires (pas le body HTML complet)
- Deduplication par `conversationId` : ne garder que le dernier message de chaque thread
- Parallelisation des appels Graph (tous les participants en parallele)

On recupere aussi les evenements passes lies :
```
GET /me/calendarView?startDateTime={-6mois}&endDateTime={now}
→ filtrer ceux avec les memes participants
→ chercher les comptes-rendus (emails envoyes juste apres chaque occurrence)
```

### Phase 3 : Embedding + Reranking (~5s)
**Source :** RCP API `/v1/embeddings` (Mistral 8B embeddings)

```
1. Embed la query de reference :
   "{sujet de la reunion} {description/body de l'evenement}"

2. Batch embed tous les emails collectes :
   Pour chaque email : "{subject} {bodyPreview}"
   → Envoi en batch unique au RCP (~2000 emails en ~3s)

3. Cosine similarity entre la query et chaque email
   → Trier par score de similarite

4. Top 50 → Reranking par LLM :
   "Parmi ces 50 emails, lesquels sont les plus pertinents
    pour preparer la reunion '{sujet}' ?"
   → Top 20 emails retenus
```

### Phase 4 : Lecture des emails selectionnes (~3s)
**Source :** Graph API `Mail.Read`

```
Pour chaque email retenu (top 20) :
└── GET /me/messages/{id}?$select=subject,body,from,toRecipients,receivedDateTime
    → Recuperer le body complet cette fois
```

### Phase 5 : Synthese LLM (~20-30s)
**Source :** RCP API (Qwen 3.5 ou gros modele)

```
Etape A : Resume par participant (parallelisable)
├── Pour chaque participant :
│   └── LLM recoit : les emails pertinents avec ce participant
│       → Produit un resume des echanges, points en suspens, ton general
│       → Avec references aux emails sources

Etape B : Meta-resume (streaming)
└── LLM recoit : tous les resumes par participant + contexte reunion
    → Produit le briefing final structure
```

### Format du briefing final

```markdown
# Briefing : [Sujet de la reunion]
[Date] | [Participants]

## Contexte
[Pourquoi cette reunion a lieu, base sur les emails trouves]

## Points cles par participant

### Martin Rajman
- Dernier echange : [date] - [sujet]
- Points en suspens : [...]
- Ton/sentiment general : [...]
- Sources : [liens vers les emails]

### Autre participant
- ...

## Sujets probables a aborder
1. [Sujet identifie dans les emails]
2. [...]

## Actions en attente
- [Action promise dans un email precedent]
- [...]

## Emails cles a relire
- [Sujet de l'email] ([date]) - [1 ligne de resume]
- [...]
```

---

## Problemes anticipes et mitigations

### 1. bodyPreview peu discriminant
Le `bodyPreview` (255 chars) contient souvent des formules de politesse ou des headers de forward.
**Mitigation :** Embedder `subject` seul pour le premier tri, puis utiliser le body complet en Phase 4 pour le reranking LLM.

### 2. Threads redondants
Un thread de 15 reply-all = 15 mails avec du contenu duplique.
**Mitigation :** Dedupliquer par `conversationId`, ne garder que le dernier message de chaque conversation.

### 3. Reunions recurrentes
"Weekly sync" = 52 occurrences/an. Lesquelles sont pertinentes ?
**Mitigation :** Chercher les emails envoyes dans l'heure qui suit chaque occurrence passee (= probables comptes-rendus). Limiter aux 4 dernieres occurrences.

### 4. Participants externes
Les participants hors EPFL n'ont que les emails envoyes/recus — pas les echanges entre eux.
**Mitigation :** Le LLM doit signaler dans le briefing "contexte partiel pour les participants externes".

### 5. Volume zero
Aucun email trouve avec un participant (nouveau contact, participant administratif).
**Mitigation :** Le signaler dans le briefing : "Aucun echange prealable avec X".

---

## Stack technique

| Composant | Technologie |
|---|---|
| Frontend | React + TypeScript (task pane Outlook) |
| Auth | MSAL.js 2.x (Authorization Code + PKCE) |
| Donnees mail | Microsoft Graph API v1.0 (Mail.Read, Calendars.Read) |
| Embeddings | RCP EPFL API `/v1/embeddings` (Mistral 8B) |
| LLM synthesis | RCP EPFL API `/v1/chat/completions` (Qwen 3.5) |
| LLM resume simple | RCP EPFL API (Mistral Small - plus rapide) |
| Hosting prod | GitHub Pages (fichiers statiques) |

---

## Modeles LLM

| Usage | Modele | Pourquoi |
|---|---|---|
| Resume simple d'un email (F1) | Mistral Small 24B | Rapide, suffisant pour 1 email |
| Reranking des emails (Phase 3) | Mistral Small 24B | Tache simple de classement |
| Resume par participant (Phase 5A) | Qwen 3.5 | Raisonnement sur de longs contextes |
| Meta-resume final (Phase 5B) | Qwen 3.5 | Synthese multi-sources complexe |

---

## Contraintes

- **Lecture seule** : pas de Mail.ReadWrite, pas de Calendars.ReadWrite. L'add-in ne modifie rien.
- **Pas de backend** : tout tourne dans le navigateur.
- **Latence acceptable** : ~40-60 secondes pour une preparation complete. L'utilisateur ne fait pas ca toutes les 5 minutes — un briefing de qualite vaut l'attente.
- **Deduplication critique** : sans dedup par conversationId, on gaspille des embeddings et des tokens LLM sur du contenu redondant.

---

## Plan d'implementation

### Phase 1 : Fondations (actuel)
- [x] Task pane React + webpack
- [x] Resume email via Office.js + RCP API (streaming)
- [x] Service MSAL.js pour auth Azure AD
- [x] Service Graph API pour recherche emails
- [ ] Obtenir le clientId de l'admin EPFL

### Phase 2 : Donnees de test
- [ ] Creer un mock du Graph API avec dataset synthetique (50 contacts, 5000 emails)
- [ ] Ou : remplir la boite mail de test avec des emails synthetiques via Graph API (si Mail.ReadWrite dispo)
- [ ] Valider que les appels Graph fonctionnent (pagination, filtres, $select)

### Phase 3 : Pipeline embedding + selection
- [ ] Ajouter le service RCP embeddings (`/v1/embeddings`)
- [ ] Implementer la collecte exhaustive par participant (Phase 2 du pipeline)
- [ ] Deduplication par conversationId
- [ ] Batch embedding + cosine similarity
- [ ] Reranking LLM (top 50 → top 20)
- [ ] Tester la qualite de la selection sur le dataset de test

### Phase 4 : Synthese et UI
- [ ] Creer le composant `MeetingPrepView`
- [ ] Implementer les resumes par participant (parallelises)
- [ ] Implementer le meta-resume final (streaming)
- [ ] Ajouter `Calendars.Read` au service Graph
- [ ] Integration avec les evenements calendrier Outlook

### Phase 5 : Polish
- [ ] UI de progression en temps reel
- [ ] Gestion des reunions recurrentes
- [ ] Cache des embeddings (ne pas re-embedder les memes emails)
- [ ] Tests avec differents types de reunions (1:1, groupe, externe)
- [ ] Gestion des erreurs et fallbacks
