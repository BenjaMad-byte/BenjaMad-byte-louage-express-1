import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stubSms, makeClock, verifiedToken } from "./_helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-rot-"));
process.env.DATA_DIR = dataDir;
const TOKEN = "rotation-test-token-123456";
const A = crypto.randomBytes(32);
const B = crypto.randomBytes(32);
const C = crypto.randomBytes(32);
const hex = (k) => k.toString("hex");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("PIECE-DE-TEST-ROTATION"), Buffer.alloc(32, 5)]);
const sms = stubSms();
const clock = makeClock();

let createApp, db, uploadDir, security, uploads;
const servers = [];
const launch = (opts = {}) => {
  const server = createApp({ adminToken: TOKEN, rateLimits: false, forceHttps: false, sms, now: clock.now, strictKeys: false, ...opts }).listen(0);
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
};
const admin = (base, p) => fetch(`${base}/api/admin${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });

before(async () => {
  ({ createApp } = await import("../server.js"));
  ({ db, UPLOAD_DIR: uploadDir } = await import("../db.js"));
  security = await import("../security.js");
  uploads = await import("../uploads.js");
});
after(() => {
  servers.forEach((s) => s.close());
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Dossier avec une pièce chiffrée par la clé donnée, comme avant une rotation. */
function seedOldFile(key, content, { labelled = true } = {}) {
  const store = uploads.createUploadStore({ dir: uploadDir, key });
  const saved = store.save(content, ".png");
  const n = db.prepare("SELECT COUNT(*) AS n FROM applications").get().n;
  const info = db
    .prepare(`INSERT INTO applications (ref, full_name, phone, cin, role, plate, governorate, station, route, consent_at) VALUES (?,?,?,?, 'driver', 'x', 'Tunis', 's', 'r', ?)`)
    .run(`LX-ROT${n}AAAA`, "Test", `2900000${n}`, `9900000${n}`, new Date().toISOString());
  db.prepare("INSERT INTO files (application_id, kind, stored_name, mime, size, enc, key_id) VALUES (?,?,?,?,?,?,?)").run(Number(info.lastInsertRowid), "cin_front", saved.stored_name, "image/png", content.length, saved.enc, labelled ? saved.key_id : null);
  return { fileId: Number(db.prepare("SELECT id FROM files WHERE stored_name = ?").get(saved.stored_name).id), stored: saved.stored_name };
}

test("rotation en cours : un fichier chiffré avec l'ancienne clé reste lisible dans la console ; l'état des clés le signale", async () => {
  const old = seedOldFile(A, PNG);
  const base = launch({ dataKey: hex(B), previousDataKeys: hex(A) });

  const file = await admin(base, `/files/${old.fileId}`);
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG, "lisible avec la clé précédente");

  const res = await admin(base, "/security");
  assert.equal(res.status, 200);
  const status = await res.json();
  assert.equal(status.current_key_id, security.keyId(B));
  assert.equal(status.files.other, 1);
  assert.equal(status.readable, true);
  const dump = JSON.stringify(status);
  for (const k of [A, B]) assert.ok(!dump.includes(hex(k)) && !dump.includes(k.toString("base64")), "aucune clé dans la réponse");
  assert.equal((await fetch(`${base}/api/admin/security`)).status, 401, "protégé par le jeton admin");
});

test("après « npm run rotate-key » : tout est sur la nouvelle clé et la console lit sans l'ancienne", async () => {
  const store = uploads.createUploadStore({ dir: uploadDir, key: B, previousKeys: [A] });
  const result = uploads.rotateAllFiles({ db, store });
  assert.equal(result.failed.length, 0);
  assert.ok(result.rotated >= 1);

  const base = launch({ dataKey: hex(B) }); // plus d'ancienne clé
  const status = await (await admin(base, "/security")).json();
  assert.deepEqual([status.files.other, status.files.plaintext, status.files.unknown_fingerprint], [0, 0, 0]);
  assert.equal(status.files.current, status.files.total);
  assert.equal(status.readable, true);
  const id = db.prepare("SELECT id FROM files LIMIT 1").get().id;
  assert.deepEqual(Buffer.from(await (await admin(base, `/files/${id}`)).arrayBuffer()), PNG);
});

test("démarrage avec une mauvaise clé : refusé en production, signalé ailleurs ; la clé n'est jamais écrite dans le message", () => {
  assert.throws(
    () => createApp({ adminToken: TOKEN, rateLimits: false, sms, dataKey: hex(C), strictKeys: true }),
    (e) => /DATA_KEY_PREVIOUS/.test(e.message) && e.message.includes(security.keyId(B)) && !e.message.includes(hex(C)) && !e.message.includes(hex(B)),
    "les fichiers existants sont chiffrés avec la clé B : démarrer avec C doit être refusé en nommant l'empreinte de B"
  );
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    assert.doesNotThrow(() => createApp({ adminToken: TOKEN, rateLimits: false, sms, dataKey: hex(C), strictKeys: false }));
  } finally {
    console.warn = orig;
  }
  assert.ok(warnings.some((w) => w.includes("ne peuvent pas être lus") && w.includes(security.keyId(B))));
});

test("fichiers anciens sans empreinte : une mauvaise clé est aussi détectée au démarrage (essai de lecture)", () => {
  db.prepare("DELETE FROM files").run();
  db.prepare("DELETE FROM applications").run();
  seedOldFile(B, PNG, { labelled: false }); // comme les fichiers créés avant l'introduction des empreintes
  assert.throws(() => createApp({ adminToken: TOKEN, rateLimits: false, sms, dataKey: hex(C), strictKeys: true }), /ne peuvent pas être lus|aucune clé/);
  assert.doesNotThrow(() => createApp({ adminToken: TOKEN, rateLimits: false, sms, dataKey: hex(B), strictKeys: true }));
  assert.doesNotThrow(() => createApp({ adminToken: TOKEN, rateLimits: false, sms, dataKey: hex(C), previousDataKeys: hex(B), strictKeys: true }), "avec B en ancienne clé, tout est lisible");
});

test("un envoi fait pendant une rotation est chiffré avec la nouvelle clé et porte son empreinte", async () => {
  db.prepare("DELETE FROM files").run();
  db.prepare("DELETE FROM applications").run();
  fs.readdirSync(uploadDir).forEach((f) => fs.rmSync(path.join(uploadDir, f)));
  const base = launch({ dataKey: hex(B), previousDataKeys: hex(A) });
  const phone = "98123456";
  const fd = new FormData();
  const fields = { full_name: "Ali Ben Salah", phone, cin: "01234567", plate: "123 TUN 4567", governorate: "Tunis", station: "Bab Alioua", line_type: "interregional", line_from: "Tunis", line_to_gov: "Sousse", consent: "true", consent_biometric: "true", lang: "fr", otp_token: await verifiedToken(base, sms, clock, phone) };
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const n of ["cin_front", "cin_back", "permis", "selfie_1", "selfie_2"]) fd.append(n, new Blob([PNG], { type: "image/png" }), `${n}.png`);
  assert.equal((await fetch(`${base}/api/applications`, { method: "POST", body: fd })).status, 201);
  const rows = db.prepare("SELECT enc, key_id FROM files").all();
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.enc === 1 && r.key_id === security.keyId(B)));
});

test("outil en ligne de commande : --status ne modifie rien, la rotation rechiffre, aucune clé n'est affichée", () => {
  // On prépare une base et un dossier à part, dans un sous-processus : le CLI ouvre sa propre base.
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-cli-"));
  try {
    const env = { ...process.env, DATA_DIR: cliDir, DATA_KEY: hex(B), DATA_KEY_PREVIOUS: hex(A) };
    const prep = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { db, UPLOAD_DIR } from "./db.js";
      import { createUploadStore } from "./uploads.js";
      import { parseDataKey } from "./security.js";
      const store = createUploadStore({ dir: UPLOAD_DIR, key: parseDataKey(process.env.DATA_KEY_PREVIOUS) });
      const s = store.save(Buffer.from("PIECE-CLI"), ".png");
      db.prepare("INSERT INTO applications (ref, full_name, phone, cin, role, plate, governorate, station, route, consent_at) VALUES ('LX-CLI0AAAA','T','29000000','99000000','driver','x','Tunis','s','r','2026-01-01')").run();
      db.prepare("INSERT INTO files (application_id, kind, stored_name, mime, size, enc, key_id) VALUES (1,'cin_front',?, 'image/png', 9, 1, ?)").run(s.stored_name, s.key_id);
      db.close();
    `], { cwd: root, env, encoding: "utf8" });
    assert.equal(prep.status, 0, prep.stderr);

    const status = spawnSync(process.execPath, ["rotate-key.js", "--status"], { cwd: root, env, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /1 fichier\(s\) à rechiffrer/);
    assert.ok(status.stdout.includes(security.keyId(B)) && status.stdout.includes(security.keyId(A)), "les empreintes sont affichées");
    const still = spawnSync(process.execPath, ["rotate-key.js", "--status"], { cwd: root, env, encoding: "utf8" });
    assert.match(still.stdout, /1 fichier\(s\) à rechiffrer/, "--status n'a rien modifié");

    const run = spawnSync(process.execPath, ["rotate-key.js"], { cwd: root, env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /1 fichier\(s\) rechiffré\(s\)/);
    assert.match(run.stdout, /ANCIENNES? CLÉS?[\s\S]*retir/i, "rappel : retirer DATA_KEY_PREVIOUS une fois les anciennes sauvegardes expirées");
    const after = spawnSync(process.execPath, ["rotate-key.js", "--status"], { cwd: root, env, encoding: "utf8" });
    assert.match(after.stdout, /0 fichier\(s\) à rechiffrer/);

    for (const out of [status.stdout, run.stdout, after.stdout, status.stderr, run.stderr]) {
      assert.ok(!out.includes(hex(A)) && !out.includes(hex(B)) && !out.includes(A.toString("base64")), "aucune clé affichée");
    }
    const noKey = spawnSync(process.execPath, ["rotate-key.js"], { cwd: root, env: { ...env, DATA_KEY: "" }, encoding: "utf8" });
    assert.equal(noKey.status, 1);
    assert.match(noKey.stderr, /DATA_KEY/);
  } finally {
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
});

test("rotation EN LIGNE : pendant que l'outil rechiffre, le site lit sans jamais renvoyer un fichier faux ou une erreur", { timeout: 60_000 }, async () => {
  db.prepare("DELETE FROM files").run();
  db.prepare("DELETE FROM applications").run();
  fs.readdirSync(uploadDir).forEach((f) => fs.rmSync(path.join(uploadDir, f)));
  const ids = [];
  const contents = new Map();
  for (let i = 0; i < 40; i++) {
    const body = Buffer.concat([PNG, Buffer.from(`-fichier-${i}-`), crypto.randomBytes(2000)]);
    const { fileId } = seedOldFile(A, body);
    ids.push(fileId);
    contents.set(fileId, body);
  }
  const base = launch({ dataKey: hex(B), previousDataKeys: hex(A) }); // le site tourne déjà avec les deux clés (étape 4 de la procédure)
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["rotate-key.js"], { cwd: root, env: { ...process.env, DATA_DIR: dataDir, DATA_KEY: hex(B), DATA_KEY_PREVIOUS: hex(A) } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const finished = new Promise((resolve) => child.on("exit", resolve));

  let reads = 0;
  const problems = [];
  let done = false;
  finished.then(() => { done = true; });
  while (!done || reads < ids.length * 2) {
    for (const id of ids) {
      const r = await admin(base, `/files/${id}`);
      reads += 1;
      if (r.status !== 200) problems.push(`fichier ${id} : statut ${r.status}`);
      else if (!Buffer.from(await r.arrayBuffer()).equals(contents.get(id))) problems.push(`fichier ${id} : contenu différent`);
    }
  }
  assert.equal(await finished, 0, out);
  assert.deepEqual(problems, []);
  assert.ok(reads >= ids.length * 2);
  assert.match(out, /40 fichier\(s\) rechiffré\(s\)/);
  const status = await (await admin(base, "/security")).json();
  assert.equal(status.files.current, 40);
});
