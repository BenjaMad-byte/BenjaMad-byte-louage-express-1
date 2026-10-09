// Base SQLite du service d'application chauffeur. Séparée de celle du site d'inscription : on n'y copie que le strict nécessaire d'un chauffeur accepté.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(here, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "app.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
  -- Chauffeur accepté (copie minimale lue depuis le site d'inscription : jamais de CIN ni de photo).
  -- Connexion au quotidien : matricule + mot de passe (le matricule n'est pas secret, peint sur la voiture ; le mot de passe l'est).
  -- Le téléphone sert à ACTIVER le compte (lien personnel) et à le RÉCUPÉRER (mot de passe oublié), jamais à la connexion de tous les jours.
  CREATE TABLE IF NOT EXISTS drivers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    portal_ref       TEXT NOT NULL UNIQUE,
    phone            TEXT NOT NULL UNIQUE,
    full_name        TEXT NOT NULL,
    plate            TEXT NOT NULL,
    plate_normalized TEXT NOT NULL,
    lang             TEXT NOT NULL DEFAULT 'ar',
    governorate      TEXT NOT NULL,
    station          TEXT NOT NULL,
    line_type        TEXT,
    line_from        TEXT,
    line_to_gov      TEXT,
    line_via         TEXT NOT NULL DEFAULT '[]',
    pickup_en_route  INTEGER NOT NULL DEFAULT 0,
    leaves_partial   INTEGER NOT NULL DEFAULT 0,
    capacity         INTEGER NOT NULL DEFAULT 8 CHECK (capacity BETWEEN 1 AND 8),
    active           INTEGER NOT NULL DEFAULT 1,
    password_hash    TEXT,                          -- NULL = compte pas encore activé (aucune connexion possible)
    failed_attempts  INTEGER NOT NULL DEFAULT 0,
    locked_until     INTEGER NOT NULL DEFAULT 0,
    approved_at      TEXT,
    synced_at        TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    last_seen_at     TEXT
  );
  -- Un seul compte actif par matricule (le matricule, pas le téléphone, est l'identifiant de connexion).
  CREATE UNIQUE INDEX IF NOT EXISTS ux_drivers_plate_active ON drivers(plate_normalized) WHERE active = 1;

  -- Lien d'activation envoyé par SMS à l'acceptation : personnel, à usage unique, expire au bout de quelques jours.
  CREATE TABLE IF NOT EXISTS activations (
    token_hash TEXT PRIMARY KEY,
    driver_id  INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS ix_activations_driver ON activations(driver_id);

  -- Session d'un appareil : seul le hash du jeton est stocké.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    driver_id  INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    device     TEXT,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  -- Ligne = gare de départ + destination (clé normalisée par la reconnaissance de villes du site d'inscription).
  CREATE TABLE IF NOT EXISTS lines (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    key       TEXT NOT NULL UNIQUE,
    from_gov  TEXT NOT NULL,
    from_name TEXT NOT NULL,
    to_gov    TEXT,
    line_type TEXT
  );

  -- Un voyage d'un louage. 'queued' = dans la file de la gare (rang calculé), 'en_route', 'done', 'cancelled'.
  CREATE TABLE IF NOT EXISTS trips (
    id           TEXT PRIMARY KEY,
    driver_id    INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    line_id      INTEGER NOT NULL REFERENCES lines(id),
    status       TEXT NOT NULL CHECK (status IN ('queued','en_route','done','cancelled')),
    queue_seq    INTEGER NOT NULL,
    capacity     INTEGER NOT NULL,
    stops        TEXT NOT NULL,
    current_stop INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    departed_at  TEXT,
    ended_at     TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_trips_one_open_per_driver ON trips(driver_id) WHERE status IN ('queued','en_route');
  CREATE INDEX IF NOT EXISTS ix_trips_line_status ON trips(line_id, status, queue_seq);

  CREATE TABLE IF NOT EXISTS boardings (
    id             TEXT PRIMARY KEY,
    trip_id        TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    from_idx       INTEGER NOT NULL,
    to_idx         INTEGER NOT NULL,
    source         TEXT NOT NULL CHECK (source IN ('cash','reservation')),
    status         TEXT NOT NULL,
    created_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_boardings_trip ON boardings(trip_id);

  -- Actions déjà appliquées (idempotence) : une action rejouée ne s'applique jamais deux fois.
  CREATE TABLE IF NOT EXISTS sync_log (
    client_action_id TEXT PRIMARY KEY,
    driver_id        INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    client_seq       INTEGER,
    type             TEXT NOT NULL,
    status           TEXT NOT NULL,
    reason           TEXT,
    result           TEXT,
    received_at      TEXT NOT NULL
  );

  -- Alertes SOS. Aucune règle de capacité ne s'y applique : toujours enregistrées.
  CREATE TABLE IF NOT EXISTS sos_events (
    id                TEXT PRIMARY KEY,
    driver_id         INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    trip_id           TEXT,
    client_action_id  TEXT NOT NULL UNIQUE,
    lat               REAL,
    lon               REAL,
    accuracy_m        REAL,
    position_age_s    INTEGER,
    trigger           TEXT NOT NULL,
    client_created_at TEXT,
    received_at       TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','ack','resolved','cancelled')),
    ack_by            TEXT,
    ack_at            TEXT,
    resolved_at       TEXT,
    note              TEXT,
    alerts_sent       INTEGER NOT NULL DEFAULT 0,
    last_alert_at     INTEGER
  );
  CREATE INDEX IF NOT EXISTS ix_sos_open ON sos_events(status, received_at);

  -- Réservations en ligne (acompte prélevé par SVA). La place est retenue dans le voyage (boardings, statut 'reserved').
  CREATE TABLE IF NOT EXISTS reservations (
    id               TEXT PRIMARY KEY,
    code             TEXT NOT NULL UNIQUE,
    line_id          INTEGER NOT NULL REFERENCES lines(id),
    trip_id          TEXT REFERENCES trips(id) ON DELETE SET NULL,
    from_name        TEXT NOT NULL,
    to_name          TEXT NOT NULL,
    boarding_id      TEXT,
    lang             TEXT NOT NULL DEFAULT 'ar',
    passenger_phone  TEXT NOT NULL,
    deposit_millimes INTEGER NOT NULL,
    operator         TEXT,
    sva_ref          TEXT,
    status           TEXT NOT NULL CHECK (status IN ('pending_sva','confirmed','boarded','cancelled','refunded','no_show','displaced')),
    hold_expires_at  INTEGER,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_reservations_status ON reservations(status, hold_expires_at);

  -- Vérification du téléphone par SMS (mêmes tables et même service que le site d'inscription).
  CREATE TABLE IF NOT EXISTS otp_codes (
    phone      TEXT PRIMARY KEY,
    code_hash  TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    sent_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS otp_sends (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_otp_sends_phone_at ON otp_sends(phone, at);
  CREATE INDEX IF NOT EXISTS ix_otp_sends_at ON otp_sends(at);
  CREATE TABLE IF NOT EXISTS phone_verifications (
    token_hash TEXT PRIMARY KEY,
    phone      TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
  );
`);

/** Exécute `fn` dans une transaction : tout ou rien. */
export function transaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
