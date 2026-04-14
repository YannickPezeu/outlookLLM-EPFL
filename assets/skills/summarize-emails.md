# Skill : Resumer les echanges avec un contact

## Objectif
L'utilisateur veut un RESUME ou une SYNTHESE de ses echanges email avec quelqu'un.

## Workflow obligatoire

1. **Identifier le contact** : Utilise `search_contacts` avec le nom mentionne.
   - Si un seul resultat : utilise-le directement
   - Si plusieurs resultats : choisis celui dont le nom correspond le mieux
   - Si aucun resultat : essaie `search_contacts_in_servicedesk`

2. **Recuperer les emails** : Utilise `get_email_interactions` avec le nom et l'email trouves.
   - Si l'utilisateur mentionne une periode : ajoute start_date/end_date
   - Si l'utilisateur mentionne un sujet precis : ajoute le parametre `query` pour le filtrage semantique
   - Par defaut, couvre les 6 derniers mois

3. **Rediger le resume** : A partir des resultats, redige un resume structure :
   - **Sujets principaux** : les themes recurrents des echanges
   - **Points cles** : les informations importantes, decisions, actions
   - **Chronologie** : si pertinent, l'evolution des echanges dans le temps
   - Sois concis mais informatif
   - Si les resultats indiquent "default_period", mentionne que la recherche couvre les 6 derniers mois et propose d'elargir

## Erreurs courantes a eviter
- Ne PAS utiliser `show_emails` quand l'utilisateur veut un resume
- Ne PAS juste lister les sujets d'emails sans synthetiser
- Ne PAS oublier `search_contacts` en premier
