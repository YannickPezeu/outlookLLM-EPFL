# Skill : Preparer une reunion

## Objectif
L'utilisateur veut PREPARER une reunion, obtenir un BRIEFING, ou se renseigner avant un rendez-vous.

## Workflow obligatoire

1. **Identifier la reunion** : Utilise `get_calendar_events` pour trouver l'evenement.
   - **Utilise TOUJOURS une fenetre large** : ne cale JAMAIS `end_date` sur l'heure exacte
     supposee de la reunion. Meme si l'utilisateur dit "dans 30 min" ou "a 13h30", cherche
     sur toute la journee (start = debut de journee, end = fin de journee) — sinon tu risques
     de rater l'evenement (la borne `end_date` est exclusive, et l'heure annoncee par
     l'utilisateur est souvent approximative).
   - Si l'utilisateur mentionne "demain", "lundi prochain", etc., calcule les dates appropriees
     et couvre la journee entiere correspondante.
   - Si plusieurs evenements correspondent, demande a l'utilisateur de preciser lequel.
   - Si un seul evenement correspond, utilise-le directement.
   - Tu as besoin de l'`id` de l'evenement pour l'etape suivante.

2. **Cadrer : demander la PROFONDEUR et la PÉRIODE** (avant de lancer) :
   - **`mode`** :
     > « Tu veux un **briefing global rapide** (vue d'ensemble), ou une **analyse approfondie** qui passe
     > en revue tous tes échanges avec les participants pour en sortir les décisions majeures (plus long) ? »
     - « global / rapide / aperçu » → `soft`. « approfondi / décisions / exhaustif » → `deep`.
   - **`start_date` / `end_date`** : la **période** d'échanges à analyser (ex : 6 ou 12 derniers mois).
     Demande-la (surtout en deep). Défaut fin = aujourd'hui.
   - **`language`** : la langue de l'utilisateur (défaut français).
   - PAS de mots-clés ni d'angle à demander : on regarde TOUS les échanges avec les participants, et
     l'angle est défini automatiquement par le **titre + la description de la réunion**.

3. **Lancer** : Utilise `prepare_meeting` avec l'event_id + ces paramètres. Préviens que ça prend du temps
   (deep plus long). L'outil affiche le résultat ET **télécharge un rapport Word** :
   - soft → briefing + emails sources cliquables par participant ;
   - deep → décisions majeures + synthèse + emails sources cliquables.

4. **Presenter** : Affiche le champ `briefing`/résumé retourné tel quel (Markdown), sans le reformuler.
   - Mentionne `participantCount`, `emailsAnalyzed`, et que le **rapport Word a été téléchargé** (`report_downloaded`).

## Pour TROUVER UNE DATE / un créneau
Ce n'est PAS ce skill. Si l'utilisateur veut ORGANISER une réunion ou trouver une disponibilité
commune (« organise une réu avec X et Y », « trouve un créneau »), c'est le skill
`schedule_meeting` (outil `find_common_slots`). Ici, `prepare_meeting` ne fait qu'un BRIEFING d'une
réunion déjà existante.

## Exemple d'introduction
```
J'ai prepare le briefing pour ta reunion **Comite de pilotage** avec 4 participants (127 emails analyses) :

[... briefing tel quel ...]
```

## Erreurs courantes a eviter
- Ne PAS essayer de preparer la reunion manuellement avec `get_email_interactions` — utilise `prepare_meeting`
- Ne PAS oublier d'appeler `get_calendar_events` d'abord pour obtenir l'event_id
- Ne PAS reformuler ou resumer le briefing — il est deja structure et complet
- Ne PAS lancer `prepare_meeting` sans prevenir l'utilisateur que ca prendra du temps
