# Skill : Resumer les echanges avec un contact

## Objectif
L'utilisateur veut un RESUME ou une SYNTHESE de ses echanges email avec quelqu'un.

## Workflow obligatoire

1. **Identifier le contact** : Utilise `search_contacts` avec le nom mentionne.
   - Si un seul resultat : utilise-le directement
   - Si plusieurs resultats : choisis celui dont le nom correspond le mieux
   - Si aucun resultat : essaie `search_contacts_in_servicedesk`

2. **Generer le resume** : Utilise `summarize_email_interactions` avec le nom et l'email trouves.
   - Si l'utilisateur mentionne une periode : ajoute start_date/end_date
   - Si l'utilisateur mentionne un sujet precis : ajoute le parametre `query` pour le filtrage semantique
   - Par defaut, couvre les 6 derniers mois
   - Cet outil deduplique les conversations, nettoie le HTML, et genere un resume structure avec to-dos

3. **Afficher le resume** : Affiche le resume retourne par l'outil VERBATIM, tel quel, sans le reformuler.
   - Si le nombre d'emails analyses est faible, mentionne-le et propose d'elargir la periode

## Erreurs courantes a eviter
- Ne PAS utiliser `get_email_interactions` + resumer toi-meme : utilise `summarize_email_interactions` qui fait tout
- Ne PAS utiliser `show_emails` quand l'utilisateur veut un resume
- Ne PAS reformuler le resume genere par l'outil, affiche-le tel quel
- Ne PAS oublier `search_contacts` en premier
