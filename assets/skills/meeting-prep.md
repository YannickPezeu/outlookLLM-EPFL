# Skill : Preparer une reunion

## Objectif
L'utilisateur veut PREPARER une reunion, obtenir un BRIEFING, ou se renseigner avant un rendez-vous.

## Workflow obligatoire

1. **Identifier la reunion** : Utilise `get_calendar_events` pour trouver l'evenement.
   - Si l'utilisateur mentionne "demain", "lundi prochain", etc., calcule les dates appropriees.
   - Si plusieurs evenements correspondent, demande a l'utilisateur de preciser lequel.
   - Si un seul evenement correspond, utilise-le directement.
   - Tu as besoin de l'`id` de l'evenement pour l'etape suivante.

2. **Lancer la preparation** : Utilise `prepare_meeting` avec l'event_id de l'evenement choisi.
   - Ce processus prend 30 a 60 secondes. Previens l'utilisateur avant de lancer.
   - Le pipeline analyse les emails echanges avec chaque participant, les classe par pertinence semantique, et genere un briefing structure.

3. **Presenter le briefing** : Affiche le champ `briefing` retourne par l'outil tel quel.
   - Ne reformule PAS le briefing, affiche-le directement en Markdown.
   - Tu peux ajouter une phrase d'introduction avant le briefing.
   - Mentionne le nombre de participants et d'emails analyses (champs `participantCount` et `emailsAnalyzed`).

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
