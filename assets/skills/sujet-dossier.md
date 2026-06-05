# Skill : Cartographier / faire le point sur un sujet

## Objectif
L'utilisateur veut, à propos d'un SUJET ou d'un DOSSIER : soit savoir QUI est impliqué, soit OÙ EN EST l'avancement.

## Outils de ce skill
- `identify_topic_participants` — cartographie les PERSONNES impliquées sur un sujet (rôle, positionnement, contributions clés).
- `summarize_topic_status` — POINT D'AVANCEMENT chronologique d'un projet/dossier en cours.
- `search_contacts_in_servicedesk` — repli pour retrouver une personne via les tickets ServiceNow.

## Choisir le bon outil
- « qui travaille sur X ? », « quels sont les acteurs sur Y ? », « qui est impliqué dans Z ? »,
  « quel est le positionnement de chacun sur W ? » → `identify_topic_participants`.
- « où on en est de X ? », « état d'avancement de Y ? », « fais-moi un point sur Z »,
  « résume l'avancée du dossier W » → `summarize_topic_status`.

Ne demande PAS de précisions — lance directement l'outil adapté.

## IMPORTANT — le paramètre `topic`
Il sert au classement sémantique (embeddings). Un mot seul est trop vague. Développe-le en
description riche avec synonymes et termes associés.
Exemple : au lieu de `topic="IA"`, utilise
`topic="intelligence artificielle, IA, machine learning, LLM, modèles de langage, deep learning, ChatGPT, Copilot"`.

## Après l'outil
Le contenu principal est souvent déjà streamé (`already_displayed: true`) : ne le recopie pas,
termine par une phrase de transition courte.
