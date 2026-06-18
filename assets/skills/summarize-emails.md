# Skill : Resumer les echanges avec un contact

## Objectif
L'utilisateur veut un RESUME ou une SYNTHESE de ses echanges email avec quelqu'un, OU faire
LE POINT / resumer LA SITUATION vis-a-vis d'une PERSONNE (ou de plusieurs personnes nommees).
La cle : la demande nomme une PERSONNE, pas un projet. (Pour un sujet/dossier sans personne
nommee, c'est le skill sujet_dossier.)

## Plusieurs personnes
Si l'utilisateur nomme PLUSIEURS personnes (« la situation avec X et Y »), traite-les
une par une : `search_contacts` puis `summarize_email_interactions` pour CHACUNE, puis
presente les resumes par personne.

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
   - **Indique le decompte de provenance** que l'outil retourne : `direct_count` (emails directs
     avec la personne, dont `received_count` recus + `sent_count` envoyes) et `servicedesk_count`
     (tickets ServiceDesk la mentionnant). Ex : « Base : 12 emails directs avec Sandrine
     (8 recus, 4 envoyes) + 5 tickets ServiceDesk la mentionnant. »

4. **Pieces jointes importantes (optionnel, avec parcimonie)** : Le resultat peut contenir un champ `attachments_available` (liste de refs d'emails ayant des pieces jointes, avec sujet et date).
   - Regarde ces sujets : si une piece jointe semble CENTRALE pour la demande (ex: un document, un rapport, un compte-rendu, un budget, une presentation que le resume mentionne ou dont l'utilisateur a besoin), lis-la avec `read_email_attachments(email_id=<ref>)` puis complete le resume en 2-3 lignes avec ce qu'elle apporte.
   - LIMITE-TOI a 1-3 pieces jointes maximum, et UNIQUEMENT celles jugees vraiment importantes. Ne lis JAMAIS toutes les pieces jointes « au cas ou » : chaque lecture consomme du contexte.
   - Si aucune piece jointe ne semble determinante, n'appelle PAS l'outil.

## Erreurs courantes a eviter
- Ne PAS utiliser `get_email_interactions` (qui affiche/liste les emails) + resumer toi-meme : utilise `summarize_email_interactions` qui fait tout
- Ne PAS reformuler le resume genere par l'outil, affiche-le tel quel
- Ne PAS oublier `search_contacts` en premier
- Ne PAS lire les pieces jointes en masse : seulement celles jugees importantes (1-3 max), via `read_email_attachments`
