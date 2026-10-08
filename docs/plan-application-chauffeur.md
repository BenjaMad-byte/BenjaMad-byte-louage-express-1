# Plan : application chauffeur (PWA) et service d'exploitation

> Établi le 8 octobre 2026. Décisions de l'utilisateur : **application web installable (PWA) d'abord**, **service séparé** du site d'inscription, première version avec **file et places, SOS, arrêts et places par tronçon, réservations et paiement SVA**.
>
> **État au 8 octobre 2026 (même session) : phases A à F codées et testées** (moteur de règles, file, hors ligne, SOS, réservations/SVA simulé, onglet Exploitation). 165 tests (89 serveur + 76 application, dont un test de parité serveur/téléphone sur 300 suites aléatoires) et 67 parcours navigateur, tous verts. **Rien n'a tourné sur un vrai téléphone, un vrai réseau SMS ni un vrai opérateur.** Phase G (CI, déploiement) commencée : voir [driver-app/README.md](../driver-app/README.md) pour le détail technique et les limites assumées (SOS ≠ secours réels, PWA ≠ natif, aucun opérateur SVA branché).
>
> **Revu le 8 octobre 2026 (même session) : connexion changée pour matricule + mot de passe.** Décision de l'utilisateur : à l'acceptation du dossier, un lien personnel à usage unique part par SMS pour installer l'application ; le chauffeur y choisit son mot de passe et se connecte ensuite au quotidien avec **matricule + mot de passe**, pas un code SMS à chaque fois (le matricule n'est pas secret, seul le mot de passe l'est, et c'est le chauffeur qui le choisit). Le téléphone ne sert plus qu'à l'activation et à la récupération d'un mot de passe oublié — voir [driver-app/README.md § Connexion](../driver-app/README.md#connexion) pour le détail.

## 1. Ce que c'est, ce que ce n'est pas

**C'est** : l'application qu'un chauffeur *déjà accepté* ouvre sur son téléphone pour (1) se mettre dans la file d'une gare, (2) voir son rang, (3) déclarer ses passagers en un geste, y compris **sans réseau**, (4) gérer ses places par tronçon quand il prend des passagers en route, (5) déclencher une alerte SOS, (6) recevoir et valider les réservations en ligne.

**Ce n'est pas** : l'application passager (seulement une page de démonstration pour tester la boucle), ni un contrat avec les opérateurs télécom (le paiement SVA est branché sur une **simulation**), ni un service de secours (aucun lien avec la Police ou la Protection civile : voir §6).

## 2. Architecture

```
Téléphone (PWA)  ──HTTPS──►  driver-app (service, SQLite propre)  ──clé de service──►  driver-portal (chauffeurs acceptés)
  IndexedDB + file d'actions        │                                                      /api/service/drivers/*
  moteur de places (engine.js)      ├─ SMS (même fournisseur que le portail) : codes, alertes SOS
                                    └─ SVA (fournisseur simulé, interface prête pour un vrai opérateur)
Équipe : onglet « Exploitation » de la console d'administration du portail (comptes nominatifs + 2FA) ──clé de service──► driver-app
```

- **Un seul moteur de règles** : `engine.js` est un module pur, utilisé **par le serveur (autorité) et par le téléphone (affichage immédiat hors ligne)**. Les deux ne peuvent pas diverger.
- **Pas de géorepérage dans cette version** : les données OpenStreetMap ne listent que 109 gares, mal classées (taxis, transport rural). Le chauffeur déclare « je suis à la gare ». La position GPS sert au SOS.
- **Service séparé** : cohérent avec la décision « la gestion des places n'est pas dans le site d'inscription ». Le site d'inscription n'expose que des champs minimaux (jamais CIN, photos, consentements).

## 3. Modèle de données (SQLite)

| Table | Rôle |
|---|---|
| `drivers` | copie minimale d'un chauffeur accepté : référence du portail, téléphone, nom, plaque (identifiant de connexion), ligne déclarée, capacité (8 par défaut), mot de passe (hash, choisi par le chauffeur) |
| `activations` | lien d'activation en attente (hash du jeton, expiration, usage unique) envoyé par SMS à l'acceptation |
| `sessions` | jeton de session de l'appareil (hash seulement), 30 jours glissants, révocable |
| `lines` | ligne = gare de départ + destination, clé normalisée avec la même reconnaissance de villes que le portail |
| `trips` | un voyage d'un louage : arrêts, rang dans la file, état (`queued` → `filling` → `en_route` → `done`), arrêt courant |
| `boardings` | un passager : arrêt de montée et de descente, source (`cash` ou `reservation`), état |
| `reservations` | réservation en ligne : code, tronçon demandé, acompte, état SVA, expiration de la retenue |
| `sos_events` | alerte : position, déclenchement, accusé de réception, résolution |
| `sync_log` | actions déjà appliquées (idempotence) |

## 4. Règles métier (le cœur)

1. **Places par tronçon.** Un voyage a des arrêts `[A, B, C, D]` et donc des tronçons `A→B, B→C, C→D`. Un passager occupe les tronçons entre sa montée et sa descente. On peut ajouter un passager si **chaque** tronçon concerné a une place libre. C'est la règle de la billetterie d'autocar.
2. **Remplissage séquentiel strict.** Dans la file d'une ligne, le n° 1 reçoit les réservations tant qu'il a de la place ; le n° 2 ne reçoit rien avant. Le n° 1 plein, le suivant passe n° 1 quand il part.
3. **Réservation d'un arrêt intermédiaire.** Elle va au voyage **déjà parti** qui n'a pas dépassé l'arrêt de montée (le plus proche), avec de la place sur le tronçon.
4. **Hors ligne.** Chaque action du chauffeur reçoit un identifiant unique et un numéro d'ordre sur l'appareil ; le serveur les rejoue **dans cet ordre** (pas selon l'horloge du téléphone, souvent fausse), une seule fois chacune.
5. **Un passager physiquement monté gagne toujours.** Si un chauffeur hors ligne déclare un passager et que, entre-temps, des réservations non encore montées ont rempli le voyage, c'est la **réservation** la moins ancienne qui est déplacée (autre voyage) ou remboursée, jamais le passager déjà assis. *Écart assumé avec la note d'architecture initiale (`db/architecture.md`), qui rejetait l'action du chauffeur.*
6. **Dépassement impossible** : au-delà de la capacité réelle, l'action est refusée et signalée, jamais appliquée silencieusement.
7. **SOS jamais bloqué** : aucune règle de capacité, priorité absolue, idempotent.

## 5. Phases

| Phase | Contenu | Critère de fin |
|---|---|---|
| A | Site d'inscription : points d'accès de service (chauffeurs acceptés) ; service `driver-app` : base, connexion par matricule + mot de passe (activation par lien SMS, récupération par code SMS), sessions | Un chauffeur accepté active son compte et se connecte ; un autre est refusé ; la suppression de sa demande ferme son compte |
| B | `engine.js` + file + voyages + synchronisation hors ligne | Tests de propriété : jamais plus de passagers que de places, quel que soit l'ordre ; rejeu idempotent |
| C | PWA : écrans, IndexedDB, service worker, installation | Parcours complet **en mode avion** (Playwright), puis reconnexion et synchronisation |
| D | SOS : déclenchement, file hors ligne, alertes SMS répétées jusqu'à accusé de réception | Alerte reçue et accusée ; relance si personne ne répond |
| E | Onglet « Exploitation » dans la console d'administration (file, voyages, SOS, comptes) | Accusé de réception d'un SOS depuis la console |
| F | Réservations, SVA simulé, retenue de place avec expiration, code à valider par le chauffeur, page de démonstration passager | Boucle complète : réserver → payer (simulé) → code → montée |
| G | CI, documentation, déploiement | Les deux paquets passent la CI |

## 6. Ce que cette application ne peut PAS faire (à lire avant le pilote)

- **SOS ≠ secours.** Il n'existe pas d'API publique pour alerter la Police (197) ou la Protection civile (198). L'alerte part **par SMS vers des numéros de permanence que l'équipe choisit** et s'affiche dans la console. **Ne pas le présenter aux chauffeurs comme une protection tant qu'une personne n'est pas réellement de garde, avec une procédure écrite.** L'application propose aussi des boutons « appeler » (le chauffeur touche pour composer).
- **PWA** : pas de bouton physique, pas de GPS quand l'écran est éteint ou l'application fermée, pas de SMS de secours automatique si le réseau est coupé. Seule une application Android native lèverait ces limites.
- **Paiement** : aucune connexion réelle aux opérateurs (Tunisie Telecom, Ooredoo, Orange). Le circuit des fonds (qui encaisse, comment le chauffeur est payé, remboursements) dépend d'un contrat et reste à définir.
- **Gares** : pas de liste officielle ni de géorepérage ; une gare existe parce qu'un chauffeur la déclare.
- **Position partagée** : jamais de suivi permanent ; la position n'est lue que pour un SOS.
