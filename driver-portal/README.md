# Portail chauffeurs — Louage Express

Site d'inscription à distance, **réservé aux chauffeurs de louage** (ni passagers, ni autres profils), avec réservation d'un entretien (visio ou téléphone) pour ceux qui ont des questions. Mobile d'abord, arabe (RTL) par défaut, français en un clic.

## Lancer

```bash
cd driver-portal
npm install
ADMIN_TOKEN="choisis-un-long-secret" WHATSAPP_NUMBER=21698123456 npm start   # http://localhost:4100
npm test
```

Node ≥ 22.5 (utilise `node:sqlite`, aucune dépendance native). Sans `ADMIN_TOKEN`, un jeton temporaire est généré et affiché au démarrage.

| Variable | Rôle | Défaut |
|---|---|---|
| `ADMIN_TOKEN` | Jeton de la console `/admin`. **32 caractères minimum en production** (obligatoire, jamais affiché) ; 8 minimum sinon | aléatoire, affiché au démarrage (hors production) |
| `PORT` | Port HTTP | `4100` |
| `DATA_DIR` | Base SQLite + documents (hors `public/`) | `./data` |
| `WHATSAPP_NUMBER` | Affiche un bouton WhatsApp sur la page entretien | désactivé |
| `JITSI_BASE` | Serveur de visio (un salon unique et non devinable est créé par entretien) | `https://meet.jit.si` |
| `SLOT_DAYS`, `SLOT_START_HOUR`, `SLOT_END_HOUR`, `SLOT_MINUTES`, `SLOT_NOTICE_MINUTES` | Créneaux d'entretien (heure de Tunis, dimanche fermé) | 7 j, 9 h–17 h, 30 min, préavis 2 h |
| `SMS_PROVIDER` | `console` (dev : le code s'affiche dans les logs, **interdit si `NODE_ENV=production`**) ou `twilio` | `console` |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (ou `TWILIO_MESSAGING_SERVICE_SID`) | Identifiants Twilio si `SMS_PROVIDER=twilio` | — |
| `SMS_DAILY_CAP` | Plafond global d'envois SMS sur 24 h (protège contre une facture explosive) | `200` |
| `OTP_SECRET` | Secret de hachage des codes SMS (à fixer si plusieurs instances) | aléatoire par processus |
| `NODE_ENV` | Mettre `production` en ligne | — |
| `KYC_BACKEND_URL` | Adresse du backend KYC (`../backend`) | `http://localhost:4000` |
| `KYC_SERVICE_KEY` | Clé partagée portail ↔ backend (en-tête `X-Service-Key`). **Obligatoire en production** côté backend, qui refuse de démarrer sans elle | — |
| `DATA_KEY` | Clé de **chiffrement des pièces au repos** (CIN, permis, licence, selfies) : 32 octets en hexadécimal (`openssl rand -hex 32`) ou base64. **Obligatoire en production.** Sans elle (développement), les fichiers sont en clair et un avertissement s'affiche | — |
| `PUBLIC_URL` | Adresse publique du site (ex. `https://inscription.exemple.tn`) : sert aux aperçus de lien WhatsApp/Facebook, au `canonical` et au plan du site. **Obligatoire en production** ; sans elle (développement) l'adresse vient de la requête | — |
| `HOST` | Adresse d'écoute. **`127.0.0.1` en production** : seul le proxy HTTPS local peut joindre l'application | toutes les interfaces |
| `ADMIN_ALLOWED_IPS` | Adresses IP autorisées pour l'API admin, séparées par des virgules (ex. l'IP du bureau). Vide = pas de restriction | — |
| `ALLOWED_ORIGINS` | Origines supplémentaires autorisées pour les requêtes d'écriture (ex. `https://admin.exemple.tn`) | — |
| `TRUST_PROXY` | Nombre de proxys devant l'app (nécessaire derrière nginx/Cloudflare pour que la limitation de débit voie la vraie IP **et** pour que le HTTPS soit détecté). Le proxy doit transmettre `Host` et `X-Forwarded-Proto` | non défini |

## Charte graphique

Palette : vert profond `#003934` (texte, boutons, marque) et turquoise `#1A9E8F` (accent : menu actif, tampons, bandes), sur fond brume `#f3f7f6` ; thème sombre dérivé (`#031f1c`). Tout est dans les variables en tête de `public/styles.css`. Les petits textes turquoise utilisent `--accent-ink` (plus foncé en clair, plus clair en sombre) : `#1A9E8F` seul n'a pas le contraste de lecture exigé sur fond clair. Menu et boutons en capitales espacées pour le français ; **jamais pour l'arabe** (l'espacement casse la liaison des lettres). Icônes et image de partage : `python tools/make_share_assets.py`.

## Pages

- `/` accueil · `/register` inscription · `/interview` réservation d'entretien · `/status` suivi de la demande · `/admin` console (français)
- `/privacy` confidentialité · `/terms` conditions d'utilisation · `/legal` mentions légales (arabe et français, liées depuis le pied de page de chaque page et depuis la section « Consentement » du formulaire)

## Vérification du téléphone par SMS

À l'inscription, le chauffeur reçoit un code à 6 chiffres sur le numéro saisi et doit le confirmer avant de pouvoir envoyer le dossier. Le serveur refuse toute inscription dont le numéro n'a pas été vérifié.

- Code valable **5 min**, **5 essais** puis verrouillage, remplacé à chaque nouvel envoi. Stocké uniquement sous forme de hash (HMAC) ; le jeton « téléphone vérifié » (30 min, usage unique, lié au numéro) aussi.
- Anti-détournement des envois (« SMS pumping ») : numéros tunisiens mobiles uniquement, **60 s** entre deux envois, **3 envois/heure/numéro**, **10 envois/heure/IP**, **plafond quotidien** global. Si le fournisseur échoue, le quota n'est pas consommé.
- Les chiffres indo-arabes (٠-٩) d'un clavier arabe sont acceptés partout (téléphone, CIN, code).
- Brancher un autre fournisseur (agrégateur local, opérateur) = ajouter un bloc dans `sms.js` qui implémente `send(phone8, text)`.
- La réservation d'entretien ne demande **pas** de vérification (volontairement : simple demande d'information, limitée par IP et par numéro).

## Vérification d'identité (backend KYC)

À l'inscription, le chauffeur prend **3 photos de son visage** en tournant légèrement la tête (caméra, ou photos de la galerie en repli) et donne un **consentement biométrique séparé**. Une tâche de fond envoie ensuite CIN recto + selfies (+ permis, licence) à `POST /api/v1/auth/driver/verify-identity` du backend : OCR de la CIN, vivacité, comparaison faciale.

- **Le résultat n'accepte jamais personne.** C'est une aide à la décision affichée dans `/admin` (statuts : En file · En cours · **Vérifiée** · **À examiner** · Non exécutée · Erreur). L'acceptation reste humaine.
- **« Vérifiée » exige trois choses** : le backend dit `verified`, la comparaison faciale vient d'un **vrai moteur biométrique** (pas du repli par similarité d'image), **et** le numéro lu par OCR sur la CIN est celui que le chauffeur a saisi (contrôle fait par le portail, absent du backend). Sinon : « À examiner » avec les raisons.
- **Sans AWS Rekognition configuré côté backend, aucun dossier ne peut être « Vérifié »** : le backend retombe sur un hash d'image qui ne prouve rien, et le portail le refuse. Voir `backend/src/kyc/`.
- Le portail ne garde que des indicateurs (score, moteur, vivacité, CIN concordante, raisons) : **jamais le texte OCR ni les images du résultat**. Il demande au backend d'effacer son enregistrement après lecture.
- **Selfies supprimés** dès que la vérification est « Vérifiée », ou dès que l'admin accepte/refuse la demande. Ils restent tant qu'un humain doit les examiner (« À examiner ») ; une relance est impossible après suppression.
- Backend injoignable : réessais à 30 s, 2 min, 10 min, puis « Erreur » (bouton « Relancer » dans l'admin). Reprise automatique après un redémarrage.
- La route KYC du backend est protégée par `KYC_SERVICE_KEY` ; les autres routes du backend prototype restent ouvertes.
- Cas non automatisables, envoyés en revue manuelle : CIN recto en PDF, selfies absents.

## Tampons de gares (formulaire d'inscription)

Une barre collée en haut du formulaire montre six tampons, du nord au sud : Tunis (vos informations, avec téléphone vérifié par SMS), Nabeul (véhicule et station), Sousse (ligne), Kairouan (documents), Gafsa (selfies), Tozeur (consentements). Un tampon se « pose » quand la section est complète ; cliquer dessus amène à la section. À l'envoi, l'écran de confirmation affiche la carte complète.

C'est **purement visuel** : rien n'empêche l'envoi, la validation reste celle du serveur. Code : `public/stamps.js` ; les conditions de complétion sont dans `public/register.js` (`sectionDone`).

## Circuit des chauffeurs et réseau par gouvernorat

Il n'existe pas de liste publique des lignes de louage (voir [docs/reseau-louage-par-gouvernorat.md](../docs/reseau-louage-par-gouvernorat.md)). Le réseau se construit donc à partir de ce que les chauffeurs déclarent à l'inscription :

- **Type de ligne** : *régional* (reste dans le gouvernorat de la station, ex. Redeyef → Gafsa), *interrégional* (va vers un autre gouvernorat, ex. Sousse → Tunis) ou *rural* (desserte des villages ; comme le régional, l'arrivée reste dans le gouvernorat de la station) ou *national* (tous les gouvernorats). L'inscription est ouverte aux quatre types.
- **Circuit** : ville de départ (texte libre) + gouvernorat d'arrivée (liste des 24). Le serveur vérifie la cohérence : un circuit régional doit arriver dans le gouvernorat de la station, un circuit interrégional dans un autre. Le champ `route` (affichage) est calculé : « ville → gouvernorat ».
- **Admin → onglet « Réseau par gouvernorat »** : les 24 gouvernorats, avec leurs lignes régionales et interrégionales, le nombre de chauffeurs et d'acceptés. Les orthographes d'une même ville (« Redeyef », « redeyef ») sont regroupées ; les refusés sont ignorés. Export CSV : `GET /api/admin/network.csv`.
- L'admin classe les circuits en quatre colonnes par gouvernorat de départ : régional, interrégional, national, rural.
- **Louage national** (troisième type) : un louage qui circule dans tous les gouvernorats, sans ligne fixe. Il n'a pas de gouvernorat d'arrivée : le formulaire ne demande que sa ville de départ habituelle, et l'admin le classe dans une colonne « Louages nationaux » du gouvernorat de départ.
- **Arrêts en route et départs incomplets** : un louage prend parfois des passagers dans d'autres villes sur son chemin, ou quitte le gouvernorat avec des places libres qu'il complète plus loin. Le formulaire demande donc, en plus du circuit : jusqu'à 5 villes d'arrêt (facultatif, séparées par des virgules ; obligatoire si le chauffeur coche « je prends des passagers en route ») et deux cases : « il m'arrive de prendre des passagers dans d'autres villes sur ma route » et « il m'arrive de partir avant d'être plein et de compléter en route ». L'onglet Réseau et l'export CSV affichent ces arrêts et le nombre de chauffeurs concernés.
- « Redeyef », « redeyef », « Rdayef » et « الرديف » forment **une seule ligne** (voir la section suivante). Une ville hors liste (village, quartier) reste acceptée et simplement signalée « non reconnue ».
- Les demandes créées avant cette fonction n'ont que `route` (texte) : elles sont comptées comme « sans circuit structuré ».

## Suggestions de villes par gouvernorat

La ville de départ propose, dans la langue de l'interface, les villes du gouvernorat de la station (chef-lieu d'abord, puis ordre alphabétique) ; la saisie libre reste permise, **aucune ville n'est jamais refusée**.

- **Données** : `public/places-data.js` (généré, ne pas modifier à la main) = 264 délégations + 17 chefs-lieux ajoutés, en français et en arabe, 24 gouvernorats. Source : © contributeurs OpenStreetMap, licence **ODbL** (relations `admin_level=5`), brute dans `../db/osm_delegations.json`. Les villages et imadas ne sont pas inclus.
- **Régénérer** : modifier `tools/make_places_data.py` (corrections, alias) puis `python tools/make_places_data.py`. Le script refuse de produire un fichier dont le nombre de délégations par gouvernorat s'écarte du nombre officiel.
- **Corrections manuelles** (expliquées dans le script) : 4 rattachements de gouvernorat (Ben Gardane, Soliman, Bizerte Nord, Menzel Jemil), 1 entrée exclue (« Essaida », absente de la liste officielle), quelques coquilles de noms.
- **Alias** : variantes d'écriture courantes (« Rdayef », « Oum Larayes », « El Guettar », « Thibar », « Sidi El Hani »…). À enrichir à partir des saisies « non reconnues » de l'admin.
- **Reconnaissance** : `public/places.js` (`matchKey` ignore casse, accents, tirets, article « ال » / El / Le / La). Elle se fait à la lecture, sans migration : `validate.js` affiche les noms officiels dans `route` (la saisie brute reste enregistrée) et `network.js` fusionne les orthographes. Hors contexte (arrêts), un nom n'est reconnu que s'il est unique dans le pays.
- **Admin** : « Redeyef (الرديف) », étiquette « non reconnue » et compte dans la note de l'onglet Réseau ; le CSV gagne `ville_depart_ar` et `ville_reconnue`.
- **À faire** : relecture de la liste par une personne qui connaît le terrain (orthographes issues d'OpenStreetMap, pas de source officielle).

## Pages légales

Trois pages (`/privacy`, `/terms`, `/legal`), écrites à partir de ce que le site fait réellement (données collectées, SMS, comparaison du visage, suppression des selfies dès la décision, brouillon local, journal d'accès). Le texte est dans `public/legal-text.js` (structure identique en arabe et en français, vérifiée par test) ; `public/legal.js` l'affiche.

- **Aucune identité inventée** : le nom de l'éditeur, son adresse, l'e-mail pour exercer ses droits, l'hébergeur et les durées de conservation viennent de variables d'environnement `LEGAL_*` (liste dans `deploy/portal.env.example`), exposées par `GET /api/legal`. En développement, une valeur absente s'affiche « [à compléter] » avec un avertissement ; **en production, le démarrage est refusé** tant que les variables obligatoires manquent (`legal.js`, `assertProductionConfig`).
- Le prestataire SMS cité (« Twilio (États-Unis) ») est déduit de `SMS_PROVIDER` : le numéro de téléphone quitte donc la Tunisie, ce que la politique dit.
- Droit invoqué : loi organique n° 2004-63 du 27 juillet 2004 (aucun numéro d'article cité, faute de pouvoir les vérifier ici).
- Changer un texte : modifier `legal-text.js` **et** `UPDATED` (date affichée), dans les deux langues.
- Les mentions légales citent OpenStreetMap (ODbL), exigé pour la liste des villes.

**Ce que ces textes ne sont pas** : une relecture juridique. Ils sont un projet sérieux à faire relire (juriste ou INPDP), et l'arabe par un locuteur natif. Les durées de conservation qu'ils annoncent sont appliquées par la purge automatique (section suivante).

## Service à service : application chauffeur

`POST /api/service/drivers/lookup` (un numéro) et `POST /api/service/drivers/approved` (la liste) exposent les chauffeurs **ACCEPTÉS et dont la collaboration n'est pas terminée**, avec des champs minimaux (jamais CIN, photo ni consentement) : voir `server.js`. Protégés par `APP_SERVICE_KEY` (en-tête `X-Service-Key`, comparaison en temps constant), désactivés (503) tant qu'elle est absente. C'est ce que lit [driver-app](../driver-app/README.md), le service séparé qui porte l'application chauffeur (file, places, SOS, réservations).

## Exploitation (application chauffeur)

L'onglet « Exploitation » de la console (`/admin`, comptes nominatifs) relaie `GET /api/admin/ops/overview` et les actions SOS vers `driver-app` (`APP_URL` + `APP_OPS_KEY`, différente de `APP_SERVICE_KEY`). L'acteur d'un accusé de réception SOS est toujours le compte connecté, jamais une valeur envoyée par le navigateur. Application chauffeur injoignable ou qui refuse la clé : message clair (503/502), le reste de la console continue de fonctionner.

## Comptes d'administration nominatifs et double authentification

Chaque personne de l'équipe a son compte (`/admin`). Le jeton partagé `ADMIN_TOKEN` ne sert plus qu'à **l'installation initiale** : dès le premier compte créé, il ne donne plus aucun accès.

- **Premier compte** : soit sur le serveur, `npm run admin -- create <identifiant>` (le premier compte est propriétaire), soit dans `/admin` avec le jeton, onglet « Comptes ». Le mot de passe provisoire s'affiche une seule fois.
- **Première connexion** : mot de passe provisoire (code vide), puis l'écran d'activation impose de **changer le mot de passe** et d'**activer la double authentification** (TOTP : Google Authenticator, Microsoft Authenticator, FreeOTP…). Tant que ce n'est pas fait, la session est limitée à ces deux actions. Huit **codes de secours** à usage unique sont affichés une seule fois.
- **Connexion** : identifiant + mot de passe + code à 6 chiffres. Réponse unique « identifiants invalides » quelle que soit la cause (compte inconnu, mot de passe, code, compte verrouillé ou désactivé). **5 échecs bloquent le compte 15 minutes** ; un code TOTP ne sert qu'une fois (rejeu refusé).
- **Sessions** côté serveur : fermées après 30 minutes d'inactivité ou 8 heures, à la déconnexion, au changement de mot de passe (autres appareils), à la désactivation ou au changement de rôle.
- **Rôles** : *propriétaire* (gère les comptes, journal, sécurité, suppression de dossiers) et *relecteur* (traite les dossiers, entretiens, réseau). On ne peut pas retirer le dernier propriétaire actif.
- **Journal nominatif** : chaque action de `admin_audit` porte le compte (`actor`) ; les connexions refusées aussi (jamais un nom saisi qui n'est pas un compte : c'est souvent un mot de passe mal placé).
- **Dépannage** : « mot de passe oublié » et « téléphone perdu » dans l'onglet Comptes (propriétaire) ; si plus aucun propriétaire ne peut entrer, sur le serveur : `npm run admin -- reset-password|reset-2fa|unlock <identifiant>`.
- **Stockage** : mot de passe haché (scrypt), secret TOTP chiffré avec `DATA_KEY` (la rotation de clé le rechiffre : `npm run rotate-key`), codes de secours hachés. Le détail d'un compte n'expose jamais ces valeurs.
- **Limites** : pas de QR code (la clé se saisit à la main ou via le lien `otpauth://` sur téléphone) ; pas de liste de mots de passe compromis ; pas de notification par e-mail ; `ADMIN_ALLOWED_IPS` reste recommandé.

## Notifications SMS (statut, entretien)

Désactivées par défaut : `SMS_NOTIFICATIONS=on` les active (chaque SMS coûte, et le numéro part chez le prestataire SMS). `notifications.js` met les SMS en **file d'attente** (table `notifications`) : un échec est réessayé (5 fois, délai croissant), un redémarrage ne perd rien.

- **Quand** : l'admin change le statut en *accepté*, *refusé* ou *entretien* ; le chauffeur réserve un entretien (confirmation) ; rappel `NOTIFY_REMINDER_HOURS` (3 par défaut) heures avant l'entretien, sauf s'il a été réservé à l'intérieur de ce délai. Retour à « en attente » : aucun SMS.
- **Contenu** : court, dans la langue du dossier, avec le lien de suivi (`PUBLIC_URL`). Jamais le motif d'un refus, le message de l'équipe ni le lien de visioconférence (ils restent sur la page de suivi). Le texte n'est pas stocké, il est composé à l'envoi.
- **Garde-fous** : plafond `NOTIFY_DAILY_CAP` SMS par 24 h (300 par défaut, compté à part des codes de vérification) ; 5 notifications par dossier et par jour au plus ; un SMS devenu faux avant l'envoi (statut rétabli, entretien annulé) est annulé ; **la confirmation d'entretien n'est envoyée que si la référence ET le téléphone correspondent à un dossier** (sinon n'importe qui ferait écrire à n'importe quel numéro).
- **Admin** : case « Prévenir le chauffeur par SMS » (cochée par défaut ; à décocher pour corriger une erreur de statut sans envoyer de SMS) et historique des SMS dans le détail du dossier.
- **Données** : le journal d'envoi (type, date, numéro) est supprimé après 30 jours, et avec le dossier à sa suppression. La politique de confidentialité le dit.

## Suppression et conservation des données

- **Le chauffeur supprime sa demande** depuis `/status` : bouton « Supprimer ma demande », puis code SMS envoyé au téléphone du dossier (même vérification que l'inscription). `POST /api/applications/delete` (référence + téléphone + jeton SMS à usage unique) efface le dossier, les pièces sur le disque, la vérification d'identité, les entretiens du même téléphone et les codes en attente, et prévient le backend KYC. Le journal garde seulement la référence (`ip = self`).
- **Purge automatique** (`retention.js`) : le serveur la lance 1 minute après le démarrage puis chaque jour, avec les durées `LEGAL_RETENTION_*` annoncées par la politique de confidentialité. Refusés : depuis la décision (`decided_at`). Abandonnés (en attente ou entretien sans activité) : depuis la dernière modification. Acceptés : **seulement après la fin de collaboration** marquée dans l'admin (`ended_at`, case « Collaboration terminée ») ; un chauffeur accepté actif n'est jamais supprimé. Sans durées (développement) : aucune purge.
- `npm run purge -- --dry-run` liste ce qui serait supprimé, `npm run purge` force un passage. Chaque suppression automatique est journalisée (`retention_purge_*`, `ip = system`, référence seulement).
- La suppression par l'admin efface désormais aussi les entretiens (avant, nom et téléphone y restaient).
- **Limites** : les sauvegardes gardent les données supprimées jusqu'à `KEEP_DAYS` (la politique l'annonce via `LEGAL_BACKUP_DAYS`) ; les dossiers refusés avant l'ajout de `decided_at` sont datés par leur dernière modification.

## Déploiement

Guide complet (serveur Linux, HTTPS automatique avec Caddy ou nginx, disque chiffré LUKS, secrets, sauvegardes chiffrées, recette) : **[deploy/DEPLOY.md](deploy/DEPLOY.md)**. Outils : `npm run secrets` (génère les secrets), `npm run check-config -- /etc/louage/portal.env` (vérifie la configuration avant démarrage), `deploy/smoke-test.sh <url>` (recette de sécurité), `deploy/backup.sh` (sauvegarde chiffrée).

## Intégration continue

Préparée mais **jamais exécutée** : il n'y a pas encore de dépôt git ni d'hébergement de code, donc rien ne tourne automatiquement. Tout est prêt à la racine du projet (`louage-express/`) :

- `.github/workflows/ci.yml` (GitHub Actions) : à chaque proposition de modification, sur la branche principale et chaque lundi, trois contrôles indépendants. **checks** : `npm run check` (hygiène) + `npm run test:coverage` (tests serveur, seuils : lignes 90 %, branches 80 %, fonctions 90 % ; actuellement 97 / 92 / 97 %). **e2e** : `npm run test:e2e` dans Chrome, avec `E2E_REQUIRE_BROWSER=1` pour qu'un navigateur absent fasse échouer au lieu d'« ignorer ». **audit** : `npm audit --omit=dev --audit-level=high`.
- `.github/dependabot.yml` : une proposition de mise à jour par semaine (portail, backend, actions GitHub), qui passe par la même CI.
- `npm run ci` : exactement le même enchaînement en local.
- `npm run check` (`tools/check-repo.js`) : fins de ligne LF (un script shell ou un fichier systemd en CRLF casse sur Linux), accolades CSS, syntaxe de tous les scripts, secrets collés par erreur (clés AWS/Twilio, clés privées, `DATA_KEY=...`), clés de traduction arabe/français identiques et toutes définies, liens et imports vers des fichiers qui existent, variables d'environnement lues par le code et décrites dans `deploy/*.env.example`.
- `.gitattributes`, `.editorconfig`, `.gitignore` : LF partout, pas de `node_modules`, `data/`, `.env`, sauvegardes ni clés dans git.

**Mise en route** (à faire par toi, je n'ai ni créé le dépôt ni rien publié) : créer un dépôt **privé** sur GitHub, `git init` à la racine de `louage-express/`, premier commit, `git push`. Ensuite, dans les réglages du dépôt : protéger la branche principale (CI obligatoire avant fusion) et activer Dependabot.

Limites : le workflow n'a pas pu être exécuté ici (pas de Linux, pas de GitHub) ; sa syntaxe est validée, ses commandes tournent en local sous Windows. Le premier passage sur GitHub peut révéler une différence Windows/Linux (chemins, Chrome sans bac à sable) à corriger. Les actions sont épinglées par version majeure (`@v4`), pas par empreinte : Dependabot les tient à jour. Le backend KYC n'a pas de tests et n'est pas dans la CI.

## Tests

| Commande | Ce qu'elle vérifie | Durée |
|---|---|---|
| `npm test` | 141 tests du serveur et des modules (validation, SMS, KYC, chiffrement et rotation de clé, sécurité, liste admin, déploiement), couverture ≈ 96 % | ~10 s |
| `npm run test:e2e` | 36 tests dans un **vrai navigateur** (Chrome ou Edge installé, aucun téléchargement) | ~100 s |

Les tests navigateur (`e2e/`) lancent un serveur isolé (base temporaire, SMS et vérification d'identité simulés, aucun appel sortant) et couvrent :
- l'**inscription complète sur téléphone** avec la **caméra simulée de Chrome** (3 poses réellement capturées, images distinctes), les six tampons, le chiffrement des pièces et ce qui est enregistré ;
- les règles du formulaire : champs vides, téléphone invalide, code SMS faux puis verrouillé, chiffres arabes, types de ligne (régional / interrégional / rural / national), doublon de CIN, passage arabe ↔ français sans perte de saisie ;
- **toutes les pages publiques** en français et arabe, thèmes clair et sombre, téléphone et ordinateur : aucune erreur de sécurité du navigateur (CSP), aucun défilement horizontal, **accessibilité automatique (axe-core) sans faille sérieuse ou critique**, boutons de l'accueil jamais recouverts, aperçu de lien lisible sans JavaScript ;
- le suivi de demande (aucune donnée personnelle dans les URL) et la réservation d'entretien ;
- la **console admin** : connexion, blocage après trop d'essais, filtres, compteurs, recherche, tri, pagination, « enregistrer et passer au suivant », ouverture des pièces chiffrées, journal d'accès, onglet réseau.

Si aucun navigateur n'est trouvé, les tests sont **ignorés avec un message** (jamais faussement verts) ; `E2E_CHANNEL=msedge` (ou `chrome`) force le choix. Ils ne couvrent pas : une vraie caméra de téléphone, Safari/Firefox, un lecteur d'écran, la 3G, ni l'envoi d'un vrai SMS.

## Brouillon sur le téléphone

Le formulaire garde la saisie **sur le téléphone du chauffeur** (jamais sur le serveur) pour ne pas tout retaper après une coupure de réseau, un rechargement ou une application fermée par le système. Code : `public/draft.js` (logique pure, testée seule) et `public/register.js`.

| | |
|---|---|
| **Gardé** | nom, téléphone, immatriculation, gouvernorat et station, type de ligne, ville de départ, arrêts en route, cases « prend des passagers en route » / « part incomplet » |
| **Jamais gardé** | photos (documents et selfies), **consentements** (à redonner à chaque fois), **numéro de CIN**, code SMS |
| **Durée** | 3 jours, puis effacé tout seul ; effacé aussi après un envoi réussi |
| **Contrôle** | un avis « Nous avons retrouvé votre brouillon, enregistré le … » avec le bouton « Effacer et recommencer » ; une phrase sous le titre annonce ce qui est gardé |
| **Téléphone vérifié** | le jeton de vérification est gardé pour l'**onglet** seulement (`sessionStorage`) : un rechargement ne coûte pas un second SMS ; un autre onglet doit refaire la vérification |

Choix de confidentialité (le téléphone peut être partagé) : la CIN n'est pas gardée (8 chiffres, donnée d'identité), ni les consentements (un consentement ne se pré-remplit pas). Tout ce qui est relu est **revalidé** (types, longueurs, valeurs autorisées) : un stockage modifié ou corrompu est ignoré et effacé, et le contenu est toujours traité comme du texte, jamais du HTML. Sans stockage disponible (navigation privée stricte), le formulaire fonctionne simplement sans brouillon. **À reprendre dans la politique de confidentialité** : « données saisies conservées sur votre appareil pendant 3 jours ».

## Console de validation (`/admin`)

- **Pastilles de statut avec compteurs** (Tous, En attente, Entretien, Accepté, Refusé) : les chiffres tiennent compte des autres filtres, pas du statut lui-même, pour voir d'un coup d'œil ce qui reste à traiter dans un gouvernorat ou un type de ligne.
- **Filtres** : gouvernorat (les 24), type de ligne (régional, interrégional, rural, national), état de l'identité (À examiner, Vérifiée, Erreur, En file, En cours, Non exécutée, Aucune vérification, avec le nombre de dossiers entre parenthèses), **recherche** par nom, téléphone, référence ou CIN. Les filtres se combinent (ET) et sont mémorisés pour la session ; « Réinitialiser les filtres » les efface.
- **Tri** : plus récents, plus anciens, nom, gouvernorat. **Pagination** par 50 dossiers.
- **Traiter vite** : dans un dossier, « Précédent / Suivant » parcourent la liste filtrée, et **« Enregistrer et passer au suivant »** enregistre la décision puis ouvre le dossier suivant (le dossier traité sort de la liste « En attente »).
- API : `GET /api/admin/applications?status=&governorate=&line_type=&kyc=&sort=&page=&page_size=&q=` renvoie `{applications, total, page, pages, counts}`. Une valeur inconnue ou répétée donne `400 {"error":"invalid_filter","field":"..."}` (jamais ignorée en silence). Le numéro de CIN n'est jamais renvoyé dans la liste ; le texte recherché n'est jamais écrit dans le journal d'accès.

## Partage et finitions

- **Aperçu de lien (WhatsApp, Facebook)** : chaque page porte `og:title`, `og:description`, `og:image` (1200×630, 120 Ko), `canonical` et `twitter:card`, en **arabe et français dans le même texte** (les robots de partage n'exécutent pas JavaScript, donc la langue ne peut pas dépendre du choix du visiteur). Les adresses doivent être absolues : le marqueur `%PUBLIC_URL%` des pages est remplacé par le serveur à partir de `PUBLIC_URL`.
- **Icônes** : `favicon.svg`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, et `site.webmanifest` (le chauffeur peut ajouter le site à l'écran d'accueil). Les PNG et l'image de partage se régénèrent avec `tools/make_share_assets.py`, à partir de la photo d'accueil (`public/img/hero-1376.webp`).
- **Page 404** : vraie page du site (arabe/français, jamais indexée) pour un navigateur ; l'API et les clients non navigateur gardent `{"error":"not_found"}`.
- **Sans JavaScript** : bandeau bilingue (le site en dépend pour afficher ses textes).
- `robots.txt` et `sitemap.xml` sont générés avec l'adresse publique ; l'admin et l'API n'y figurent pas.
- L'image de partage reprend la photo d'accueil générée par IA et porte la mention « Image illustrative ».

## Sécurité

**Ce qui est en place**
- **Refus de démarrer en production avec une configuration faible** : `ADMIN_TOKEN` < 32 caractères, `DATA_KEY`, `OTP_SECRET` (32), `KYC_SERVICE_KEY` (16) manquants, `KYC_BACKEND_URL` en http vers une autre machine, `SMS_PROVIDER` absent ou `console`. Toutes les erreurs sont listées d'un coup.
- **Chiffrement au repos des pièces** (AES-256-GCM, un IV aléatoire par fichier, falsification détectée) : un fichier volé sur le disque est illisible sans `DATA_KEY`. Chaque fichier enregistre l'**empreinte** de sa clé (jamais la clé). **Perdre `DATA_KEY` = perdre définitivement les pièces** : la sauvegarder séparément de la base.
- **Rotation de la clé de chiffrement** : `DATA_KEY` écrit, `DATA_KEY_PREVIOUS` lit seulement. `npm run rotate-key` rechiffre tous les fichiers (aussi ceux restés en clair), un par un : écriture dans un fichier temporaire, relecture et comparaison, puis renommage atomique ; l'original n'est jamais abîmé, l'outil est relançable après une coupure et n'arrête pas le site. `npm run rotate-key -- --status` montre où en sont les fichiers sans rien modifier. **Au démarrage, une clé erronée ou oubliée est détectée** (essai de lecture des pièces) : refus de démarrer en production, avertissement ailleurs, avec l'empreinte de la clé manquante. `GET /api/admin/security` donne le même état, sans aucune clé. Procédure complète : `deploy/DEPLOY.md`, section 9.
- **HTTPS forcé en production** : lecture redirigée (308), écriture refusée (400), HSTS, `upgrade-insecure-requests`.
- **Anti-CSRF** : une requête d'écriture venant d'un autre site (`Origin` / `Sec-Fetch-Site`) est refusée (403).
- **Admin** : jeton comparé en temps constant ; **10 mauvais jetons en 15 min bloquent l'IP** (les requêtes réussies ne comptent pas) ; liste blanche d'IP optionnelle ; **journal d'accès** (`GET /api/admin/audit`) : chaque consultation de dossier ou de pièce, avec l'IP et la référence, **sans aucune donnée personnelle**.
- **Réponses d'API jamais mises en cache ni indexées** (`Cache-Control: no-store`, `X-Robots-Tag: noindex`) ; pièces servies avec `Content-Security-Policy: sandbox` et `nosniff`.
- **Envois** : refus dès l'en-tête au-delà de 36 Mo, types vérifiés par octets magiques, 5 Mo par fichier, limites de champs ; `multer` 2.x.
- **Erreurs** : JSON invalide → 400, trop gros → 413, erreur interne → 500 sans trace d'appel ni détail.
- Déjà présents : CSP stricte (aucun script ou style en ligne), limitation de débit, SMS anti-détournement (quotas, plafond quotidien), codes SMS hachés (HMAC), jetons à usage unique, requêtes SQL paramétrées, aucun `innerHTML` avec des données utilisateur, export CSV protégé contre l'injection de formules.

**Ce qui n'est PAS couvert (à faire en ligne)**
- La **base SQLite** (noms, téléphones, numéros de CIN) n'est pas chiffrée par l'application : activer le chiffrement du disque (BitLocker / LUKS) et chiffrer les sauvegardes.
- Le jeton admin est **partagé** : le journal identifie l'IP, pas une personne. Comptes nominatifs + 2FA recommandés.
- Pas de durée de conservation automatique (INPDP) : à définir, par exemple suppression des dossiers refusés après un délai.
- Limitation de débit **par IP** : derrière le réseau mobile d'une gare, plusieurs chauffeurs peuvent partager la même IP (10 inscriptions par heure et par IP).
- Pas de test d'intrusion réalisé : ce travail est une revue de code et des tests automatiques, pas un audit externe.

## Ce qui est en place

- Validation côté serveur (téléphone tunisien, CIN à 8 chiffres, gouvernorat, rôle) ; codes d'erreur traduits côté client.
- Documents : type vérifié par **signature binaire** (pas l'extension), 5 Mo max, noms aléatoires, stockés hors de `public/` en mode `0600`, servis uniquement via l'admin. Les photos lourdes sont réduites dans le navigateur (économie de data 4G).
- La licence d'exploitation est facultative (un chauffeur propriétaire de son louage peut la joindre). Il n'y a pas de profil « propriétaire » : le site est réservé aux chauffeurs.
- Suivi : il faut **référence + téléphone**, et la réponse est identique que la référence n'existe pas ou que le téléphone ne corresponde pas (pas d'énumération).
- Entretien : créneaux générés côté serveur, un seul rendez-vous actif par téléphone, double réservation impossible (index unique).
- Sécurité : CSP stricte (scripts/styles `self` uniquement, aucun `innerHTML` avec des données utilisateur), limitation de débit, `helmet`, jeton admin comparé en temps constant, suppression d'une demande = ligne + fichiers. Pas de cookie de session ⇒ pas de surface CSRF.

## À faire avant d'accepter de vraies données

1. **Déclaration INPDP** (déjà prévue dans le plan) avant de collecter CIN, permis et téléphone.
2. **HTTPS obligatoire** (reverse proxy qui transmet `Host` et `X-Forwarded-Proto`) + `TRUST_PROXY` ; le serveur le force lui-même en production.
3. **Choisir et tester le fournisseur SMS** : le code Twilio est écrit et testé avec un faux serveur, mais **jamais essayé avec un vrai compte**. Vérifier la livraison réelle vers Ooredoo, Orange et Tunisie Télécom, le coût par SMS, et si un nom d'expéditeur doit être déclaré en Tunisie.
4. ~~Chiffrer au repos les CIN et documents~~ : fait pour les fichiers (`DATA_KEY`). Reste : chiffrement du disque pour la base, **durée de conservation**, sauvegardes chiffrées (voir la section Sécurité).
5. **Comptes admin nominatifs** (+ 2FA) à la place du jeton partagé.
6. **Données biométriques** : une comparaison faciale par AWS Rekognition envoie le visage et la CIN **hors de Tunisie** (région `eu-west-1` par défaut). Le texte de consentement le dit déjà, mais le transfert à l'étranger de données biométriques doit être couvert par l'INPDP avant tout usage réel. À inclure dans la question posée à l'avocat/à l'INPDP.
   - Configurer AWS côté backend (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REKOGNITION_REGION`) et **tester sur de vraies CIN** : l'OCR (Tesseract, anglais seul) n'a été essayé que sur des CIN synthétiques ; sur une photo floue, il peut ne pas retrouver le numéro (le dossier va alors en « À examiner », il n'est jamais refusé automatiquement).
   - **Tester la caméra sur un vrai téléphone** : la capture est vérifiée avec un flux simulé ; en production la page doit être en **HTTPS** (la caméra est refusée en HTTP hors localhost).
   - La vivacité (mouvement entre 3 photos) est une heuristique simple, pas un anti-usurpation certifié : une photo d'écran peut passer. D'où la décision humaine.
7. Meilleur outil de visio qu'un lien Jitsi public si les entretiens deviennent nombreux.
