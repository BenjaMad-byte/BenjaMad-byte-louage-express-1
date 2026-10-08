# Louage Express — Architecture Système

## Diagramme de flux (micro-services)

```mermaid
flowchart LR
    subgraph Clients
        PA[App Passager]
        DA[App Chauffeur]
        GA[Dashboard Gare]
    end

    GW[API Gateway]

    subgraph Services
        QS[Service File d'Attente\n(Queue Service)]
        RS[Service Réservations\n(First-Available Seat)]
        SVA[Service SVA Télécom\nTT / Ooredoo / Orange]
        SOS[Service SOS Urgence]
        GEO[Service Geofencing\nRedis + PostGIS]
    end

    DB[(PostgreSQL + PostGIS)]
    REDIS[(Redis — positions live)]
    OPS[Opérateurs Télécom\nAPI SVA/USSD]
    EMR[Secours\nPolice 197 / SAMU 198]

    PA -->|POST /reservations| GW
    DA -->|GPS ping| GW
    DA -->|POST /driver/sos| GW
    GA -->|lecture live| GW

    GW --> RS
    GW --> SOS
    GW --> QS

    RS --> QS
    RS --> SVA
    RS --> DB
    SVA <-->|callback prélèvement| OPS

    DA -->|GPS stream| GEO
    GEO --> REDIS
    GEO -->|ST_DWithin 500m| DB
    GEO --> QS

    SOS --> DB
    SOS -->|GPS + audio chiffré prioritaire| EMR

    QS --> DB
```

## Rôle de chaque service

| Service | Responsabilité |
| --- | --- |
| **API Gateway** | Auth, rate-limit, routage vers micro-services |
| **Queue Service** | Maintient le rang de chaque louage par ligne, applique le remplissage séquentiel strict |
| **Reservation Service** | Implémente "First-Available Seat" — injecte la réservation dans le Louage N°1 |
| **SVA Service** | Intègre les 3 opérateurs (TT/Ooredoo/Orange), gère prélèvement + webhook confirmation |
| **Geofencing Service** | Ingère les pings GPS chauffeur, calcule ST_DWithin, publie changement de statut station |
| **SOS Service** | Reçoit déclenchement urgence, priorise transmission GPS + flux audio chiffré vers secours |
| **Sync Service** | Rejoue le buffer d'actions offline-first du chauffeur, résout les conflits de sièges |

## Geofencing Temps Réel — Redis GEO

**Pourquoi Redis plutôt que PostGIS pour le geofencing live** : `ST_DWithin` sur PostgreSQL reste la source de vérité batch/analytique (rapports, audit), mais interroger Postgres à chaque ping GPS (des centaines de véhicules, ping toutes les 5-10s) ajoute une charge inutile sur la DB transactionnelle. Redis GEO tient l'index spatial **en mémoire** et répond en <1ms, adapté au flux temps réel.

**Implémentation** ([backend/src/geo.js](../backend/src/geo.js)) : un seul sorted-set géospatial `louage:geo:index` contient stations et louages, membres préfixés (`station:<id>`, `louage:<id>`).

- `GEOADD louage:geo:index <lon> <lat> station:<id>` — seed des gares au démarrage.
- `GEOADD louage:geo:index <lon> <lat> louage:<id>` — à chaque ping GPS chauffeur (`POST /api/v1/driver/gps-ping`).
- `GEOSEARCH louage:geo:index FROMMEMBER louage:<id> BYRADIUS 500 m ASC WITHDIST` — détecte les gares dans le rayon, triées par distance, en une seule commande O(log N).

**Bascule automatique de statut** : si le louage entre dans le rayon d'une gare alors que son statut est `en_route`, il passe à `en_station_disponible` (déclenche la réapparition dans la file d'attente gare, cf. Queue Service).

**Résilience sans Redis** : `findStationsNearLouage()` retombe sur un calcul haversine pur JS si Redis ne répond pas au démarrage (`redisAvailable = false`) — le prototype reste fonctionnel en dev sans dépendance dure, mais bascule sur Redis dès qu'il est joignable. `GET /health` expose le moteur actif (`geoEngine: "redis" | "js-fallback"`).

**Lancer Redis en local** :
```bash
docker run -d --name louage-redis -p 6379:6379 redis:7-alpine
# ou, sans Docker : WSL + `sudo apt install redis-server && redis-server`
```
Le backend lit `REDIS_URL` (défaut `redis://127.0.0.1:6379`).

## KYC Biométrique Chauffeur — `POST /api/v1/auth/driver/verify-identity`

Pipeline de vérification d'identité à l'inscription chauffeur : OCR documents + liveness + face-match, avec auto-validation si score > 95%.

```
[selfieFrames[], cinPhoto, permisPhoto?] → POST /verify-identity
   ├─ OCR (Tesseract.js)      → CIN lisible ? numéro/date extraits ?
   ├─ Liveness (frame-diff)   → mouvement réel entre frames du selfie dynamique ?
   ├─ Face Match (perceptual hash) → score de similarité selfie vs photo CIN
   └─ Décision : score > 0.95 ET liveness OK ET CIN lisible → status = "verified" (auto)
                sinon → status = "pending_manual_review" + reasons[]
```

**Face-match : AWS Rekognition CompareFaces (réel) avec fallback dev**

[backend/src/kyc/faceMatch.js](../backend/src/kyc/faceMatch.js) appelle [providers/awsRekognition.js](../backend/src/kyc/providers/awsRekognition.js) — vraie reconnaissance biométrique (détection + embedding + comparaison via `CompareFacesCommand`), credentials résolus par la chaîne standard AWS SDK v3 (env, rôle IAM, profil partagé). Similarité AWS (0-100) convertie en score 0-1.

Si AWS échoue (pas de credentials, quota, coupure réseau, timeout 8s) : fallback automatique vers [providers/phashFallback.js](../backend/src/kyc/providers/phashFallback.js) — perceptual hash (similarité d'image, **pas de la biométrie**). **Garde-fou de sécurité** : `isRealBiometric: false` bloque systématiquement l'auto-validation dans [routes/kycVerify.js](../backend/src/routes/kycVerify.js), quel que soit le score — jamais de compte auto-validé sur le fallback seul, toujours revue manuelle.

Testé : mapping de réponse AWS validé (meilleur `FaceMatches[].Similarity` retenu, cas `UnmatchedFaces` géré) ; fallback + blocage auto-approve validés en environnement sans credentials AWS.

Alternatives équivalentes si besoin de changer de cloud : Azure Face API (`Face - Verify`), Onfido / Regula Face SDK (spécialisés KYC réglementé) — même interface à respecter dans `faceMatch.js`.

De même, [backend/src/kyc/liveness.js](../backend/src/kyc/liveness.js) ne détecte qu'un mouvement brut entre frames (anti "photo figée envoyée 2 fois") — ce n'est pas un anti-spoofing certifié (pas de détection d'écran re-photographié, pas d'analyse de profondeur/texture peau). Remplacer par un SDK liveness dédié (AWS Rekognition Face Liveness, FaceTec, iProov) en production.

L'OCR ([backend/src/kyc/ocr.js](../backend/src/kyc/ocr.js)), lui, est une **vraie extraction de texte** (Tesseract.js) — testé et fonctionnel sur un visuel CIN de test (numéro 8 chiffres + date extraits correctement).

**Intégration avec le portail chauffeurs** ([driver-portal](../driver-portal/README.md)) : le portail appelle cette route en tâche de fond après chaque inscription (CIN recto + 3 selfies), avec la clé de service `KYC_SERVICE_KEY` (en-tête `X-Service-Key`, obligatoire en production). Il compare en plus le numéro lu par OCR au numéro saisi, ne conserve que des indicateurs, puis appelle `DELETE /api/v1/auth/driver/verify-identity/:driverId` pour que le backend efface le texte OCR gardé en mémoire. Le résultat est une aide à la décision : jamais d'acceptation automatique.

## Architecture Offline-First — App Chauffeur

**Problème** : coupures 4G fréquentes en zones enclavées (Redeyef, Tabarka, zones inter-gouvernorats). L'app chauffeur ne peut pas bloquer les actions terrain (+1 Passager, SOS) en attendant le réseau.

**Principe** : chaque action critique est d'abord écrite en local (SQLite sur device) avec un `client_action_id` (UUID v4 généré client) et un `client_created_at`. L'app tente l'envoi immédiat ; en échec réseau, l'action reste `pending` dans la table locale et une icône "Hors-ligne · N actions en attente" s'affiche.

```
[Tap chauffeur] → écriture SQLite locale (status=pending, client_action_id=uuid())
                → tentative POST immédiate
                     ├─ succès réseau → status=synced, retrait du buffer local
                     └─ échec réseau  → reste pending, retry en arrière-plan (backoff)
                                       → si SOS : bascule SMS de secours (paquet GPS compact via USSD/SMS gateway)
```

**Synchronisation au retour réseau** : `POST /api/v1/sync/offline-buffer` reçoit le buffer complet trié par `client_created_at` et le rejoue séquentiellement.

**Résolution de conflits (sièges)** — le cas critique est le sur-remplissage : deux chauffeurs (ou le chauffeur + une réservation en ligne concurrente) déclarent des passagers alors que le louage était déjà proche de sa capacité au moment de la coupure.

1. **Idempotence d'abord** : `client_action_id` est `UNIQUE` dans `sync_queue` — si l'action a déjà été appliquée (rejeu réseau, double-tap), elle est ignorée silencieusement (no-op), jamais réappliquée.
2. **Ordre logique, pas horloge device** : les actions sont rejouées dans l'ordre de `client_created_at` (horloge locale du chauffeur), pas dans l'ordre d'arrivée réseau — évite qu'une action tardive à arriver mais plus ancienne écrase un état plus récent.
3. **Capacité = source de vérité serveur** : chaque `board_passenger` rejoué est appliqué avec le même check `seats_taken < capacity` que le flux temps réel. Si la capacité est déjà atteinte par des actions appliquées avant elle dans le rejeu, l'action est marquée `conflict_rejected` avec `conflict_reason = 'seat_full_conflict'` — **jamais de dépassement de capacité silencieux**.
4. **Restitution passager en cas de conflit** : une action rejetée pour un passager qui avait déjà payé (réservation en ligne confirmée pendant que le chauffeur était offline) déclenche un remboursement automatique de l'acompte SVA + notification de ré-assignation au louage suivant dans la file.
5. **SOS jamais bloqué par un conflit** : `sos_trigger` n'a pas de notion de capacité — toujours appliqué, priorité absolue, jamais mis en `conflict_rejected`.
