# Skill : Organiser une réunion / trouver un créneau commun

## Objectif
L'utilisateur veut ORGANISER / PLANIFIER une réunion, ou TROUVER un CRÉNEAU / une disponibilité
commune à plusieurs personnes.

## RÈGLE ABSOLUE — NE JAMAIS INVENTER DE CRÉNEAUX
Les créneaux et les disponibilités (libre/occupé) viennent **EXCLUSIVEMENT** de l'outil
`find_common_slots`. Tu ne dois **JAMAIS** :
- inventer, deviner ou supposer des horaires de disponibilité,
- fabriquer un tableau de créneaux,
- réutiliser les créneaux d'un tour précédent comme s'ils étaient à jour.

Si tu n'as pas appelé `find_common_slots` dans CE tour-ci, tu n'as **aucune** information de
disponibilité — appelle l'outil AVANT de présenter quoi que ce soit. Tu PEUX consulter le
free/busy des autres participants : c'est précisément ce que fait `find_common_slots`.

## Workflow obligatoire
1. **Identifier les participants** : pour chaque personne nommée, appelle `search_contacts` pour
   obtenir son adresse email exacte. Si plusieurs résultats, désambiguïse (ou demande).
2. **Appeler l'outil** : `find_common_slots(participants=[emails], include_self, duration_minutes,
   start_date, end_date, days_of_week…)`.
   - `include_self=true` si la réunion inclut l'utilisateur (« organise une réu avec X et moi »).
   - `include_self=false` si on cherche seulement la dispo d'autres personnes (« quand est libre X ? »).
   - Par défaut 7 jours / heures ouvrées / créneaux de 30 min ; élargis (`start_date`/`end_date`)
     si l'utilisateur le demande.
3. **Présenter le résultat de l'outil** : affiche les créneaux RÉELLEMENT retournés.
   - Si `all_free_slot_found` : liste les créneaux où tout le monde est libre.
   - Sinon (`fallback_mode`) : présente les meilleurs créneaux avec `free_participants` /
     `busy_participants` pour que l'utilisateur arbitre (« le 10 à 14h, tout le monde sauf Martin »).
   - Si l'utilisateur doute d'un résultat (« ça m'étonnerait »), **rappelle `find_common_slots`**
     (éventuellement sur une fenêtre plus large) — ne te contente pas de re-justifier ou de réafficher.

## À ne PAS confondre
- `prepare_meeting` (skill meeting_briefing) prépare un BRIEFING d'une réunion EXISTANTE — ce n'est
  PAS pour trouver une date. Ici, pour planifier, c'est `find_common_slots`.
