# Backend Apps Script — "Viens me voir à Londres"

`Code.gs` implémente les deux briques décrites dans la conversation :
sync périodique de l'agenda vers `index.html`, et réservation en ligne
d'un week-end depuis la page publique. Ce fichier est une copie de
référence versionnée dans le repo ; **Apps Script ne le lit pas
directement** — il faut le coller manuellement dans l'éditeur en ligne
(étape 2 ci-dessous). Tout ce qui suit doit être fait une fois, à la main,
depuis votre navigateur connecté à c.pelissolo@gmail.com.

## 1. Créer un token GitHub (le seul secret à gérer)

1. https://github.com/settings/personal-access-tokens/new
2. **Repository access** → *Only select repositories* → `knlpsl/agenda`
3. **Permissions** → *Repository permissions* → **Contents** → *Read and write*
   (ne cochez rien d'autre)
4. **Expiration** : 90 jours ou 1 an — notez la date, le script cessera de
   publier silencieusement (erreurs 401) une fois le token expiré, il
   faudra en régénérer un et remplacer la valeur à l'étape 3.
5. Générez le token, copiez-le immédiatement (il ne sera plus jamais affiché).

## 2. Créer le projet Apps Script

1. https://script.google.com/home → **Nouveau projet**
2. Renommez-le, par ex. "agenda-londres-backend"
3. Remplacez tout le contenu de `Code.gs` (dans l'éditeur) par le contenu
   du fichier `apps-script/Code.gs` de ce repo.
4. **Enregistrer** (icône disquette ou Ctrl+S).

## 3. Stocker le token GitHub en toute sécurité

1. Dans l'éditeur Apps Script : icône ⚙️ **Paramètres du projet** (dans le
   menu de gauche).
2. Section **Propriétés du script** → **Ajouter une propriété de script**.
3. Clé : `GITHUB_TOKEN` — Valeur : le token collé à l'étape 1.

Ce token n'est jamais exposé publiquement : ni dans le repo, ni dans le
Web App, ni visible par les visiteurs de la page.

## 4. Autoriser le script (Calendar, Gmail, requêtes externes)

1. Revenez dans l'éditeur (menu **Éditeur**).
2. Sélectionnez la fonction `regenerateAndPublish` dans le menu déroulant
   en haut, puis cliquez **Exécuter**.
3. Google va demander une autorisation. Comme c'est un script personnel
   non publié/vérifié, un écran "Google n'a pas validé cette application"
   apparaît — c'est normal pour un script que vous écrivez vous-même :
   cliquez **Paramètres avancés** → **Accéder à agenda-londres-backend
   (non sécurisé)** → **Autoriser**, en acceptant les scopes Agenda,
   Gmail et connexions externes.
4. Vérifiez dans l'onglet **Exécutions** (icône horloge à gauche) que
   l'exécution s'est terminée sans erreur. Si tout va bien, un nouveau
   commit "Sync agenda: ..." doit apparaître sur
   https://github.com/knlpsl/agenda/commits/main (ou aucun commit si le
   contenu calculé était déjà identique à celui publié).

## 5. Poser le déclencheur quotidien (partie 1 : sync périodique)

1. Sélectionnez `installDailyTrigger` dans le menu déroulant → **Exécuter**.
2. Vérifiez dans l'onglet **Déclencheurs** (icône horloge) qu'un
   déclencheur "regenerateAndPublish — Basé sur la durée — Tous les
   jours — 6h-7h" a bien été créé. Modifiable directement dans cette
   interface si vous préférez un autre horaire.

## 6. Déployer le Web App (partie 2 : réservation en ligne)

1. Bouton **Déployer** (en haut à droite) → **Nouveau déploiement**.
2. Icône ⚙️ à côté de "Sélectionner le type" → **Application Web**.
3. **Exécuter en tant que** : Moi (c.pelissolo@gmail.com)
4. **Qui a accès** : Tous
5. **Déployer**, ré-autorisez si demandé, puis copiez l'**URL de
   l'application Web** (se termine par `/exec`).

⚠️ Si vous modifiez `Code.gs` plus tard, il faut créer une **nouvelle
version** du déploiement (Déployer → Gérer les déploiements → ✏️ →
Version : Nouvelle version → Déployer) pour que l'URL existante serve le
code à jour — republier ne suffit pas tout seul.

## 7. Brancher l'URL dans la page publique

Dans `index.html` à la racine du repo, remplacez :

```js
const WEBAPP_URL = 'REPLACE_WITH_YOUR_APPS_SCRIPT_WEB_APP_URL';
```

par l'URL copiée à l'étape 6, puis commit/push sur `main`.

## 8. Tester de bout en bout

1. Ouvrez la page publique (agenda mobile, mois par mois), touchez un ou
   plusieurs jours verts, appuyez sur **Réserver**, entrez un prénom de
   test dans la feuille qui remonte.
2. Vérifiez : un événement `<prénom> en visite à Londres` apparaît dans
   Google Agenda pour chaque plage de jours consécutifs sélectionnée ; un
   email arrive sur c.pelissolo@gmail.com ; un nouveau commit
   "Sync agenda: ..." apparaît sur GitHub.
3. La page publique elle-même ne se met à jour qu'après que GitHub Pages
   ait reconstruit le site (en général sous 1-2 minutes après le commit).
   Les jours cochés passent en rouge immédiatement côté navigateur, mais
   un autre visiteur qui recharge la page dans la minute qui suit peut
   encore les voir libres le temps que la publication se propage — le
   serveur revérifie toujours la disponibilité de chaque jour avant de
   créer les événements, donc au pire la réservation est refusée avec un
   message clair, jamais un double événement silencieux.
4. Supprimez l'événement de test dans Google Agenda, puis relancez
   `regenerateAndPublish` une fois pour republier une page propre (ou
   attendez le prochain passage du déclencheur quotidien).

## Notes de conception

- La page est un agenda mobile mois par mois (pas de contrainte week-end :
  n'importe quel jour, ou combinaison de jours, peut être sélectionné puis
  réservé). Chaque jour est vert (libre), rouge (réservé — un tap affiche
  le prénom dans une bulle), bleu (Cannelle à Paris) ou gris (pas là — un
  tap affiche "Pas là").
- Le statut "pas là" est alimenté par un événement d'agenda dont le titre
  est exactement `off` (comparé insensible à la casse — `Off`, `OFF`...
  fonctionnent aussi), journée entière ou horodaté. Ces jours sont grisés
  et retirés de `freeSet` : impossible de les réserver, comme pour un
  séjour Paris.
- `index.html` ne contient plus de HTML pré-rendu par jour. Le rendu de la
  grille est un script statique, jamais régénéré ; seul un petit bloc de
  données (marqueur `DATA`, à l'intérieur d'un `<script>`) est réécrit par
  `regenerateAndPublish()` : `WINDOW_START`, `WINDOW_END`, `PARIS_RANGES`,
  `OFF_RANGES` et `BOOKINGS`. Si vous voulez changer l'apparence de la
  grille (couleurs, taille des cases, comportement de la bulle), éditez
  uniquement le CSS/JS statique de `index.html` — `Code.gs` n'a pas besoin
  de changer pour ça.
- La lecture des événements accepte aussi bien un événement "journée
  entière" qu'un événement horodaté pour les visites (`Anna en visite à
  Londres` dans l'agenda actuel est horodaté, pas all-day) — mais toute
  nouvelle réservation créée par `doPost` est systématiquement un
  événement all-day, pour rester cohérent avec la convention déclarée.
- `doPost` reçoit `{"name": "...", "dates": ["YYYY-MM-DD", ...]}` (jours
  individuels, pas forcément consécutifs) et regroupe les jours
  consécutifs pour créer un événement par plage continue.

## Après une modification de Code.gs

Toute modification de ce fichier doit être répercutée à la main dans le
projet Apps Script existant : rouvrez script.google.com, remplacez le
contenu de `Code.gs`, enregistrez, puis **Déployer → Gérer les
déploiements → ✏️ → Nouvelle version → Déployer** pour que le Web App
déjà en place serve le code à jour (l'URL ne change pas). Sans cette
étape, la prochaine exécution du déclencheur quotidien ou la prochaine
réservation utilisera l'**ancien** code puisque c'est ce qui est
actuellement collé dans Apps Script qui tourne, pas ce fichier du repo.
