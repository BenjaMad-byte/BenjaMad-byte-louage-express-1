import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-retention-"));
process.env.DATA_DIR = dataDir;
let db, UPLOAD_DIR, createUploadStore, retention, uploads;
before(async () => {
  ({ db, UPLOAD_DIR } = await import("../db.js"));
  ({ createUploadStore } = await import("../uploads.js"));
  retention = await import("../retention.js");
  uploads = createUploadStore({ dir: UPLOAD_DIR, key: null });
});
after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const t of ["interviews", "kyc_checks", "files", "applications", "otp_codes", "phone_verifications", "admin_audit"]) db.exec(`DELETE FROM ${t}`);
});

const NOW = Date.parse("2026-10-07T12:00:00Z");
let n = 0;
/** Insère un dossier ; `at` = date de création et de modification. */
function addApp({ status = "pending", at = "2026-10-01T00:00:00.000Z", decided_at = null, ended_at = null, phone, files = 0 } = {}) {
  n += 1;
  const p = phone ?? `9${String(n).padStart(7, "0")}`;
  const ref = `LX-T${String(n).padStart(7, "0")}`;
  const id = Number(db.prepare(
    "INSERT INTO applications (ref, full_name, phone, cin, role, plate, governorate, station, route, consent_at, status, created_at, updated_at, decided_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(ref, "Test", p, `0${String(n).padStart(7, "0")}`, "driver", "1 TUN 1", "Gafsa", "Gare", "x", at, status, at, at, decided_at, ended_at).lastInsertRowid);
  const stored = [];
  for (let i = 0; i < files; i++) {
    const saved = uploads.save(Buffer.from(`fichier ${n}-${i}`));
    stored.push(saved.stored_name);
    db.prepare("INSERT INTO files (application_id, kind, stored_name, mime, size) VALUES (?,?,?,?,?)").run(id, i === 0 ? "cin_front" : `selfie_${i}`, saved.stored_name, "image/jpeg", 10);
  }
  return { id, ref, phone: p, stored };
}
const exists = (name) => fs.existsSync(path.join(UPLOAD_DIR, name));
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test("cutoffIso : retire des mois calendaires en UTC", () => {
  assert.equal(retention.cutoffIso(NOW, 6), "2026-04-07T12:00:00.000Z");
  assert.equal(retention.cutoffIso(NOW, 12), "2025-10-07T12:00:00.000Z");
});

test("eraseApplication : dossier, pièces sur disque, vérification d'identité, entretiens (par dossier ET par téléphone), codes SMS", () => {
  const a = addApp({ files: 3 });
  const other = addApp({ files: 1 });
  db.prepare("INSERT INTO kyc_checks (application_id) VALUES (?)").run(a.id);
  db.prepare("INSERT INTO interviews (application_id, name, phone, slot_start, room_url) VALUES (?,?,?,?,?)").run(a.id, "Test", a.phone, "2026-11-01T09:00:00+01:00", "https://x");
  db.prepare("INSERT INTO interviews (application_id, name, phone, slot_start, room_url) VALUES (NULL,?,?,?,?)").run("Test", a.phone, "2026-11-02T09:00:00+01:00", "https://x"); // réservé sans référence
  db.prepare("INSERT INTO interviews (application_id, name, phone, slot_start, room_url) VALUES (?,?,?,?,?)").run(other.id, "Autre", other.phone, "2026-11-03T09:00:00+01:00", "https://x");
  db.prepare("INSERT INTO otp_codes (phone, code_hash, expires_at, sent_at) VALUES (?,?,?,?)").run(a.phone, "h", 1, 1);
  db.prepare("INSERT INTO phone_verifications (token_hash, phone, expires_at) VALUES (?,?,?)").run("t", a.phone, 1);

  assert.deepEqual(retention.eraseApplication({ db, uploads }, a.id), { ref: a.ref, files: 3, interviews: 2 });
  assert.equal(db.prepare("SELECT 1 FROM applications WHERE id = ?").get(a.id), undefined);
  assert.equal(db.prepare("SELECT 1 FROM kyc_checks WHERE application_id = ?").get(a.id), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE application_id = ?").get(a.id).n, 0);
  assert.ok(a.stored.every((f) => !exists(f)), "pièces supprimées du disque");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM interviews WHERE phone = ?").get(a.phone).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM otp_codes WHERE phone = ?").get(a.phone).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM phone_verifications WHERE phone = ?").get(a.phone).n, 0);
  // Un autre dossier n'est jamais touché.
  assert.ok(db.prepare("SELECT 1 FROM applications WHERE id = ?").get(other.id));
  assert.ok(other.stored.every(exists));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM interviews WHERE phone = ?").get(other.phone).n, 1);
  assert.equal(retention.eraseApplication({ db, uploads }, a.id), null, "dossier déjà supprimé");
});

test("eraseApplication : un fichier déjà absent du disque ne bloque pas la suppression", () => {
  const a = addApp({ files: 2 });
  fs.rmSync(path.join(UPLOAD_DIR, a.stored[0]));
  assert.equal(retention.eraseApplication({ db, uploads }, a.id).files, 2);
  assert.equal(count("applications"), 0);
});

test("findExpired : refusés, abandonnés et fins de collaboration, chacun selon sa date ; jamais un chauffeur accepté encore actif", () => {
  const old = "2026-01-01T00:00:00.000Z"; // 9 mois avant NOW
  const recent = "2026-09-01T00:00:00.000Z"; // 1 mois avant NOW
  const rejectedOld = addApp({ status: "rejected", at: recent, decided_at: old });
  addApp({ status: "rejected", at: old, decided_at: recent }); // décision récente, même si créé il y a longtemps
  const legacy = addApp({ status: "rejected", at: old }); // sans decided_at : repli sur updated_at
  const abandoned = addApp({ status: "pending", at: old });
  const abandonedIv = addApp({ status: "interview", at: old });
  addApp({ status: "pending", at: recent });
  addApp({ status: "approved", at: old, decided_at: old }); // actif : jamais purgé
  const ended = addApp({ status: "approved", at: old, decided_at: old, ended_at: "2025-06-01T00:00:00.000Z" });
  addApp({ status: "approved", at: old, decided_at: old, ended_at: recent }); // fin trop récente

  const found = retention.findExpired(db, { now: NOW, rejectedMonths: 6, approvedMonths: 12 });
  const byReason = (r) => found.filter((f) => f.reason === r).map((f) => f.ref).sort();
  assert.deepEqual(byReason("rejected"), [rejectedOld.ref, legacy.ref].sort());
  assert.deepEqual(byReason("abandoned"), [abandoned.ref, abandonedIv.ref].sort());
  assert.deepEqual(byReason("ended"), [ended.ref]);
});

test("findExpired : une durée absente désactive sa catégorie (développement : rien n'est purgé)", () => {
  const old = "2020-01-01T00:00:00.000Z";
  addApp({ status: "rejected", at: old, decided_at: old });
  addApp({ status: "approved", at: old, ended_at: old });
  assert.deepEqual(retention.findExpired(db, { now: NOW }), []);
  assert.deepEqual(retention.findExpired(db, { now: NOW, approvedMonths: 12 }).map((f) => f.reason), ["ended"]);
  assert.deepEqual(retention.findExpired(db, { now: NOW, rejectedMonths: 6 }).map((f) => f.reason), ["rejected"]);
});

test("purgeExpired : simulation sans effet ; vraie purge qui supprime pièces et lignes et journalise la référence seulement", () => {
  const old = "2026-01-01T00:00:00.000Z";
  const a = addApp({ status: "rejected", at: old, decided_at: old, files: 2 });
  const keep = addApp({ status: "pending", at: "2026-10-05T00:00:00.000Z", files: 1 });
  const limits = { now: NOW, rejectedMonths: 6, approvedMonths: 12 };

  const dry = retention.purgeExpired({ db, uploads }, { dryRun: true, ...limits });
  assert.deepEqual([dry.dryRun, dry.rejected, dry.refs], [true, 1, [a.ref]]);
  assert.equal(count("applications"), 2);
  assert.ok(a.stored.every(exists));
  assert.equal(count("admin_audit"), 0);

  const erased = [];
  const real = retention.purgeExpired({ db, uploads, onErase: (ref) => erased.push(ref) }, limits);
  assert.deepEqual([real.rejected, real.abandoned, real.ended], [1, 0, 0]);
  assert.deepEqual(erased, [a.ref]);
  assert.equal(count("applications"), 1);
  assert.ok(a.stored.every((f) => !exists(f)));
  assert.ok(keep.stored.every(exists), "dossier récent intact");
  const log = db.prepare("SELECT ip, action, ref FROM admin_audit").all();
  assert.deepEqual(log.map((l) => ({ ...l })), [{ ip: "system", action: "retention_purge_rejected", ref: a.ref }]);
  assert.deepEqual(retention.purgeExpired({ db, uploads }, limits).refs, [], "relancer ne trouve plus rien");
});
