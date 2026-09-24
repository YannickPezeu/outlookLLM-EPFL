# Skill : Résumer l'email ouvert

## Objectif
L'utilisateur veut un RÉSUMÉ / une analyse de l'email ACTUELLEMENT OUVERT dans Outlook (corps + pièces jointes).

## Workflow
1. Appelle `summarize_current_email` (aucun paramètre) — il lit l'email ouvert (corps + pièces
   jointes : PDF, DOCX, XLSX, PPTX, TXT, CSV, HTML) et renvoie son contenu.
2. Rédige le résumé en suivant le champ `instructions` du résultat, avec ces sections :
   `## Contexte / projet`, `## Ce qui est demandé`, `## Échéances`, `## Points d'attention`.
3. Reste factuel, n'invente rien, signale ce qui est ambigu ou absent. Si une section est vide,
   écris « Rien à signaler ».

## À ne PAS confondre
- `read_email_attachments` cible un email par ref (skill summarize_emails), pas l'email ouvert.
- `summarize_email_interactions` résume les échanges avec un CONTACT (skill summarize_emails), pas le mail courant.

## Si l'utilisateur veut répondre
Tu peux proposer un texte de réponse DANS LE CHAT (il le copiera/collera). L'add-in ne rédige
pas directement dans le brouillon Outlook — pas d'outil pour ça.
