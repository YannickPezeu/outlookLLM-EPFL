# Skill : Afficher les emails d'un contact

## Objectif
L'utilisateur veut VOIR, MONTRER ou AFFICHER ses emails avec quelqu'un, eventuellement filtres par un sujet ou un critere.

## Workflow obligatoire

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
