import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeClock } from "./_helpers.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-kyc-"));
process.env.DATA_DIR = dataDir;
const clock = makeClock();
let db, UPLOAD_DIR, createKycWorker, cinInText, purgeSelfies;

before(async () => {
  ({ db, UPLOAD_DIR } = await import("../db.js"));
  ({ createKycWorker, cinInText, purgeSelfies } = await import("../kyc.js"));
});
after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 5)]);
const PDF = Buffer.from("%PDF-1.7 fake");
let n = 0;

/** Crée une demande avec ses fichiers directement en base (le test cible le worker, pas l'upload). */
function seed({ cin = "01234567", cinMime = "image/png", selfies = 3, withPermis = true, bigPermis = false } = {}) {
  n++;
  const ref = `LX-TEST${String(n).padStart(4, "2")}`;
  const info = db
    .prepare(`INSERT INTO applications (ref, full_name, phone, cin, role, plate, governorate, station, route, consent_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(ref, "Ali", `9812${String(n).padStart(4, "0")}`, cin, "driver", "123 TUN 4567", "Tunis", "Bab Alioua", "Tunis-Sousse", new Date().toISOString());
  const appId = Number(info.lastInsertRowid);
  const add = (kind, mime, buf) => {
    const stored = `t${n}-${kind}.bin`;
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
    db.prepare("INSERT INTO files (application_id, kind, stored_name, mime, size) VALUES (?,?,?,?,?)").run(appId, kind, stored, mime, buf.length);
  };
  add("cin_front", cinMime, cinMime === "application/pdf" ? PDF : PNG);
  add("cin_back", "image/png", PNG);
  if (withPermis) add("permis", "image/png", bigPermis ? Buffer.alloc(10.5 * 1024 * 1024, 1) : PNG);
  for (let i = 1; i <= selfies; i++) add(`selfie_${i}`, "image/png", PNG);
  db.prepare("INSERT INTO kyc_checks (application_id) VALUES (?)").run(appId);
  return { appId, ref };
}

const row = (appId) => db.prepare("SELECT * FROM kyc_checks WHERE application_id = ?").get(appId);
const kinds = (appId) => db.prepare("SELECT kind FROM files WHERE application_id = ?").all(appId).map((f) => f.kind);

/** Faux backend KYC : enregistre les appels et répond selon le scénario. */
function fakeBackend(scenario) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === "DELETE") return { ok: true, status: 200, json: async () => ({ deleted: true }) };
    const r = typeof scenario === "function" ? scenario(calls.length) : scenario;
    if (r instanceof Error) throw r;
    return { ok: r.status === 200, status: r.status, json: async () => r.body ?? {} };
  };
  return { calls, fetchImpl };
}

const goodBody = (over = {}) => ({
  status: "verified",
  faceMatch: { provider: "aws-rekognition", isRealBiometric: true, score: 0.9732 },
  ocrCin: { rawText: "REPUBLIQUE TUNISIENNE\nN° 0123 4567\nNE LE 15/03/1990", confidence: 94, cinNumber: "01234567" },
  liveness: { passed: true, motionScore: 4.2 },
  reasons: [],
  ...over,
});

const worker = (scenario) => {
  const be = fakeBackend(scenario);
  return { be, w: createKycWorker({ db, uploadDir: UPLOAD_DIR, backendUrl: "http://backend.test", serviceKey: "k3y", fetchImpl: be.fetchImpl, now: clock.now }) };
};

// Chaque test part d'une file vide : un test ne doit pas hériter des vérifications en attente d'un autre.
beforeEach(() => {
  db.exec("DELETE FROM applications"); // cascade : fichiers et vérifications
  clock.advance(1);
});

test("cinInText : retrouve la CIN saisie dans le texte OCR, sans faux positif", () => {
  assert.equal(cinInText("N° 01234567 né le", "01234567"), true);
  assert.equal(cinInText("N° 0123 4567", "01234567"), true, "espace inséré par l'OCR");
  assert.equal(cinInText("٠١٢٣٤٥٦٧", "01234567"), true, "chiffres indo-arabes");
  assert.equal(cinInText("tel 9101234567", "01234567"), false, "fait partie d'un nombre plus long");
  assert.equal(cinInText("N° 76543210", "01234567"), false);
  assert.equal(cinInText("", "01234567"), false);
  assert.equal(cinInText(undefined, "01234567"), false);
});

test("succès : indicateurs enregistrés, clé de service envoyée, selfies supprimés, dossier effacé côté backend", async () => {
  const { appId, ref } = seed();
  const { be, w } = worker({ status: 200, body: goodBody() });
  assert.equal(await w.runOnce(), true);

  const r = row(appId);
  assert.equal(r.status, "verified");
  assert.equal(r.face_score, 0.9732);
  assert.equal(r.face_provider, "aws-rekognition");
  assert.equal(r.real_biometric, 1);
  assert.equal(r.liveness_passed, 1);
  assert.equal(r.cin_match, 1);
  assert.deepEqual(JSON.parse(r.reasons), []);

  const [post, del] = be.calls;
  assert.equal(post.url, "http://backend.test/api/v1/auth/driver/verify-identity");
  assert.equal(post.headers["X-Service-Key"], "k3y");
  assert.equal(post.body.driverId, ref);
  assert.match(post.body.cinPhoto, /^data:image\/png;base64,/);
  assert.equal(post.body.selfieFrames.length, 3);
  assert.ok(post.body.permisPhoto);
  assert.equal(del.method, "DELETE");
  assert.equal(del.url, `http://backend.test/api/v1/auth/driver/verify-identity/${ref}`);

  assert.deepEqual(kinds(appId).sort(), ["cin_back", "cin_front", "permis"], "selfies purgés (minimisation)");
  assert.equal(fs.readdirSync(UPLOAD_DIR).filter((f) => f.startsWith(`t${n}-selfie`)).length, 0, "et supprimés du disque");
  const dump = JSON.stringify(db.prepare("SELECT * FROM kyc_checks").all());
  assert.ok(!dump.includes("REPUBLIQUE") && !dump.includes("NE LE"), "le texte OCR n'est jamais conservé");
});

test("revue manuelle : raisons du backend conservées, selfies gardés pour l'examen humain", async () => {
  const { appId } = seed();
  const { w } = worker({ status: 200, body: goodBody({ status: "pending_manual_review", faceMatch: { provider: "aws-rekognition", isRealBiometric: true, score: 0.71 }, reasons: ["face_match_score_insuffisant"] }) });
  await w.runOnce();
  const r = row(appId);
  assert.equal(r.status, "review");
  assert.equal(r.face_score, 0.71);
  assert.deepEqual(JSON.parse(r.reasons), ["face_match_score_insuffisant"]);
  assert.ok(kinds(appId).includes("selfie_1"));
});

test("le backend dit « verified » mais la CIN lue ≠ la CIN saisie → revue, jamais verified", async () => {
  const { appId } = seed({ cin: "99999999" });
  const { w } = worker({ status: 200, body: goodBody() }); // le texte OCR contient 01234567
  await w.runOnce();
  const r = row(appId);
  assert.equal(r.status, "review");
  assert.equal(r.cin_match, 0);
  assert.ok(JSON.parse(r.reasons).includes("cin_ocr_ne_correspond_pas_a_la_saisie"));
  assert.ok(kinds(appId).includes("selfie_1"), "selfies conservés");
});

test("moteur biométrique non réel (fallback) → jamais verified, même si le backend le prétendait", async () => {
  const { appId } = seed();
  const { w } = worker({ status: 200, body: goodBody({ faceMatch: { provider: "phash-fallback", isRealBiometric: false, score: 0.99 } }) });
  await w.runOnce();
  const r = row(appId);
  assert.equal(r.status, "review");
  assert.equal(r.real_biometric, 0);
});

test("backend injoignable : réessais espacés (30 s, 2 min, 10 min) puis erreur définitive", async () => {
  const { appId } = seed();
  const { be, w } = worker(new Error("ECONNREFUSED"));
  const t0 = clock.now();

  assert.equal(await w.runOnce(), true);
  let r = row(appId);
  assert.equal(r.status, "queued");
  assert.equal(r.attempts, 1);
  assert.equal(r.next_attempt_at, t0 + 30_000);
  assert.equal(await w.runOnce(), false, "pas avant l'heure prévue");

  for (const [wait, attempts] of [[30_000, 2], [120_000, 3]]) {
    clock.advance(wait);
    assert.equal(await w.runOnce(), true);
    r = row(appId);
    assert.equal(r.status, "queued");
    assert.equal(r.attempts, attempts);
  }
  clock.advance(600_000);
  await w.runOnce();
  r = row(appId);
  assert.equal(r.status, "error");
  assert.equal(r.error, "backend_unreachable");
  assert.equal(r.attempts, 4);
  assert.equal(be.calls.filter((c) => c.method === "POST").length, 4);
  assert.ok(kinds(appId).includes("selfie_1"), "rien n'est supprimé en cas d'erreur");
});

test("erreur 5xx du backend : réessayée plus tard", async () => {
  const { appId } = seed();
  const { w } = worker({ status: 503 });
  await w.runOnce();
  assert.equal(row(appId).status, "queued");
  assert.equal(row(appId).attempts, 1);
});

test("401 du backend (clé de service invalide) : erreur définitive, sans réessai automatique", async () => {
  const { appId } = seed();
  const { be, w } = worker({ status: 401 });
  await w.runOnce();
  assert.equal(row(appId).status, "error");
  assert.equal(row(appId).error, "backend_auth");
  clock.advance(3_600_000);
  assert.equal(await w.runOnce(), false);
  assert.equal(be.calls.filter((c) => c.method === "POST").length, 1);
});

test("400 du backend (requête rejetée) : erreur définitive", async () => {
  const { appId } = seed();
  const { w } = worker({ status: 400, body: { error: "Images base64 invalides" } });
  await w.runOnce();
  assert.equal(row(appId).status, "error");
  assert.equal(row(appId).error, "backend_rejected");
});

test("requête trop lourde pour le backend : le permis (optionnel) est écarté, CIN et selfies sont toujours envoyés", async () => {
  seed({ bigPermis: true });
  const { be, w } = worker({ status: 200, body: goodBody() });
  await w.runOnce();
  const sent = be.calls[0].body;
  assert.ok(sent.cinPhoto && sent.selfieFrames.length === 3);
  assert.ok(!("permisPhoto" in sent), "permis écarté : il ferait dépasser le plafond de 10 Mo");
});

test("CIN recto en PDF ou aucun selfie : vérification non exécutée (revue manuelle), backend jamais appelé", async () => {
  const pdf = seed({ cinMime: "application/pdf" });
  const none = seed({ selfies: 0, cin: "55555555" });
  const { be, w } = worker({ status: 200, body: goodBody() });
  await w.runOnce();
  await w.runOnce();
  assert.equal(row(pdf.appId).status, "skipped");
  assert.deepEqual(JSON.parse(row(pdf.appId).reasons), ["cin_recto_non_image"]);
  assert.equal(row(none.appId).status, "skipped");
  assert.deepEqual(JSON.parse(row(none.appId).reasons), ["selfie_absent_ou_purge"]);
  assert.equal(be.calls.length, 0);
});

test("requeue : relance possible tant que les selfies existent, impossible après purge", async () => {
  const { appId } = seed();
  const { w } = worker({ status: 401 });
  await w.runOnce();
  assert.equal(row(appId).status, "error");
  assert.equal(w.requeue(appId), true);
  assert.equal(row(appId).status, "queued");
  assert.equal(row(appId).attempts, 0);
  assert.equal(row(appId).error, null);

  purgeSelfies(db, UPLOAD_DIR, appId);
  assert.equal(w.requeue(appId), false);
});

test("au démarrage, une vérification restée « processing » (crash) est remise en file", () => {
  const { appId } = seed();
  db.prepare("UPDATE kyc_checks SET status = 'processing' WHERE application_id = ?").run(appId);
  const { w } = worker({ status: 200, body: goodBody() });
  w.start({ intervalMs: 3_600_000 });
  w.stop();
  assert.equal(row(appId).status, "queued");
});
