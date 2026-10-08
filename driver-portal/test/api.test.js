import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stubSms, makeClock, verifiedToken } from "./_helpers.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-test-"));
process.env.DATA_DIR = dataDir;
const TOKEN = "test-token-123";
const sms = stubSms();
const clock = makeClock();

let server, base, uploadDir;

before(async () => {
  const { createApp } = await import("../server.js");
  ({ UPLOAD_DIR: uploadDir } = await import("../db.js"));
  server = createApp({ adminToken: TOKEN, rateLimits: false, sms, now: clock.now }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  const { db } = await import("../db.js");
  db.close(); // Windows : un fichier SQLite ouvert ne peut pas être supprimé
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);

// Jetons « téléphone vérifié » : un par numéro, réutilisés tant qu'ils n'ont pas été consommés par une inscription réussie.
const tokens = new Map();
async function tok(phone, { fresh = false } = {}) {
  if (fresh || !tokens.has(phone)) tokens.set(phone, await verifiedToken(base, sms, clock, phone));
  return tokens.get(phone);
}

/** `token` : "cache" (défaut), "fresh" (nouveau code SMS), "none", ou un jeton explicite. */
async function appForm(over = {}, { omit = [], textFile = false, token = "cache", selfies = 2, pdfSelfie = false } = {}) {
  const fields = {
    full_name: "Ali Ben Salah", phone: "98123456", cin: "01234567", role: "driver", plate: "123 TUN 4567",
    governorate: "Tunis", station: "Bab Alioua", line_type: "interregional", line_from: "Bab Alioua", line_to_gov: "Sousse", consent: "true", consent_biometric: "true", lang: "fr", ...over,
  };
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (token !== "none") fd.append("otp_token", token === "cache" || token === "fresh" ? await tok(fields.phone, { fresh: token === "fresh" }) : token);
  for (const kind of ["cin_front", "cin_back", "permis"]) {
    if (omit.includes(kind)) continue;
    const blob = textFile && kind === "permis" ? new Blob(["not an image"]) : new Blob([PNG], { type: "image/png" });
    fd.append(kind, blob, `${kind}.png`);
  }
  for (let i = 1; i <= selfies; i++) {
    const blob = pdfSelfie && i === 1 ? new Blob(["%PDF-1.7 fake body"], { type: "application/pdf" }) : new Blob([PNG], { type: "image/png" });
    fd.append(`selfie_${i}`, blob, `selfie_${i}.png`);
  }
  return fd;
}

const post = (url, body, headers) => fetch(base + url, { method: "POST", body, headers });
// Suivi de demande : téléphone et référence voyagent dans le corps (POST), jamais dans l'URL (journaux du proxy, historique du navigateur).
const statusOf = (ref, phone) => fetch(`${base}/api/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref, phone }) });
const admin = (url, opts = {}) => fetch(`${base}/api/admin${url}`, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.body ? { "Content-Type": "application/json" } : {}) } });

let ref;

test("inscription valide → 201 avec référence", async () => {
  const res = await post("/api/applications", await appForm({}, { token: "fresh" }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.ref, /^LX-[A-Z2-9]{8}$/);
  ref = body.ref;
  assert.equal(fs.readdirSync(uploadDir).length, 5, "3 documents + 2 selfies");
});

test("même téléphone ou même CIN → 409 duplicate", async () => {
  assert.equal((await post("/api/applications", await appForm({}, { token: "fresh" }))).status, 409);
  assert.equal((await post("/api/applications", await appForm({ phone: "55111222" }))).status, 409); // même CIN
});

test("sans jeton SMS, avec le jeton d'un autre numéro, ou jeton déjà utilisé → otp_required", async () => {
  const none = await post("/api/applications", await appForm({ phone: "55111222", cin: "11111111" }, { token: "none" }));
  assert.equal(none.status, 400);
  assert.equal((await none.json()).fields.phone, "otp_required");

  const other = await post("/api/applications", await appForm({ phone: "55111222", cin: "11111111" }, { token: await tok("98123456") }));
  assert.equal(other.status, 400, "jeton lié à un autre numéro");
  assert.equal((await other.json()).fields.phone, "otp_required");

  const stale = await post("/api/applications", await appForm({ phone: "55111222", cin: "11111111" }, { token: "garbage" }));
  assert.equal(stale.status, 400);
});

test("fichier manquant ou faux type → 400 avec code par champ", async () => {
  let res = await post("/api/applications", await appForm({ phone: "55111222", cin: "11111111" }, { omit: ["cin_back"] }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).fields.cin_back, "file_required");
  res = await post("/api/applications", await appForm({ phone: "55111222", cin: "11111111" }, { textFile: true }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).fields.permis, "file_type");
});

test("le site est réservé aux chauffeurs : un autre profil (propriétaire) est refusé", async () => {
  const res = await post("/api/applications", await appForm({ phone: "55111222", cin: "11111111", role: "owner" }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).fields.role, "invalid_role");
});

test("consentement obligatoire", async () => {
  const res = await post("/api/applications", await appForm({ phone: "55111222", cin: "11111111", consent: "" }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).fields.consent, "consent_required");
});

test("circuit incohérent (régional vers un autre gouvernorat) → 400 sur line_to_gov", async () => {
  const res = await post("/api/applications", await appForm({ phone: "55111222", cin: "11111111", line_type: "regional", line_from: "Bab Alioua", line_to_gov: "Sousse" }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).fields.line_to_gov, "line_regional_same_gov");
});

test("selfie anormalement lourd (> 2 Mo) refusé", async () => {
  const fd = await appForm({ phone: "55111222", cin: "11111111" }, { selfies: 1 });
  fd.append("selfie_2", new Blob([Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 + 1, 9)])], { type: "image/png" }), "big.png");
  const res = await post("/api/applications", fd);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).fields.selfies, "selfie_too_large");
});

test("consentement biométrique distinct et obligatoire", async () => {
  const res = await post("/api/applications", await appForm({ phone: "55111222", cin: "11111111", consent_biometric: "" }));
  assert.equal(res.status, 400);
  const { fields } = await res.json();
  assert.equal(fields.consent_biometric, "consent_required");
  assert.equal(fields.consent, undefined, "le consentement général est donné : seule la case biométrique manque");
});

test("selfies : au moins 2 images (jamais un PDF)", async () => {
  let res = await post("/api/applications", await appForm({ phone: "55111222", cin: "11111111" }, { selfies: 1 }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).fields.selfies, "selfie_required");
  res = await post("/api/applications", await appForm({ phone: "55111222", cin: "11111111" }, { selfies: 0 }));
  assert.equal((await res.json()).fields.selfies, "selfie_required");
  res = await post("/api/applications", await appForm({ phone: "55111222", cin: "11111111" }, { selfies: 2, pdfSelfie: true }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).fields.selfies, "file_type");
});

test("suivi : bon téléphone → statut ; mauvais téléphone → 404 (pas de fuite)", async () => {
  const ok = await statusOf(ref, "98123456");
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).status, "pending");
  assert.equal((await statusOf(ref, "55000000")).status, 404);
  assert.equal((await statusOf("LX-ZZZZZZZZ", "98123456")).status, 404);
});

test("entretien : réservation, double réservation, créneau pris", async () => {
  const { slots } = await (await fetch(`${base}/api/slots`)).json();
  assert.ok(slots.length > 5);
  const json = { "Content-Type": "application/json" };
  const book = (over) => post("/api/interviews", JSON.stringify({ name: "Ali Ben Salah", phone: "98123456", slot: slots[0], ...over }), json);

  const first = await book({ ref, question: "Combien de temps ça prend ?" });
  assert.equal(first.status, 201);
  const { room_url } = await first.json();
  assert.match(room_url, /^https:\/\/meet\.jit\.si\/LouageExpress-[0-9a-f]{18}$/);

  assert.equal((await book({ phone: "55123123" })).status, 409, "créneau déjà pris");
  assert.equal((await book({ slot: slots[1] })).status, 409, "un seul rendez-vous actif par téléphone");
  assert.equal((await book({ phone: "55123123", slot: "2020-01-01T09:00:00+01:00" })).status, 409, "créneau inventé");
  assert.equal((await book({ phone: "55123123", slot: slots[2], ref })).status, 400, "ref d'un autre téléphone");

  const after = (await (await fetch(`${base}/api/slots`)).json()).slots;
  assert.ok(!after.includes(slots[0]));

  const status = await (await statusOf(ref, "98123456")).json();
  assert.equal(status.interview.slot_start, slots[0]);
});

test("KYC : vérification mise en file dès l'inscription, relançable tant que les selfies existent", async () => {
  const detail = await (await admin(`/applications/${ref}`)).json();
  assert.equal(detail.kyc.status, "queued");
  assert.deepEqual(detail.kyc.reasons, []);
  assert.deepEqual(detail.files.map((f) => f.kind).sort(), ["cin_back", "cin_front", "permis", "selfie_1", "selfie_2"]);
  const list = await (await admin("/applications")).json();
  assert.equal(list.applications[0].kyc_status, "queued");

  assert.equal((await admin(`/applications/${ref}/kyc/retry`, { method: "POST" })).status, 200);
  assert.equal((await admin("/applications/LX-ZZZZZZZZ/kyc/retry", { method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}/api/admin/applications/${ref}/kyc/retry`, { method: "POST" })).status, 401);
});

test("admin : refuse sans jeton ou avec mauvais jeton", async () => {
  assert.equal((await fetch(`${base}/api/admin/applications`)).status, 401);
  const bad = await fetch(`${base}/api/admin/applications`, { headers: { Authorization: "Bearer nope" } });
  assert.equal(bad.status, 401);
  assert.equal((await fetch(`${base}/api/admin/files/1`)).status, 401);
});

test("admin : le réseau déclaré est classé par gouvernorat (24 listés) et exportable en CSV", async () => {
  assert.equal((await fetch(`${base}/api/admin/network`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/network.csv`)).status, 401);
  const net = await (await admin("/network")).json();
  assert.equal(net.governorates.length, 24);
  const tunis = net.governorates.find((g) => g.governorate === "Tunis");
  assert.deepEqual(tunis.interregional[0], { type: "interregional", from: "Bab Alioua", from_ar: null, recognized: false, to_gov: "Sousse", drivers: 1, approved: 0, via: [], pickup: 0, partial: 0 });
  assert.equal(tunis.regional.length, 0);
  assert.equal(net.unclassified, 0);
  const csv = await admin("/network.csv");
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(await csv.text(), /Tunis,interregional,Bab Alioua,Sousse,1,0,,0,0/);
  const detail = await (await admin(`/applications/${ref}`)).json();
  assert.equal(detail.application.route, "Bab Alioua → Sousse");
  assert.equal(detail.application.line_type, "interregional");
});

test("admin : liste, détail, changement de statut visible côté chauffeur, note interne non exposée", async () => {
  const list = await (await admin("/applications?q=Ali")).json();
  assert.equal(list.applications.length, 1);
  assert.equal(list.applications[0].files, 5, "3 documents + 2 selfies avant la décision");

  const patch = await admin(`/applications/${ref}`, { method: "PATCH", body: JSON.stringify({ status: "approved", public_note: "Bienvenue", admin_note: "secret interne" }) });
  assert.equal(patch.status, 200);
  assert.equal((await admin(`/applications/${ref}`, { method: "PATCH", body: JSON.stringify({ status: "hacked" }) })).status, 400);

  const pub = await (await statusOf(ref, "98123456")).json();
  assert.equal(pub.status, "approved");
  assert.equal(pub.public_note, "Bienvenue");
  assert.ok(!JSON.stringify(pub).includes("secret interne"));

  // Décision finale ⇒ les selfies (données biométriques) sont supprimés, base et disque ; la relance n'est plus possible.
  const after = await (await admin(`/applications/${ref}`)).json();
  assert.deepEqual(after.files.map((f) => f.kind).sort(), ["cin_back", "cin_front", "permis"]);
  assert.equal(fs.readdirSync(uploadDir).length, 3);
  assert.equal((await admin(`/applications/${ref}/kyc/retry`, { method: "POST" })).status, 409);
});

test("admin : un document est servi avec son vrai type, et la recherche échappe les jokers SQL", async () => {
  const { files } = await (await admin(`/applications/${ref}`)).json();
  const doc = await admin(`/files/${files[0].id}`);
  assert.equal(doc.status, 200);
  assert.equal(doc.headers.get("content-type"), "image/png");
  assert.equal(doc.headers.get("x-content-type-options"), "nosniff");
  const wild = await (await admin("/applications?q=%25")).json();
  assert.equal(wild.applications.length, 0, "« % » littéral ne doit pas matcher tout");
});

test("admin : suppression efface la base ET les fichiers", async () => {
  assert.equal(fs.readdirSync(uploadDir).length, 3);
  assert.equal((await admin(`/applications/${ref}`, { method: "DELETE" })).status, 200);
  assert.equal(fs.readdirSync(uploadDir).length, 0);
  assert.equal((await statusOf(ref, "98123456")).status, 404);
});

test("en-têtes de sécurité et pas de x-powered-by", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(res.headers.get("permissions-policy"), "camera=(self), microphone=(), geolocation=()");
});

// En dernier : il avance l'horloge de 31 min, ce qui périmerait les jetons des autres tests.
test("un jeton valide 30 min seulement", async () => {
  const t = await verifiedToken(base, sms, clock, "55333444");
  clock.advance(31 * 60_000);
  const res = await post("/api/applications", await appForm({ phone: "55333444", cin: "22222222" }, { token: t }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).fields.phone, "otp_required");
});

test("suivi de demande : l'ancienne URL avec téléphone et référence n'existe plus (aucune donnée personnelle dans l'URL)", async () => {
  const old = await fetch(`${base}/api/status?ref=${ref}&phone=98123456`);
  assert.equal(old.status, 404);
  assert.deepEqual(await old.json(), { error: "not_found" });
});
