# Skill : Afficher les emails d'un contact

## Objectif
L'utilisateur veut VOIR, MONTRER ou AFFICHER ses emails avec quelqu'un, ou demande ses "derniers emails" / "emails echanges" avec un contact.

## Workflow obligatoire

1. **Identifier le contact** : Utilise `search_contacts` avec le nom mentionne.
   - Si un seul resultat : utilise-le directement
   - Si plusieurs resultats : choisis celui dont le nom correspond le mieux
   - Si aucun resultat : essaie `search_contacts_in_servicedesk`

2. **Recuperer les emails** : Utilise `show_emails` avec le nom et l'email trouves.
   - Si l'utilisateur mentionne une periode : ajoute start_date/end_date
   - Cet outil retourne une liste d'emails avec leurs IDs

3. **Organiser par sujet** : Analyse les emails retournes et regroupe-les par sujet/theme de conversation. Pour chaque groupe :
   - Donne un titre descriptif du sujet
   - Ajoute une courte phrase de resume (1-2 lignes) expliquant de quoi il s'agit
   - Liste TOUS les emails du groupe sous forme de liens cliquables
   - Ordonne par date (plus recent en premier) a l'interieur de chaque groupe

4. **Format des liens cliquables** : Chaque email doit utiliser le format :
   ```
   [Sujet — Date](email:ID)
   ```
   L'utilisateur pourra cliquer pour ouvrir l'email dans Outlook.

## IMPORTANT
- Affiche TOUS les emails retournes, ne filtre rien — l'utilisateur veut voir l'ensemble de ses echanges
- Le classement par sujet est la pour organiser, pas pour filtrer
- Mentionne le nombre total d'emails

## Exemple de reponse
```
Voici les 73 emails echanges avec Martin Rajman :

### Presentation Add-in Outlook
Discussion sur la presentation du prototype d'add-in Outlook pour l'assistant IA.
- [Accepted: Brainstorming Presentation Add-in Outlook — 31/03/2026](email:ref_4)
- [Brainstorming Presentation Add-in Outlook — 31/03/2026](email:ref_5)

### Acces RCP et infrastructure
Configuration de l'acces a l'API RCP via le proxy CORS sur GitHub.
- [Re: Acces RCP CORS via github — 30/03/2026](email:ref_8)
- [Fw: Acces RCP CORS via github — 30/03/2026](email:ref_9)

### GenAI pour la VPH
Echanges sur le projet d'IA generative pour la Vice-Presidence.
- [Re: genAI pour la VPH — 31/03/2026](email:ref_3)

### Reunions
- [Re: Notre reunion a 14h... — 31/03/2026](email:ref_6)
- [Notre reunion a 14h... — 31/03/2026](email:ref_7)

### Divers
Emails sans sujet ou reponses automatiques.
- [Automatic reply: — 07/04/2026](email:ref_0)
- [Re: — 07/04/2026](email:ref_1)
- [*(Sans sujet)* — 05/04/2026](email:ref_2)
```

## Erreurs courantes a eviter
- Ne PAS utiliser `get_email_interactions` quand l'utilisateur veut VOIR/AFFICHER les emails
- Ne PAS rediger un resume detaille quand on te demande d'afficher — juste une phrase par categorie
- Ne PAS oublier `search_contacts` en premier
- Ne PAS oublier le format `[Sujet](email:ID)` pour les liens cliquables
- Ne PAS supprimer des emails — affiche-les tous, classes par sujet
