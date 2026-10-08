import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-notif-api-"));
process.env.DATA_DIR = dataDir;
const ADMIN = "notif-test-admin-token-123456";
let db, createApp, on, off, onBase, offBase, servers = [];
const sms = { sent: [], async send(phone, text) { this.sent.push({ phone, text }); } };

before(async () => {
  ({ createApp } = await import("../server.js"));
  ({ db } = await import("../db.js"));
  const common = { adminToken: ADMIN, rateLimits: false, forceHttps: false, dataKey: null, sms, publicUrl: "https://inscription.exemple.tn" };
  on = createApp({ ...common, notifications: { enabled: true, dailyCap: 100, reminderHours: 3 } });
  off = createApp({ ...common, notifications: { enabled: false } });
  const s1 = on.listen(0);
  const s2 = off.listen(0);
  servers = [s1, s2];
  onBase = `http://127.0.0.1:${s1.address().port}`;
  offBase = `http://127.0.0.1:${s2.address().port}`;
});
after(() => {
  servers.forEach((s) => s.close());
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const t of ["notifications", "interviews", "applications"]) db.exec(`DELETE FROM ${t}`);
  sms.sent.length = 0;
});

const patch = (base, ref, body) => fetch(`${base}/api/admin/applications/${ref}`, { method: "PATCH", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const post = (base, url, body) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
let n = 0;
function addApp({ phone = `9${String(++n).padStart(7, "0")}`, lang = "fr" } = {}) {
  const ref = `LX-${"ABCDEFGHJKLMNPQRSTUVWXYZ"[n % 24].repeat(4)}${"ABCDEFGH"[n % 8].repeat(4)}`;
  db.prepare("INSERT INTO applications (ref, full_name, phone, cin, role, plate, governorate, station, route, consent_at, lang) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(ref, "Test", phone, `1${String(n).padStart(7, "0")}`, "driver", "1 TUN 1", "Gafsa", "Gare", "x", new Date().toISOString(), lang);
  return { ref, phone };
}
const queue = () => db.prepare("SELECT kind, status, phone FROM notifications ORDER BY id").all().map((r) => ({ ...r }));
const settle = async () => { await on.locals.notifier.drain(); };

test("l'admin change le statut : SMS dans la langue du dossier, avec lien de suivi, une seule fois", async () => {
  const a = addApp({ lang: "fr" });
  const res = await patch(onBase, a.ref, { status: "approved", public_note: "Bienvenue" });
  assert.deepEqual(await res.json(), { ok: true, notified: true });
  await settle();
  assert.equal(sms.sent.length, 1);
  assert.equal(sms.sent[0].phone, a.phone);
  assert.match(sms.sent[0].text, /acceptée.*https:\/\/inscription\.exemple\.tn\/status/);
  assert.ok(!sms.sent[0].text.includes("Bienvenue"), "le message public de l'équipe n'est pas recopié dans le SMS");

  assert.equal((await (await patch(onBase, a.ref, { status: "approved", admin_note: "x" })).json()).notified, false, "statut inchangé : pas de nouveau SMS");
  await settle();
  assert.equal(sms.sent.length, 1);
});

test("arabe pour un dossier arabe ; refus = texte neutre sans motif ; « en attente » n'envoie rien", async () => {
  const a = addApp({ lang: "ar" });
  await patch(onBase, a.ref, { status: "rejected", public_note: "Permis expiré" });
  await settle();
  assert.ok(/[؀-ۿ]/.test(sms.sent[0].text));
  assert.ok(!sms.sent[0].text.includes("expiré"));
  await patch(onBase, a.ref, { status: "pending" });
  assert.deepEqual(queue().map((q) => q.kind), ["status_rejected"], "retour à « en attente » : aucun SMS");
});

test("case « prévenir par SMS » décochée : le statut change, aucun SMS ; valeur non booléenne refusée", async () => {
  const a = addApp();
  assert.deepEqual(await (await patch(onBase, a.ref, { status: "approved", notify: false })).json(), { ok: true, notified: false });
  await settle();
  assert.deepEqual([queue().length, sms.sent.length], [0, 0]);
  assert.equal((await patch(onBase, a.ref, { status: "rejected", notify: "non" })).status, 400);
  assert.equal(db.prepare("SELECT status FROM applications WHERE ref = ?").get(a.ref).status, "approved", "requête refusée : rien n'a changé");
});

test("notifications désactivées (SMS_NOTIFICATIONS absent) : le statut change sans aucun SMS", async () => {
  const a = addApp();
  assert.equal((await (await patch(offBase, a.ref, { status: "approved" })).json()).notified, false);
  assert.equal(queue().length, 0);
});

test("entretien réservé avec référence + téléphone : SMS de confirmation ; sans référence ou avec une mauvaise référence : jamais de SMS", async () => {
  const a = addApp({ phone: "98111222" });
  const slots = (await (await fetch(`${onBase}/api/slots`)).json()).slots;
  const body = (slot, extra) => ({ name: "Chauffeur Test", phone: a.phone, slot, ...extra });

  const anonymous = await post(onBase, "/api/interviews", body(slots[0]));
  assert.equal(anonymous.status, 201);
  assert.equal(queue().length, 0, "sans référence, le numéro n'est pas prouvé : pas de SMS (sinon on ferait écrire à n'importe qui)");

  const wrong = await post(onBase, "/api/interviews", body(slots[1], { ref: "LX-ZZZZZZZZ" }));
  assert.equal(wrong.status, 400);
  assert.equal(queue().length, 0);

  db.exec("DELETE FROM interviews");
  const ok = await post(onBase, "/api/interviews", body(slots[2], { ref: a.ref }));
  assert.equal(ok.status, 201);
  assert.deepEqual(queue().map((q) => [q.kind, q.phone]), [["interview_booked", a.phone]]);
  await settle();
  assert.equal(sms.sent.length, 1);
  assert.match(sms.sent[0].text, /entretien confirmé/);
  assert.ok(!sms.sent[0].text.includes("meet.jit.si"), "pas de lien de visio dans le SMS");
});

test("détail admin : historique des SMS ; suppression du dossier (admin ou chauffeur) efface aussi la file d'envoi", async () => {
  const a = addApp();
  await patch(onBase, a.ref, { status: "interview" });
  await settle();
  const detail = await (await fetch(`${onBase}/api/admin/applications/${a.ref}`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json();
  assert.deepEqual(detail.notifications.map((x) => [x.kind, x.status]), [["status_interview", "sent"]]);
  assert.ok(!JSON.stringify(detail.notifications).includes(a.phone), "le détail ne répète pas le numéro");

  await patch(onBase, a.ref, { status: "approved" }); // une notification encore en file
  assert.equal(queue().length, 2);
  assert.equal((await fetch(`${onBase}/api/admin/applications/${a.ref}`, { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN}` } })).status, 200);
  assert.equal(queue().length, 0, "plus aucune trace du numéro dans la file");
});
