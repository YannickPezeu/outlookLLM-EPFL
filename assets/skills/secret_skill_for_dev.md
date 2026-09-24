# Skill [DEV/TEST] : Rapport Word des décisions sur un sujet

> Bac à sable pour tester le pipeline `extract_topic_decisions`. À itérer librement.

## Objectif
L'utilisateur veut un **relevé exhaustif et vérifiable des DÉCISIONS** prises sur un sujet/dossier,
sous forme de **document Word** où chaque décision est **liée à son email source** (lien cliquable).
Cas typique : « donne-moi toutes les décisions prises sur Apertus » (demande DPO / audit).

## Quand l'utiliser
- « toutes les décisions prises sur X », « relevé / registre des décisions sur X »
- « la DPO veut savoir ce qui a été décidé concernant X »
- « un rapport vérifiable des arbitrages sur le dossier X »

Si l'utilisateur veut juste un point d'avancement narratif (« où on en est de X ? ») → skill
`sujet_dossier`, PAS celui-ci.

## Workflow obligatoire (en DEUX temps avec validation)

### Étape 1 — Cadrer puis FAIRE VALIDER le périmètre
1. **Demande à l'utilisateur la PÉRIODE** (date de début, et fin si besoin) et **les MOTS-CLÉS**.
   - Les mots-clés sont DÉTERMINANTS : ils décident quels emails seront ramassés. Sois **très précis**.
     Des mots-clés trop génériques (« IA », « projet ») ratissent des emails sans rapport.
     Privilégie les **noms propres** et termes discriminants (« Apertus », « LLM suisse »).
   - Propose des mots-clés et fais-les confirmer/corriger par l'utilisateur.
2. **Appelle `count_topic_emails`** (keywords + start_date [+ end_date]) → tu obtiens le NOMBRE d'emails
   contenant au moins un mot-clé sur la période + un échantillon de sujets.
3. **Présente le résultat et DEMANDE VALIDATION** : « J'ai trouvé N emails sur la période avec ces
   mots-clés (exemples : …). Je lance l'analyse complète ? » 
   - Si le nombre paraît trop grand/petit ou l'échantillon hors-sujet → ajuste mots-clés/période et
     recompte. N'enchaîne PAS sur l'étape 2 sans accord explicite.

### Étape 2 — Générer le rapport (après validation)
4. **Appelle `extract_topic_decisions`** avec :
   - `topic` : le sujet en clair (titre + contexte).
   - `keywords` : LES MÊMES mots-clés validés.
   - `question` : une **requête sémantique en langage naturel** — une **QUESTION ou une PHRASE
     complète**, surtout PAS une liste de mots-clés. Elle sert à repêcher 50 emails pertinents qui ne
     contiennent pas les mots-clés.
     - ✅ Ex : « Quelles décisions ont été prises concernant le déploiement et l'usage du LLM suisse
       Apertus à l'EPFL ? »
     - ❌ À éviter : « Apertus, LLM, IA, modèle, déploiement »
   - `start_date` / `end_date` : la même période que celle validée.

## Ce que fait le pipeline (pour info)
emails mot-clé (≥ 1 mot-clé, sur la période) **∪** 50 emails sémantiques (sur la `question`)
→ lecture mail par mail (corps tronqué + budget par lot → pas d'explosion de contexte ; pièces jointes
non lues) → extraction des décisions (JSON) → chronologie épurée → intro + conclusion → document Word
(3 sections + liens sources cliquables) téléchargé.

## Après l'outil
Le résumé (intro + décisions clés + conclusion) est **déjà streamé** (`already_displayed: true`) et le
**Word est déjà téléchargé**. Ne recopie pas le contenu : termine par une phrase courte indiquant que le
rapport Word a été téléchargé, et propose d'affiner (mots-clés, période) si besoin.

## Notes de test (à affiner)
- Le processus prend 1-2 min sur un gros dossier → s'appuyer sur la progression affichée.
- Si peu/pas de décisions : suggérer d'ajuster les `keywords` ou la `question`.
