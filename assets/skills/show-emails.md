# Skill : Afficher / rechercher des emails

## Objectif
L'utilisateur veut VOIR, MONTRER, AFFICHER ou TROUVER des emails — soit avec un contact precis, soit par sujet/mot-cle dans toute sa boite.

## Workflow obligatoire

### Etape 0 : MOT-CLE D'ABORD — choisir le moteur de recherche

**Regle d'or : commence TOUJOURS par `search_emails` (recherche mot-cle, rapide, une requete, sans embeddings).**
Ne bascule sur le SEMANTIQUE (`get_email_interactions` avec query — embeddings, lent) QUE si la demande est une IDEE FLOUE sans terme distinctif. Pour un RESUME d'echanges, c'est `summarize_email_interactions`.

**1. Recherche MOT-CLE — le defaut, des qu'il y a un terme cherchable** (nom de produit « docling », une URL, un mot precis, un numero de ticket, un sujet nomme) :
- Appelle `search_emails(query=<mots-cles>)`.
- **Si l'utilisateur nomme l'expediteur** (« l'email de Matéo qui parle de docling », « le mail où Martin donne le budget », « ce que Carlos m'a envoyé sur X ») → AJOUTE `sender=<nom ou email>` dans le MEME appel.
  Exemple : « l'email de Matéo sur docling » → `search_emails(query="docling", sender="Matéo")`. UN SEUL appel.
  C'est OBLIGATOIRE de passer `sender` des qu'une personne est nommee — sinon un mot-cle courant noie le resultat dans les emails de tout le monde.
- N'appelle PAS `search_contacts` avant : le nom suffit dans `sender` (le `from:` KQL accepte un nom). N'appelle PAS `get_email_interactions`.
- Ne repete PAS la recherche : un seul `search_emails` suffit.
- Lis les corps (~2000 car.) retournes, EXTRAIS l'info demandee (URL, endpoint, montant, date, decision) directement dans ta reponse, puis `display_emails(email_ids=[refs pertinents])` pour la liste cliquable.

**2. Recherche SEMANTIQUE — exception, seulement pour une IDEE FLOUE** où le vocabulaire de l'email peut differer des mots de la demande (« les mails sur le recrutement » → l'email dit « candidat », « entretien », « CV » ; « ce qui touche a l'IA » → « machine learning », « LLM ») :
- AVEC un contact nomme → Etape 1 (search_contacts) puis Etape 2 Cas B (get_email_interactions query + display_emails).
- SANS contact → `search_emails` reste souvent suffisant ; n'utilise le semantique thematique que si le mot-cle echoue vraiment.

**3. Lister TOUS les echanges avec un contact (sans filtre de contenu)** (« montre mes emails avec Patrick », « tous mes echanges avec Martin ») → Etape 1 puis Etape 2 Cas A (get_email_interactions sans query).

**INTERDIT :** `get_email_interactions` avec le nom de l'utilisateur lui-meme (« echanges avec moi-meme » = absurde, tire toute la boite).

### Etape 1 : Identifier le contact
Utilise `search_contacts` avec le nom mentionne.
- Si un seul resultat : utilise-le directement
- Si plusieurs resultats : choisis celui dont le nom correspond le mieux
- Si aucun resultat : essaie `search_contacts_in_servicedesk`

### Etape 2 : Recuperer + afficher les emails

**AVANT D'APPELER UN OUTIL, pose-toi la question : la demande contient-elle un critere de filtrage de contenu ?**
Indices de filtre : "concernant X", "sur le sujet Y", "a propos de Z", "qui parlent de W", "lies a V", "les importants", des mots-cles thematiques (recrutement, IA, budget, projet X...).
Si tu hesites : il y a probablement un filtre. Choisis le Cas B.

**Cas A — PAS de filtre de contenu** (ex: "montre mes emails avec Patrick", "liste mes echanges avec Martin", "tous mes emails avec X") :
- Appelle directement `get_email_interactions(name, email)` SANS query (et start_date/end_date si periode mentionnee)
- Sans query, l'outil affiche automatiquement la liste cliquable complete dans l'interface

**Cas B — IL Y A un filtre de contenu** (ex: "mes emails sur l'IA avec Patrick", "les emails concernant le recrutement avec Martin", "les emails ou il parle du budget", "uniquement les importants") :
1. Appelle `get_email_interactions(name, email, query=<sujet enrichi avec synonymes>)`
   - Exemple : pour "recrutement", utilise `query="recrutement, embauche, candidat, entretien, interview, hiring, application"`
2. Lis les sujets + previews retournes
3. Choisis TOI-MEME les refs des emails reellement pertinents — le ranking par embeddings n'est qu'un pre-tri, certains hors-sujet remontent quand meme (ServiceNow, accuses de reception, "Re: Important", rapports d'avancement non lies au sujet, etc.). C'est ton boulot de les ECARTER.
4. Appelle `display_emails(email_ids=[refs selectionnes UNIQUEMENT], context_label=<sujet>)`
5. L'UI affiche automatiquement la liste cliquable des emails que tu as choisis

**Erreur grave a eviter : appeler get_email_interactions SANS query quand il y a un critere de filtrage.** L'utilisateur recoit alors une liste polluee de hors-sujet. Des qu'il y a un critere, passe par le Cas B (query + selection + display_emails).

### Etape 3 : Repondre brievement
Ecris UNIQUEMENT une phrase d'introduction courte, par exemple :
- "Voici les 12 emails echanges avec Patrick Saladino."
- "J'ai trouve 5 emails sur l'IA dans tes echanges avec Patrick."
- "Aucun email correspondant trouve."

## INTERDICTIONS ABSOLUES
- Ne JAMAIS reproduire la liste des emails sous forme de bullets ou de liens markdown — l'UI l'affiche deja
- Ne JAMAIS ecrire `[Sujet](email:ref_X)` pour les emails affiches via get_email_interactions ou display_emails
- Ne PAS rediger un resume des echanges — c'est le role de `summarize_email_interactions`
- Ne PAS appeler `display_emails` avec TOUS les refs sans avoir filtre — si pas de filtre, utilise `get_email_interactions` sans query directement (Cas A)

## Erreurs courantes a eviter
- Ne PAS oublier `search_contacts` en premier
- Ne PAS rediger un long texte apres l'affichage — une phrase suffit
- Cas B sans `query` : si l'utilisateur n'a pas donne de sujet precis mais demande quand meme un filtre (ex: "les emails importants"), utilise quand meme get_email_interactions sans query, puis filtre toi-meme
