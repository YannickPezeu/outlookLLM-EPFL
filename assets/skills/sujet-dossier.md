# Skill : Faire le point / relevé des décisions sur un sujet

## Objectif
L'utilisateur veut, à propos d'un SUJET ou d'un DOSSIER (un thème), soit :
- **un relevé des DÉCISIONS prises et/ou un point d'avancement** → rapport Word vérifiable + synthèse
  (outils `count_topic_emails` puis `extract_topic_decisions`) ;
- soit savoir **QUI est impliqué** → `identify_topic_participants`.

## ⚠️ Garde-fou — SUJET vs PERSONNE (lis avant tout)
Ce skill est réservé aux **sujets/dossiers/projets** (un thème). Si la demande porte en réalité sur une
**PERSONNE** (ou une liste de personnes nommées) — « résume la situation **avec Sandrine** », « fais le
point **sur mes échanges avec X et Y** » — alors ce N'EST PAS le bon skill : recharge le skill
`summarize_emails`. N'utilise les outils ci-dessous QUE pour un thème, jamais pour une personne.

## Choisir le bon outil
- « quelles décisions ont été prises sur X ? », « où en est le dossier X ? », « fais le point sur X »,
  « relevé/registre des décisions sur X », « la DPO veut savoir ce qui a été décidé sur X »
  → flux **DÉCISIONS** ci-dessous (`count_topic_emails` → `extract_topic_decisions`).
- « qui travaille sur X ? », « quels sont les acteurs sur Y ? », « qui est impliqué dans Z ? »,
  « positionnement de chacun sur W ? » → `identify_topic_participants`.

---

## Flux DÉCISIONS (en DEUX temps, avec validation)

### Étape 0 — Choisir la PROFONDEUR (à demander en premier)
Avant tout, demande à l'utilisateur le niveau de rapport voulu (paramètre `mode`) :
> « Tu veux un **résumé approfondi** très précis (~5 min) qui garde une trace de chaque échange (utile
> pour un audit / la DPO), ou juste un **résumé global** pour te rafraîchir les idées (rapide) ? »
- Réponse « approfondi / précis / trace / audit » → `mode = "deep"`.
- Réponse « global / rapide / rafraîchir » → `mode = "soft"`.
- En cas de doute, propose les deux et laisse choisir. Le `deep` permet de remonter à chaque mail ; le
  `soft` donne une photo fiable « où on en est » sans la chronologie mail par mail ni les descriptions
  détaillées.

### Étape 1 — Cadrer puis FAIRE VALIDER le périmètre
1. **Demande à l'utilisateur les TROIS éléments de cadrage** (ne lance rien avant de les avoir) :
   - **a) PÉRIODE** : date de début, et fin si besoin.
   - **b) MOTS-CLÉS** : ils sont DÉTERMINANTS, ils décident quels emails sont ramassés. Sois **très
     précis** — des mots-clés trop génériques (« IA », « projet ») ratissent des emails sans rapport ;
     privilégie les **noms propres** et termes discriminants (« Apertus », « LLM suisse »). Propose-les
     et fais-les confirmer/corriger.
   - **c) ANGLE** : demande EXPLICITEMENT sous quel angle/perspective l'utilisateur veut le rapport
     (ex. « pour la DPO » → conformité et protection des données personnelles ; « côté budget » → coûts ;
     « risques sécurité »…). **Si l'utilisateur n'a pas d'angle particulier, on fait un résumé GÉNÉRAL
     sans angle** (laisse `focus` vide). Ne devine pas un angle non demandé : propose, et laisse-le
     choisir « pas d'angle particulier ».
2. **Appelle `count_topic_emails`** (keywords + start_date [+ end_date]) → nombre d'emails contenant au
   moins un mot-clé sur la période + un échantillon de sujets.
3. **Présente le résultat et DEMANDE VALIDATION du périmètre COMPLET** : récapitule période + mots-clés +
   angle (ou « résumé général, sans angle »), puis « J'ai trouvé N emails sur la période avec ces
   mots-clés (exemples : …). Je lance l'analyse complète ? »
   - Si le nombre paraît trop grand/petit, l'échantillon hors-sujet, ou l'angle à revoir → ajuste et
     recompte si besoin. N'enchaîne PAS sur l'étape 2 sans accord explicite.

### Étape 2 — Générer le rapport (après validation)
4. **Appelle `extract_topic_decisions`** avec :
   - `mode` : « deep » ou « soft » selon le choix de l'étape 0.
   - `topic` : le sujet en clair (titre + contexte).
   - `keywords` : LES MÊMES mots-clés validés.
   - `question` : une **requête sémantique en langage naturel** — une **QUESTION ou une PHRASE
     complète**, surtout PAS une liste de mots-clés. Elle sert à repêcher des emails pertinents qui ne
     contiennent pas les mots-clés.
     - ✅ Ex : « Quelles décisions ont été prises concernant le déploiement et l'usage du LLM suisse
       Apertus à l'EPFL ? »
     - ❌ À éviter : « Apertus, LLM, IA, déploiement »
   - `focus` (optionnel mais recommandé si un angle existe) : l'ANGLE repéré à l'étape 1, en clair.
     Il est injecté dans toutes les passes (extraction, épurée, majeures, synthèse) pour orienter le rapport.
     - Ex : « conformité et protection des données personnelles (perspective DPO) », « impacts budgétaires ».
     - Laisse vide si la demande est neutre (relevé exhaustif sans angle particulier).
   - `language` : la langue de rédaction du rapport, déterminée d'après la **langue de l'utilisateur dans la
     conversation** (ex : « français », « english », « italiano »). Elle est propagée à toutes les passes.
   - `start_date` / `end_date` : la même période que celle validée.

> Note : le pipeline lit aussi les **pièces jointes** (des emails ET des réunions, plafonnées pour ne pas
> saturer le contexte) et inclut automatiquement les **réunions passées** de l'agenda sur la période
> (description + PJ), recherchées par mot-clé et sémantiquement. Aucune action particulière à prévoir ;
> les réunions apparaissent taguées « [Réunion] » dans le rapport.

### Après l'outil
Le résumé (intro + décisions majeures + synthèse) est **déjà streamé** (`already_displayed: true`) et le
**Word est déjà téléchargé** (chronologie détaillée mail par mail, décisions majeures multi-sources,
synthèse autoportante, avec liens cliquables vers les emails). Ne recopie pas le contenu : termine par
une phrase courte indiquant que le rapport Word a été téléchargé, et propose d'affiner (mots-clés,
période) si besoin.

---

## Flux QUI EST IMPLIQUÉ
- `identify_topic_participants` — cartographie les PERSONNES impliquées (rôle, positionnement,
  contributions). Le paramètre `topic` sert au classement sémantique : développe-le en description riche
  avec synonymes et termes associés.
- `search_contacts_in_servicedesk` — repli pour retrouver une personne via les tickets ServiceNow.

Après l'outil : le contenu est souvent déjà streamé (`already_displayed: true`) — ne le recopie pas,
termine par une phrase de transition courte.
