# Skill : Consulter le calendrier

## Objectif
L'utilisateur veut voir ses evenements, reunions ou rendez-vous a venir.

## Workflow obligatoire

1. **Determiner la periode** : Convertis la demande en dates ISO 8601.
   - "demain" : jour suivant, de 00:00 a 23:59
   - "cette semaine" : du lundi au dimanche de la semaine courante
   - "la semaine prochaine" : du lundi au dimanche suivants
   - Par defaut (si aucune periode mentionnee) : les 7 prochains jours

2. **Recuperer les evenements** : Utilise `get_calendar_events` avec les dates calculees.

3. **Presenter les resultats** : Redige une reponse structuree :
   - Groupe les evenements par jour
   - Pour chaque evenement : heure, titre, lieu (si disponible), participants principaux
   - Si aucun evenement : dis-le clairement
   - Mentionne la periode couverte

## Erreurs courantes a eviter
- Ne PAS oublier de convertir les references temporelles relatives en dates absolues
- Ne PAS ignorer l'annee mentionnee par l'utilisateur
- Ne PAS confondre "cette semaine" et "la semaine prochaine"
