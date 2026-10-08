// SQLite via le module intégré de Node (node:sqlite) — aucune dépendance native à compiler.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(here, "data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 }); // lisible par le seul compte du service

export const db = new DatabaseSync(path.join(DATA_DIR, "portal.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;  -- plusieurs processus écrivent (site, rotate-key) : attendre jusqu'à 5 s au lieu d'échouer sur « database is locked »

  CREATE TABLE IF NOT EXISTS applications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ref           TEXT NOT NULL UNIQUE,
    full_name     TEXT NOT NULL,
    phone         TEXT NOT NULL,
    cin           TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('driver','owner')),
    plate         TEXT NOT NULL,
    governorate   TEXT NOT NULL,
    station       TEXT NOT NULL,
    route         TEXT NOT NULL,
    lang          TEXT NOT NULL DEFAULT 'ar',
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','interview','approved','rejected')),
    public_note   TEXT,
    admin_note    TEXT,
    consent_at    TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_app_phone_active
    ON applications(phone) WHERE status <> 'rejected';
  CREATE UNIQUE INDEX IF NOT EXISTS ux_app_cin_active
    ON applications(cin) WHERE status <> 'rejected';

  CREATE TABLE IF NOT EXISTS files (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL,
    stored_name    TEXT NOT NULL,
    mime           TEXT NOT NULL,
    size           INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS interviews (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
    name           TEXT NOT NULL,
    phone          TEXT NOT NULL,
    slot_start     TEXT NOT NULL,           -- ISO avec offset +01:00 (heure de Tunis)
    room_url       TEXT NOT NULL,
    question       TEXT,
    status         TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','done','cancelled')),
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_interview_slot
    ON interviews(slot_start) WHERE status = 'booked';

  -- Résultat de la vérification d'identité (backend KYC). On ne garde que des indicateurs : jamais le texte OCR ni les images.
  CREATE TABLE IF NOT EXISTS kyc_checks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id  INTEGER NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','processing','verified','review','skipped','error')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,   -- ms epoch
    face_score      REAL,
    face_provider   TEXT,
    real_biometric  INTEGER,
    liveness_passed INTEGER,
    cin_match       INTEGER,                      -- le numéro lu par OCR sur la CIN = le numéro saisi
    ocr_confidence  REAL,
    reasons         TEXT NOT NULL DEFAULT '[]',
    error           TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- Vérification du téléphone par SMS. Les codes et jetons ne sont stockés que sous forme de hash.
  CREATE TABLE IF NOT EXISTS otp_codes (
    phone      TEXT PRIMARY KEY,
    code_hash  TEXT NOT NULL,
    expires_at INTEGER NOT NULL,           -- ms epoch
    attempts   INTEGER NOT NULL DEFAULT 0,
    sent_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS otp_sends (   -- journal des envois, pour les quotas par numéro et le plafond quotidien
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

// Migration légère : base créée avant l'ajout du consentement biométrique.
if (!db.prepare("PRAGMA table_info(applications)").all().some((c) => c.name === "consent_biometric_at")) {
  db.exec("ALTER TABLE applications ADD COLUMN consent_biometric_at TEXT");
}

// Circuit déclaré par le chauffeur (ville de départ -> gouvernorat d'arrivée) ; les anciennes demandes n'ont que `route`.
for (const [col, ddl] of [["line_type", "TEXT"], ["line_from", "TEXT"], ["line_to_gov", "TEXT"], ["line_via", "TEXT"], ["pickup_en_route", "INTEGER"], ["leaves_partial", "INTEGER"]]) {
  if (!db.prepare("PRAGMA table_info(applications)").all().some((c) => c.name === col)) db.exec(`ALTER TABLE applications ADD COLUMN ${col} ${ddl}`);
}

// Comptes d'administration nominatifs, sessions côté serveur et codes de secours de la double authentification.
// Jamais de mot de passe, de secret TOTP ni de code de secours en clair : hash scrypt, secret scellé (AES-GCM), hash SHA-256.
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    username             TEXT NOT NULL UNIQUE,
    display_name         TEXT NOT NULL,
    role                 TEXT NOT NULL CHECK (role IN ('owner','reviewer')),
    password_hash        TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    totp_secret          TEXT,
    totp_pending         TEXT,
    totp_enabled         INTEGER NOT NULL DEFAULT 0,
    totp_last_step       INTEGER NOT NULL DEFAULT -1,
    failed_attempts      INTEGER NOT NULL DEFAULT 0,
    locked_until         INTEGER NOT NULL DEFAULT 0,
    active               INTEGER NOT NULL DEFAULT 1,
    created_at           TEXT NOT NULL,
    last_login_at        TEXT
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    scope      TEXT NOT NULL CHECK (scope IN ('setup','full')),
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_recovery_codes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at   TEXT
  );
`);
// File d'attente des SMS de notification (statut, entretien). Le texte n'est pas stocké : il est composé à l'envoi.
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id  INTEGER REFERENCES applications(id) ON DELETE CASCADE,
    phone           TEXT NOT NULL,
    lang            TEXT NOT NULL DEFAULT 'ar',
    kind            TEXT NOT NULL,
    params          TEXT NOT NULL DEFAULT '{}',
    dedupe_key      TEXT UNIQUE,
    status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','skipped')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    sent_at         TEXT,
    error           TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_notifications_due ON notifications(status, next_attempt_at);
`);

// Conservation : date de la décision (accepté / refusé) et de la fin de collaboration avec un chauffeur accepté. Elles déclenchent la purge automatique.
for (const col of ["decided_at", "ended_at"]) {
  if (!db.prepare("PRAGMA table_info(applications)").all().some((c) => c.name === col)) db.exec(`ALTER TABLE applications ADD COLUMN ${col} TEXT`);
}

// Chiffrement des pièces au repos : 1 = fichier chiffré avec DATA_KEY, 0 = en clair (développement ou fichiers anciens).
if (!db.prepare("PRAGMA table_info(files)").all().some((c) => c.name === "enc")) {
  db.exec("ALTER TABLE files ADD COLUMN enc INTEGER NOT NULL DEFAULT 0");
}

// Empreinte de la clé qui a chiffré chaque fichier (rotation de DATA_KEY). NULL = fichier créé avant l'introduction des empreintes.
if (!db.prepare("PRAGMA table_info(files)").all().some((c) => c.name === "key_id")) {
  db.exec("ALTER TABLE files ADD COLUMN key_id TEXT");
}

// Journal d'accès de l'administration : qui a consulté quoi. Ni nom, ni téléphone, ni CIN : seulement la référence du dossier.
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_audit (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ip     TEXT NOT NULL,
    action TEXT NOT NULL,
    ref    TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_admin_audit_at ON admin_audit(at);
`);
// Le journal d'accès devient nominatif : qui (compte), depuis où (IP), a fait quoi sur quel dossier.
if (!db.prepare("PRAGMA table_info(admin_audit)").all().some((c) => c.name === "actor")) {
  db.exec("ALTER TABLE admin_audit ADD COLUMN actor TEXT");
}

