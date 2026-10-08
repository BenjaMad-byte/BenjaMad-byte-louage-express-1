# Application chauffeur — Louage Express

Application web installable (PWA) pour un chauffeur **déjà accepté** par le [site d'inscription](../driver-portal/README.md) : entrer dans la file d'une gare, voir son rang, déclarer ses passagers (places par tronçon), partir, arriver, déclencher une alerte SOS. Fonctionne **sans réseau** une fois connectée. Service séparé du site d'inscription, avec sa propre base : voir [docs/plan-application-chauffeur.md](../docs/plan-application-chauffeur.md) pour les décisions et les limites assumées.

## Lancer

```bash
cp deploy/app.env.example .env   # remplir PORTAL_URL, APP_SERVICE_KEY (= celle du portail), SOS_ALERT_PHONES…
npm install
npm start                         # http://localhost:4200
```

En développement, sans `SMS_PROVIDER`, les codes de vérification s'affichent dans le journal du serveur (jamais en production).

## Architecture

- **`public/engine.js`** : le cœur, un module *pur* (sans réseau ni horloge) qui décide des places par tronçon, du remplissage séquentiel de la file et de l'attribution des réservations. **Utilisé identiquement par le serveur (`actions.js`, qui fait autorité) et par le téléphone (`public/local.js`, pour l'affichage immédiat hors ligne)** — un test de parité (`test/parity.test.js`) rejoue 300 suites aléatoires d'actions et vérifie que les deux donnent le même résultat.
- **`db.js`** : base SQLite propre à l'application (chauffeurs copiés depuis le portail, sessions, lignes, voyages, passagers, SOS, réservations).
- **`portal-client.js`** / **`auth.js`** : qui est un chauffeur accepté ? (service à service avec le portail), connexion par matricule + mot de passe, activation par lien SMS, récupération par code SMS, sessions de 30 jours glissants — voir « Connexion » ci-dessous.
- **`actions.js`** : applique une action du chauffeur, idempotente (identifiant unique) et ordonnée (numéro d'ordre de l'appareil, pas l'horloge du téléphone).
- **`sos.js`** : alertes SOS — voir « Ce que le SOS n'est PAS » ci-dessous.
- **`reservations.js`** / **`sva.js`** : réservations en ligne et paiement par solde mobile (SVA). **Désactivées par défaut** (`RESERVATIONS=on`) ; aucun opérateur réel n'est connecté (voir plus bas).
- **`server.js`** : routes HTTP, sécurité (HTTPS, CSP, limites de débit), sert l'application (`public/`) et l'onglet Exploitation du portail.
- **`public/`** : l'application elle-même — `app.js` (écrans), `sync.js` (file d'actions hors ligne), `store.js` (IndexedDB, repli en mémoire), `local.js` (rejoue les actions avec `engine.js`), `sw.js` (service worker : l'application s'ouvre hors ligne), `i18n.js` (arabe darija / français), `passager.js`+`passager.html` (page de **démonstration** passager, pas une vraie application).

## Connexion

Au quotidien, le chauffeur se connecte avec son **matricule + un mot de passe** — pas de code SMS à chaque fois. Le matricule n'est pas un secret (il est peint sur la voiture) : c'est un identifiant, comme un nom d'utilisateur ; le mot de passe est le seul secret, et c'est le chauffeur qui le choisit, jamais le site d'inscription ni un administrateur.

- **Activation** : dès que le dossier est accepté (synchronisation périodique avec le site d'inscription), un **lien personnel à usage unique** part par SMS (`/activer?jeton=…`, valable 7 jours). Le chauffeur l'ouvre, choisit son mot de passe, et est connecté tout de suite sur cet appareil. Un lien expiré ou déjà utilisé peut être renvoyé depuis l'onglet Exploitation du portail (`POST /api/ops/drivers/:id/resend-activation`) ; le nouvel envoi invalide l'ancien lien.
- **Mot de passe oublié** : code reçu par SMS (même service que le site d'inscription) puis nouveau mot de passe. Les autres appareils déjà connectés sont déconnectés par mesure de sécurité.
- **Verrouillage** : 5 mots de passe erronés verrouillent le compte 15 minutes, même pour une tentative correcte entre-temps.
- Le téléphone ne sert donc qu'à l'activation et à la récupération, jamais à la connexion de tous les jours — voir [la décision correspondante](../docs/plan-application-chauffeur.md) pour le contexte.

## Hors ligne

Un geste du chauffeur (+1 passager, partir, SOS…) est écrit sur l'appareil **avant** tout envoi, avec un identifiant unique et un numéro d'ordre croissant. L'affichage se met à jour tout de suite via `engine.js` ; l'envoi suit dès que le réseau revient, avec un délai croissant entre les essais. Le serveur rejoue les actions dans l'ordre de leur numéro (jamais l'ordre d'arrivée réseau ni l'horloge du téléphone), chacune une seule fois. Le service worker met en cache les fichiers de l'application (pas l'API) : l'application **s'ouvre** sans réseau, avec le dernier état connu.

## Ce que le SOS n'est **PAS**

Il n'existe **aucune connexion à la Police (197) ni à la Protection civile (198)** : aucune API publique ne le permet. Une alerte part par **SMS vers des numéros de permanence choisis par vous** (`SOS_ALERT_PHONES`), répétée toutes les 2 minutes jusqu'à un accusé de réception dans la console d'administration du portail (onglet « Exploitation »). **N'activez jamais le SOS auprès des chauffeurs sans une personne réellement de garde, avec une procédure écrite** — `assertAppConfig` refuse de démarrer en production sans ce numéro, mais ne peut pas vérifier qu'une personne répond vraiment. L'application affiche aussi des numéros d'urgence que le chauffeur touche pour composer lui-même (`EMERGENCY_NUMBERS`, à vérifier avant mise en ligne).

## Réservations en ligne et SVA — aucune connexion réelle

`RESERVATIONS=on` active les réservations, mais **aucun opérateur (Tunisie Telecom, Ooredoo, Orange) n'est branché** : seul `sva.js` fournit une simulation (`SVA_PROVIDER=simulated`), **interdite en production** (`assertAppConfig` refuse de démarrer). `public/passager.html` est une page de **démonstration**, pas une application passager. Avant d'ouvrir ce module : un contrat avec un opérateur ou un agrégateur, l'implémentation de son interface (`charge`/`refund`), et une décision sur le circuit des fonds (qui encaisse, comment le chauffeur est payé, remboursements).

## Exploitation (console du portail)

L'onglet « Exploitation » de la console d'administration du **site d'inscription** interroge cette application (`OPS_SERVICE_KEY`, différente de `APP_SERVICE_KEY`) : files par ligne, voyages en cours, alertes SOS avec position et bouton « Prendre en charge »/« Clôturer ». L'acteur de chaque action est toujours le compte nominatif connecté sur le portail, jamais une valeur envoyée par le navigateur. Voir `driver-portal/README.md`, section « Exploitation ».

## Tests

```bash
npm test          # unitaires + API (moteur, actions, connexion, SOS, réservations, synchronisation)
npm run test:e2e  # navigateur réel : hors ligne, SOS, réservation de bout en bout, accessibilité (arabe/français, clair/sombre)
npm run check      # hygiène du dépôt (partagé avec driver-portal/tools/check-repo.js)
npm run ci         # les trois d'affilée (utilisé par la CI, voir ../.github/workflows/ci.yml)
```

## Déploiement

Pas encore fait. `deploy/app.env.example` liste les variables (base chiffrée séparée de celle du portail, `PORTAL_URL`/`APP_SERVICE_KEY`, `OPS_SERVICE_KEY`, SOS, SMS). `assertAppConfig` (`config.js`) refuse de démarrer en production avec une configuration faible (clés courtes, HTTPS absent, aucun numéro de permanence SOS, réservations activées sans vrai fournisseur SVA). Pas de guide pas à pas équivalent à `driver-portal/deploy/DEPLOY.md` pour l'instant : à écrire avant la mise en ligne, avec le même HTTPS, le même disque chiffré et la même procédure de sauvegarde que le portail.

## Limites connues

- Zéro essai réel : aucun SMS, aucune position GPS, aucun navigateur de téléphone bas de gamme.
- PWA : pas de bouton SOS physique, pas de position quand l'écran est éteint, pas de SMS de secours automatique si le réseau manque (contrairement à ce qu'envisageait la note d'architecture initiale pour une application native).
- Pas de géorepérage des gares (109 points OpenStreetMap, incomplets et mal classés) : le chauffeur déclare lui-même « je suis à la gare ».
- Backend KYC, suppression de compte côté application, comptes nominatifs pour l'onglet Exploitation (il réutilise ceux du portail) : hors périmètre de ce paquet.
