import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-erase-"));
process.env.DATA_DIR = dataDir;
const ADMIN = "erase-test-admin-token-123456";
let server, db, UPLOAD_DIR, uploads, base, createApp;
const sms = { sent: [], async send(_phone, text) { this.sent.push(text.match(/\d{6}/)[0]); } };
const apps = [];

before(async () => {
  ({ createApp } = await import("../server.js"));
  ({ db, UPLOAD_DIR } = await import("../db.js"));
  const { createUploadStore } = await import("../uploads.js");
  uploads = createUploadStore({ dir: UPLOAD_DIR, key: null });
  const app = createApp({ adminToken: ADMIN, rateLimits: false, forceHttps: false, dataKey: null, sms, retention: { rejectedMonths: 6, approvedMonths: 12 } });
  apps.push(app);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const t of ["interviews", "kyc_checks", "files", "applications", "otp_codes", "phone_verifications", "admin_audit"]) db.exec(`DELETE FROM ${t}`);
  sms.sent.length = 0;
});

const post = (url, body, headers = {}) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const admin = (url, method = "GET", body) => fetch(base + "/api/admin" + url, { method, headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
let n = 0;
function addApp({ phone = "98123456", status = "pending", files = 2 } = {}) {
  n += 1;
  const ref = `LX-${"ABCDEFGHJKLMNPQRSTUVWXYZ"[n % 24].repeat(4)}${"ABCDEFGH"[n % 8].repeat(4)}`.slice(0, 11); // même alphabet que newRef (ni 0 ni 1)
  const id = Number(db.prepare("INSERT INTO applications (ref, full_name, phone, cin, role, plate, governorate, station, route, consent_at, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(ref, "Chauffeur Test", phone, `1${String(n).padStart(7, "0")}`, "driver", "1 TUN 1", "Gafsa", "Gare", "x", new Date().toISOString(), status).lastInsertRowid);
  const stored = [];
  for (let i = 0; i < files; i++) {
    const saved = uploads.save(Buffer.from(`piece ${n}-${i}`));
    stored.push(saved.stored_name);
    db.prepare("INSERT INTO files (application_id, kind, stored_name, mime, size) VALUES (?,?,?,?,?)").run(id, i === 0 ? "cin_front" : "selfie_1", saved.stored_name, "image/jpeg", 8);
  }
  return { id, ref, phone, stored };
}
async function otpToken(phone) {
  assert.equal((await post("/api/otp/send", { phone })).status, 200);
  const verified = await post("/api/otp/verify", { phone, code: sms.sent.at(-1) });
  assert.equal(verified.status, 200);
  return (await verified.json()).token;
}
const exists = (name) => fs.existsSync(path.join(UPLOAD_DIR, name));

test("suppression par le chauffeur : référence + téléphone + code SMS, puis tout disparaît (dossier, pièces, entretiens) ; le journal ne garde que la référence", async () => {
  const a = addApp();
  db.prepare("INSERT INTO interviews (application_id, name, phone, slot_start, room_url) VALUES (?,?,?,?,?)").run(a.id, "Chauffeur Test", a.phone, "2030-01-01T09:00:00+01:00", "https://x");
  const token = await otpToken(a.phone);
  const res = await post("/api/applications/delete", { ref: a.ref, phone: a.phone, otp_token: token });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM applications").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM interviews").get().n, 0);
  assert.ok(a.stored.every((f) => !exists(f)));
  assert.equal((await post("/api/status", { ref: a.ref, phone: a.phone })).status, 404, "le suivi ne retrouve plus rien");
  const log = db.prepare("SELECT ip, action, ref FROM admin_audit").all().map((l) => ({ ...l }));
  assert.deepEqual(log, [{ ip: "self", action: "application_self_delete", ref: a.ref }], "ni IP du chauffeur, ni téléphone");
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM admin_audit").all()).includes(a.phone));
});

test("sans code SMS valide, rien n'est supprimé : pas de jeton, jeton d'un autre téléphone, jeton inventé, jeton déjà utilisé", async () => {
  const a = addApp();
  const b = addApp({ phone: "97000111" });
  const payload = (token) => ({ ref: a.ref, phone: a.phone, otp_token: token });
  for (const body of [{ ref: a.ref, phone: a.phone }, payload(""), payload("inventé"), payload(await otpToken(b.phone))]) {
    const res = await post("/api/applications/delete", body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "otp_required");
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM applications").get().n, 2);
  assert.ok(a.stored.every(exists));

  const token = await otpToken(a.phone);
  assert.equal((await post("/api/applications/delete", payload(token))).status, 200);
  const again = addApp({ phone: a.phone });
  assert.equal((await post("/api/applications/delete", { ref: again.ref, phone: a.phone, otp_token: token })).status, 400, "un jeton ne sert qu'une fois");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM applications WHERE ref = ?").get(again.ref).n, 1);
});

test("mauvaise référence ou mauvais téléphone : 404, et le code SMS n'est pas consommé", async () => {
  const a = addApp();
  const token = await otpToken(a.phone);
  assert.equal((await post("/api/applications/delete", { ref: "LX-ZZZZZZZZ", phone: a.phone, otp_token: token })).status, 404);
  assert.equal((await post("/api/applications/delete", { ref: a.ref, phone: "97999999", otp_token: token })).status, 404);
  assert.equal((await post("/api/applications/delete", { ref: a.ref, phone: a.phone, otp_token: token })).status, 200, "le jeton valait encore");
});

test("origine étrangère refusée ; la route est limitée en débit", async () => {
  const a = addApp();
  const res = await post("/api/applications/delete", { ref: a.ref, phone: a.phone, otp_token: "x" }, { Origin: "https://evil.example" });
  assert.equal(res.status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM applications").get().n, 1);
});

test("admin : suppression d'un dossier efface aussi ses entretiens (nom et téléphone ne restent plus)", async () => {
  const a = addApp();
  db.prepare("INSERT INTO interviews (application_id, name, phone, slot_start, room_url) VALUES (?,?,?,?,?)").run(a.id, "Chauffeur Test", a.phone, "2030-01-01T09:00:00+01:00", "https://x");
  assert.equal((await admin(`/applications/${a.ref}`, "DELETE")).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM interviews").get().n, 0);
  assert.ok(a.stored.every((f) => !exists(f)));
  assert.equal(db.prepare("SELECT action FROM admin_audit").all().at(-1).action, "application_delete");
});

test("admin : la date de décision est posée au changement de statut, conservée ensuite, effacée si le dossier repasse en étude", async () => {
  const a = addApp();
  const row = () => db.prepare("SELECT status, decided_at, ended_at FROM applications WHERE ref = ?").get(a.ref);
  assert.equal(row().decided_at, null);
  assert.equal((await admin(`/applications/${a.ref}`, "PATCH", { status: "rejected" })).status, 200);
  const decided = row().decided_at;
  assert.ok(decided);
  await admin(`/applications/${a.ref}`, "PATCH", { admin_note: "juste une note" });
  assert.equal(row().decided_at, decided, "modifier une note ne remet pas le compteur à zéro");
  await admin(`/applications/${a.ref}`, "PATCH", { status: "pending" });
  assert.equal(row().decided_at, null);
});

test("admin : fin de collaboration réservée aux chauffeurs acceptés, réversible, effacée si le statut change", async () => {
  const a = addApp();
  const row = () => db.prepare("SELECT ended_at FROM applications WHERE ref = ?").get(a.ref).ended_at;
  assert.equal((await admin(`/applications/${a.ref}`, "PATCH", { ended: true })).status, 409, "dossier non accepté");
  assert.equal((await admin(`/applications/${a.ref}`, "PATCH", { status: "approved", ended: "oui" })).status, 400, "booléen exigé");
  assert.equal((await admin(`/applications/${a.ref}`, "PATCH", { status: "approved", ended: true })).status, 200);
  const ended = row();
  assert.ok(ended);
  await admin(`/applications/${a.ref}`, "PATCH", { admin_note: "x" });
  assert.equal(row(), ended, "la date de fin ne bouge pas tant qu'on ne la change pas");
  await admin(`/applications/${a.ref}`, "PATCH", { ended: false });
  assert.equal(row(), null);
  await admin(`/applications/${a.ref}`, "PATCH", { ended: true });
  await admin(`/applications/${a.ref}`, "PATCH", { status: "interview" });
  assert.equal(row(), null, "un dossier qui n'est plus accepté n'est plus « terminé »");
  const detail = await (await admin(`/applications/${a.ref}`)).json();
  assert.ok("decided_at" in detail.application && "ended_at" in detail.application);
});

test("purge planifiée : app.locals.retention.run supprime ce qui est périmé, rien d'autre ; désactivée sans durées", async () => {
  const old = "2025-01-01T00:00:00.000Z";
  const expired = addApp({ status: "rejected" });
  db.prepare("UPDATE applications SET decided_at = ?, updated_at = ? WHERE id = ?").run(old, old, expired.id);
  const fresh = addApp({ status: "rejected" });
  db.prepare("UPDATE applications SET decided_at = ? WHERE id = ?").run(new Date().toISOString(), fresh.id);

  assert.equal(apps[0].locals.retention.enabled, true);
  const r = apps[0].locals.retention.run();
  assert.deepEqual([r.rejected, r.refs], [1, [expired.ref]]);
  assert.ok(expired.stored.every((f) => !exists(f)) && fresh.stored.every(exists));

  const bare = createApp({ adminToken: ADMIN, rateLimits: false, forceHttps: false, dataKey: null, sms, retention: { rejectedMonths: null, approvedMonths: null } });
  assert.equal(bare.locals.retention.enabled, false);
  assert.equal(bare.locals.retention.run().refs.length, 0);
});
