import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-notif-"));
process.env.DATA_DIR = dataDir;
let db, mod;
before(async () => {
  ({ db } = await import("../db.js"));
  mod = await import("../notifications.js");
});
after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const t of ["notifications", "interviews", "applications"]) db.exec(`DELETE FROM ${t}`);
});

const NOW = Date.parse("2026-10-07T10:00:00Z");
let clock = NOW;
let n = 0;
const sms = { sent: [], failNext: 0, async send(phone, text) { if (this.failNext > 0) { this.failNext -= 1; throw new Error("twilio HTTP 500"); } this.sent.push({ phone, text }); } };
const make = (opts = {}) => mod.createNotifier({ db, sms, enabled: true, baseUrl: "https://inscription.exemple.tn", now: () => clock, ...opts });
beforeEach(() => { clock = NOW; sms.sent.length = 0; sms.failNext = 0; });

function addApp({ status = "pending", lang = "fr", phone } = {}) {
  n += 1;
  const p = phone ?? `9${String(n).padStart(7, "0")}`;
  const id = Number(db.prepare("INSERT INTO applications (ref, full_name, phone, cin, role, plate, governorate, station, route, consent_at, status, lang) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`LX-N${n}`, "Test", p, `0${String(n).padStart(7, "0")}`, "driver", "1 TUN 1", "Gafsa", "Gare", "x", new Date().toISOString(), status, lang).lastInsertRowid);
  return { id, phone: p, lang };
}
function addInterview(app, slot, { status = "booked", createdMs = NOW - 86_400_000 } = {}) {
  return Number(db.prepare("INSERT INTO interviews (application_id, name, phone, slot_start, room_url, status, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(app.id, "Test", app.phone, slot, "https://visio.example/room-secret", status, new Date(createdMs).toISOString()).lastInsertRowid);
}
const rows = () => db.prepare("SELECT kind, status, attempts, error FROM notifications ORDER BY id").all().map((r) => ({ ...r }));

test("messageFor : tous les types, en français et en arabe, avec lien vers le suivi ; jamais le lien de visio ni le motif", () => {
  for (const kind of mod.NOTIFICATION_KINDS) {
    for (const lang of ["fr", "ar"]) {
      const text = mod.messageFor(kind, lang, { slot: "2026-11-01T09:30:00+01:00", url: "https://s.tn" });
      assert.ok(text.startsWith("Louage Express"), `${kind}/${lang}`);
      assert.ok(text.includes("https://s.tn/"), `${kind}/${lang} : lien`);
      assert.ok(!/\{|undefined|null/.test(text), `${kind}/${lang} : ${text}`);
      assert.ok(text.length < 160, `${kind}/${lang} : ${text.length} caractères`);
    }
  }
  assert.ok(mod.messageFor("interview_booked", "fr", { slot: "2026-11-01T09:30:00+01:00" }).includes("01/11 à 09:30"));
  assert.ok(mod.messageFor("interview_reminder", "ar", { slot: "2026-11-01T09:30:00+01:00" }).includes("09:30"));
  assert.ok(!mod.messageFor("status_approved", "fr", {}).includes("http"), "sans adresse publique (développement) : pas de lien");
  assert.match(mod.messageFor("status_interview", "fr", { url: "https://s.tn" }), /\/interview$/);
  assert.throws(() => mod.messageFor("inconnu", "fr"), /inconnu/);
  assert.ok(/[؀-ۿ]/.test(mod.messageFor("status_approved", "ar", {})));
});

test("désactivé : rien n'est mis en file ni envoyé", async () => {
  const a = addApp();
  const off = make({ enabled: false });
  assert.equal(off.enqueue({ appId: a.id, phone: a.phone, lang: "fr", kind: "status_approved" }), false);
  await off.drain();
  assert.deepEqual(rows(), []);
  assert.deepEqual(sms.sent, []);
});

test("changement de statut : SMS envoyé au téléphone du dossier, dans sa langue, puis marqué envoyé", async () => {
  const a = addApp({ status: "approved", lang: "fr" });
  const notifier = make();
  assert.equal(notifier.enqueue({ appId: a.id, phone: a.phone, lang: a.lang, kind: "status_approved" }), true);
  await notifier.drain();
  assert.equal(sms.sent.length, 1);
  assert.equal(sms.sent[0].phone, a.phone);
  assert.match(sms.sent[0].text, /acceptée/);
  assert.deepEqual(rows(), [{ kind: "status_approved", status: "sent", attempts: 1, error: null }]);
  await notifier.drain();
  assert.equal(sms.sent.length, 1, "jamais deux fois");
});

test("statut rétabli avant l'envoi : le SMS périmé n'est pas envoyé", async () => {
  const a = addApp({ status: "rejected" });
  const notifier = make();
  notifier.enqueue({ appId: a.id, phone: a.phone, lang: "fr", kind: "status_approved" }); // l'admin a corrigé entre-temps
  await notifier.drain();
  assert.deepEqual(sms.sent, []);
  assert.deepEqual(rows(), [{ kind: "status_approved", status: "skipped", attempts: 0, error: "stale" }]);
});

test("échec d'envoi : nouvel essai plus tard avec délai croissant, puis abandon ; l'erreur ne contient ni numéro ni texte", async () => {
  const a = addApp({ status: "approved" });
  const notifier = make({ maxAttempts: 3 });
  notifier.enqueue({ appId: a.id, phone: a.phone, lang: "fr", kind: "status_approved" });
  sms.failNext = 99;
  await notifier.drain();
  assert.deepEqual(rows()[0], { kind: "status_approved", status: "queued", attempts: 1, error: "twilio HTTP 500" });
  await notifier.drain();
  assert.equal(rows()[0].attempts, 1, "trop tôt : le délai n'est pas écoulé");
  clock += 3 * 60_000;
  await notifier.drain();
  assert.equal(rows()[0].attempts, 2);
  clock += 10 * 60_000;
  await notifier.drain();
  assert.deepEqual(rows()[0].status, "failed");
  clock += 3_600_000;
  await notifier.drain();
  assert.equal(rows()[0].attempts, 3, "plus d'essai après l'abandon");
  assert.ok(!JSON.stringify(rows()).includes(a.phone));
});

test("un échec puis un succès : envoyé au deuxième essai", async () => {
  const a = addApp({ status: "approved" });
  const notifier = make();
  notifier.enqueue({ appId: a.id, phone: a.phone, lang: "fr", kind: "status_approved" });
  sms.failNext = 1;
  await notifier.drain();
  clock += 3 * 60_000;
  await notifier.drain();
  assert.deepEqual([rows()[0].status, rows()[0].attempts, sms.sent.length], ["sent", 2, 1]);
});

test("plafond quotidien : les envois s'arrêtent, reprennent après 24 h", async () => {
  const notifier = make({ dailyCap: 2 });
  for (let i = 0; i < 4; i++) {
    const a = addApp({ status: "approved" });
    notifier.enqueue({ appId: a.id, phone: a.phone, lang: "fr", kind: "status_approved" });
  }
  await notifier.drain();
  assert.equal(sms.sent.length, 2);
  assert.deepEqual(rows().map((r) => r.status), ["sent", "sent", "queued", "queued"]);
  clock += 25 * 3_600_000;
  await notifier.drain();
  assert.equal(sms.sent.length, 4);
});

test("coupe-circuit : au plus 5 notifications par dossier et par jour", () => {
  const a = addApp();
  const notifier = make();
  const results = Array.from({ length: 7 }, () => notifier.enqueue({ appId: a.id, phone: a.phone, lang: "fr", kind: "status_interview" }));
  assert.deepEqual(results, [true, true, true, true, true, false, false]);
});

test("entretien : confirmation une seule fois (clé unique), annulée si l'entretien est annulé avant l'envoi", async () => {
  const a = addApp({ status: "interview" });
  const slot = "2026-10-12T09:30:00+01:00";
  const id = addInterview(a, slot);
  const notifier = make();
  assert.equal(notifier.enqueue({ appId: a.id, phone: a.phone, lang: "fr", kind: "interview_booked", params: { interview_id: id, slot }, key: `booked:${id}` }), true);
  assert.equal(notifier.enqueue({ appId: a.id, phone: a.phone, lang: "fr", kind: "interview_booked", params: { interview_id: id, slot }, key: `booked:${id}` }), false, "doublon refusé");
  await notifier.drain();
  assert.match(sms.sent[0].text, /12\/10 à 09:30/);
  assert.ok(!sms.sent[0].text.includes("room-secret"), "le lien de visioconférence n'est jamais dans le SMS");

  const id2 = addInterview(a, "2026-10-13T09:30:00+01:00", { status: "cancelled" });
  notifier.enqueue({ appId: a.id, phone: a.phone, lang: "fr", kind: "interview_booked", params: { interview_id: id2, slot: "2026-10-13T09:30:00+01:00" }, key: `booked:${id2}` });
  await notifier.drain();
  assert.equal(sms.sent.length, 1);
  assert.equal(rows().at(-1).status, "skipped");
});

test("rappel : seulement pour un entretien dans le délai, réservé avant ce délai, une fois ; pas pour un entretien annulé ou lointain", async () => {
  const a = addApp({ status: "interview" });
  const soon = "2026-10-07T12:30:00+01:00"; // 11:30 UTC : dans 1 h 30 par rapport à NOW (10:00 UTC)
  const idSoon = addInterview(a, soon);
  const b = addApp({ status: "interview" });
  addInterview(b, "2026-10-09T09:00:00+01:00"); // dans 2 jours
  const c = addApp({ status: "interview" });
  addInterview(c, soon, { status: "cancelled" });
  const d = addApp({ status: "interview" });
  addInterview(d, "2026-10-07T12:45:00+01:00", { createdMs: NOW - 30 * 60_000 }); // réservé il y a 30 min, pour dans 1 h 30 : la confirmation vient de partir
  const notifier = make({ reminderHours: 3 });
  assert.equal(notifier.enqueueReminders(), 1);
  assert.equal(notifier.enqueueReminders(), 0, "idempotent");
  await notifier.drain();
  assert.equal(sms.sent.length, 1);
  assert.equal(sms.sent[0].phone, a.phone);
  assert.match(sms.sent[0].text, /rappel/);
  assert.equal(db.prepare("SELECT dedupe_key FROM notifications").get().dedupe_key, `reminder:${idSoon}`);
  clock += 5 * 3_600_000; // l'entretien est passé : plus de rappel
  assert.equal(notifier.enqueueReminders(), 0);
});

test("journal d'envoi : les lignes terminées de plus de 30 jours sont supprimées, les en-attente restent", () => {
  const a = addApp();
  const old = new Date(NOW - 40 * 86_400_000).toISOString();
  const ins = db.prepare("INSERT INTO notifications (application_id, phone, kind, status, created_at) VALUES (?,?,?,?,?)");
  ins.run(a.id, a.phone, "status_approved", "sent", old);
  ins.run(a.id, a.phone, "status_approved", "failed", old);
  ins.run(a.id, a.phone, "status_approved", "queued", old);
  ins.run(a.id, a.phone, "status_approved", "sent", new Date(NOW).toISOString());
  assert.equal(make().housekeeping(), 2);
  assert.deepEqual(rows().map((r) => r.status).sort(), ["queued", "sent"]);
});
