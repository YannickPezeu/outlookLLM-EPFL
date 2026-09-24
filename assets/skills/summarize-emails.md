# Skill : Résumer les échanges avec une/plusieurs personnes

## Objectif
L'utilisateur veut un RÉSUMÉ / une SYNTHÈSE de ses échanges email avec une PERSONNE, ou faire LE POINT
sur ses échanges avec PLUSIEURS personnes nommées. La clé : la demande nomme des PERSONNES, pas un projet.
(Pour un sujet/dossier sans personne nommée → skill `sujet_dossier`.)

## Outil unique : `summarize_exchanges`
Il prend TOUS les emails échangés avec les personnes sur la période (pas de mots-clés — les personnes
sont le filtre), et produit un résumé + un rapport Word téléchargé. Deux profondeurs :
- **soft** = résumé global rapide (+ Word : résumé + emails sources cliquables par personne) ;
- **deep** = analyse approfondie 20-par-20 → Word : chronologie détaillée + épurée + décisions majeures +
  synthèse, avec liens cliquables (relevé exhaustif et vérifiable).

## Workflow obligatoire

### Étape 1 — Cadrer (demander avant de lancer)
1. **PROFONDEUR** (`mode`) :
   > « Tu veux un **résumé global rapide**, ou une **analyse approfondie** très précise qui garde une
   > trace de chaque échange (plus long) ? »
   - « global / rapide » → `soft` (défaut). « approfondi / précis / exhaustif » → `deep`.
2. **PÉRIODE** (`start_date` / `end_date`) : demande-la (défaut : 6 derniers mois, fin = aujourd'hui).
3. **ANGLE D'ATTAQUE** (`focus`) : demande EXPLICITEMENT sous quel angle l'utilisateur veut le résumé
   (ex : « avancement du projet X », « aspects budgétaires », « relationnel »). **S'il n'a pas d'angle
   particulier → résumé général** (laisse `focus` vide). Ne devine pas un angle non demandé.
4. **LANGUE** (`language`) : la langue de l'utilisateur (défaut français).

### Étape 2 — Résoudre les personnes
Pour CHAQUE personne nommée, utilise `search_contacts` (puis `search_contacts_in_servicedesk` en repli)
pour obtenir le **nom complet + l'email exact**. Constitue la liste `people` = [{name, email}, …].

### Étape 3 — Lancer
Appelle `summarize_exchanges` avec `people`, `mode`, `focus`, `language`, `start_date`/`end_date`.
Préviens que le deep prend plus de temps.

### Après l'outil
Le résumé est **déjà streamé** (`already_displayed: true`) et le **Word est déjà téléchargé**. Ne recopie
pas le contenu : termine par une phrase courte (rapport Word téléchargé, `report_downloaded`) et propose
d'affiner (période, angle, profondeur) si besoin.

## Erreurs à éviter
- Ne PAS oublier `search_contacts` pour obtenir les emails exacts avant `summarize_exchanges`.
- Ne PAS demander de mots-clés : on prend tous les échanges avec les personnes.
- Ne PAS reformuler le résumé streamé.
