-- ============================================================================
-- LOUAGE EXPRESS — SCHEMA RELATIONNEL POSTGRESQL + POSTGIS
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ----------------------------------------------------------------------------
-- USERS (Passagers & Chauffeurs)
-- ----------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('passenger', 'driver', 'admin');

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    role            user_role NOT NULL,
    full_name       VARCHAR(150) NOT NULL,
    phone_number    VARCHAR(20) UNIQUE NOT NULL,
    cin_number      VARCHAR(20) UNIQUE,               -- carte identité, chauffeurs
    license_plate   VARCHAR(20),                       -- null si passager
    sos_pin_voice   VARCHAR(50),                        -- mot-clé Derja vocal SOS
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- STATIONS (Gares louage — géolocalisées)
-- ----------------------------------------------------------------------------
CREATE TABLE stations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(150) NOT NULL,             -- ex: "Bab Alioua Tunis"
    governorate     VARCHAR(80) NOT NULL,
    location        GEOGRAPHY(POINT, 4326) NOT NULL,   -- lon/lat WGS84
    geofence_radius_m INTEGER NOT NULL DEFAULT 500,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stations_location ON stations USING GIST (location);

-- ----------------------------------------------------------------------------
-- LINES (Lignes officielles gare-à-gare, Hub & Spoke)
-- ----------------------------------------------------------------------------
CREATE TABLE lines (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    origin_station_id   UUID NOT NULL REFERENCES stations(id),
    destination_station_id UUID NOT NULL REFERENCES stations(id),
    official_price_dt   NUMERIC(6,3) NOT NULL,          -- prix légal État
    is_multi_leg        BOOLEAN NOT NULL DEFAULT FALSE,  -- correspondance
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- LOUAGES (Véhicules — statut, capacité, position GPS live)
-- ----------------------------------------------------------------------------
CREATE TYPE louage_status AS ENUM ('en_route', 'en_station_disponible', 'en_remplissage', 'complet_parti', 'hors_service');

CREATE TABLE louages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    driver_id       UUID NOT NULL REFERENCES users(id),
    license_plate   VARCHAR(20) NOT NULL,
    capacity        SMALLINT NOT NULL DEFAULT 8,
    status          louage_status NOT NULL DEFAULT 'hors_service',
    current_location GEOGRAPHY(POINT, 4326),
    last_ping_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_louages_location ON louages USING GIST (current_location);

-- ----------------------------------------------------------------------------
-- QUEUES (File d'attente dynamique par ligne — remplissage séquentiel strict)
-- ----------------------------------------------------------------------------
CREATE TABLE queues (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    line_id         UUID NOT NULL REFERENCES lines(id),
    louage_id       UUID NOT NULL REFERENCES louages(id),
    rank_in_queue   INTEGER NOT NULL,                   -- 1 = tête de file, remplit en premier
    seats_taken     SMALLINT NOT NULL DEFAULT 0,
    entered_queue_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (line_id, louage_id),
    UNIQUE (line_id, rank_in_queue)
);

CREATE INDEX idx_queues_line_rank ON queues (line_id, rank_in_queue);

-- ----------------------------------------------------------------------------
-- RESERVATIONS (Tickets — acompte prélevé via SVA)
-- ----------------------------------------------------------------------------
CREATE TYPE reservation_status AS ENUM ('pending_sva', 'confirmed', 'boarded', 'cancelled', 'refused');

CREATE TABLE reservations (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    passenger_id        UUID NOT NULL REFERENCES users(id),
    line_id             UUID NOT NULL REFERENCES lines(id),
    louage_id           UUID REFERENCES louages(id),      -- attribué par l'algo First-Available Seat
    deposit_amount_dt   NUMERIC(6,3) NOT NULL,             -- 1.500 ou 2.000 DT
    sva_operator        VARCHAR(20),                       -- TT / Ooredoo / Orange
    sva_transaction_ref VARCHAR(100),
    status              reservation_status NOT NULL DEFAULT 'pending_sva',
    qr_code             VARCHAR(150) UNIQUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- SOS_LOGS (Déclenchements urgence chauffeur — GPS + audio chiffré)
-- ----------------------------------------------------------------------------
CREATE TYPE sos_trigger_type AS ENUM ('physical_button', 'voice_keyword');

CREATE TABLE sos_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    louage_id       UUID NOT NULL REFERENCES louages(id),
    driver_id       UUID NOT NULL REFERENCES users(id),
    trigger_type    sos_trigger_type NOT NULL,
    location         GEOGRAPHY(POINT, 4326) NOT NULL,
    encrypted_audio_url VARCHAR(255),                    -- pointeur cloud, chiffré au repos
    resolved         BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sos_logs_unresolved ON sos_logs (resolved) WHERE resolved = FALSE;

-- ----------------------------------------------------------------------------
-- SYNC_QUEUE (Résilience Offline-First — buffer d'actions chauffeur en 4G coupée)
-- Miroir serveur de la table SQLite locale de l'app chauffeur. Chaque action
-- capturée hors-ligne est rejouée ici de façon idempotente à la reconnexion.
-- ----------------------------------------------------------------------------
CREATE TYPE sync_action_type AS ENUM ('board_passenger', 'sos_trigger', 'status_change');
CREATE TYPE sync_action_status AS ENUM ('pending', 'applied', 'conflict_rejected');

CREATE TABLE sync_queue (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_action_id    VARCHAR(100) NOT NULL,             -- UUID généré côté client (clé d'idempotence)
    louage_id           UUID NOT NULL REFERENCES louages(id),
    driver_id           UUID NOT NULL REFERENCES users(id),
    action_type         sync_action_type NOT NULL,
    payload             JSONB NOT NULL,                    -- ex: {lat, lon, triggerType} ou {}
    client_created_at   TIMESTAMPTZ NOT NULL,               -- horodatage local (avant coupure réseau)
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(), -- horodatage serveur (à la sync)
    status              sync_action_status NOT NULL DEFAULT 'pending',
    conflict_reason     VARCHAR(150),                       -- ex: 'seat_full_conflict'
    UNIQUE (client_action_id)                                -- rejoue = no-op si déjà appliqué
);

CREATE INDEX idx_sync_queue_pending ON sync_queue (status) WHERE status = 'pending';

-- ============================================================================
-- REQUÊTES SPATIALES D'EXEMPLE
-- ============================================================================

-- 1) Détecter si un louage donné est dans le rayon de 500m d'une station (geofencing)
--    ST_DWithin sur GEOGRAPHY = distance en mètres, index GIST utilisé automatiquement.
SELECT l.id AS louage_id, s.id AS station_id, s.name
FROM louages l
JOIN stations s ON ST_DWithin(l.current_location, s.location, s.geofence_radius_m)
WHERE l.id = :louage_id;

-- 2) Passage automatique au statut "en_station_disponible" dès entrée en geofence
UPDATE louages l
SET status = 'en_station_disponible'
FROM stations s
WHERE ST_DWithin(l.current_location, s.location, s.geofence_radius_m)
  AND l.status = 'en_route'
  AND l.id = :louage_id;

-- 3) Louage N°1 en tête de file pour une ligne donnée (cible du First-Available Seat)
SELECT q.*
FROM queues q
WHERE q.line_id = :line_id
ORDER BY q.rank_in_queue ASC
LIMIT 1;

-- 4) Stations les plus proches d'une position GPS (rayon 5km, triées par distance)
SELECT id, name, ST_Distance(location, ST_MakePoint(:lon, :lat)::geography) AS distance_m
FROM stations
WHERE ST_DWithin(location, ST_MakePoint(:lon, :lat)::geography, 5000)
ORDER BY distance_m ASC;
