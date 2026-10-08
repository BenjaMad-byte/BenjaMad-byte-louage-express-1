import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { encryptBuffer, decryptBuffer, parseDataKey, assertProductionConfig, sameOriginGuard, isAllowedAdminIp } from "../security.js";
import { createUploadStore } from "../uploads.js";
import { LEGAL_ENV } from "./legal-fixture.js";

const KEY = crypto.randomBytes(32);

test("chiffrement : aller-retour, IV aléatoire, falsification et mauvaise clé détectées", () => {
  const plain = Buffer.from("photo de CIN 01234567");
  const a = encryptBuffer(plain, KEY);
  const b = encryptBuffer(plain, KEY);
  assert.ok(!a.includes(plain), "le clair n'apparaît pas dans le fichier chiffré");
  assert.notDeepEqual(a, b, "deux chiffrements du même contenu diffèrent (IV aléatoire)");
  assert.deepEqual(decryptBuffer(a, KEY), plain);

  const tampered = Buffer.from(a);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptBuffer(tampered, KEY), "un octet modifié est détecté (GCM)");
  assert.throws(() => decryptBuffer(a, crypto.randomBytes(32)), "mauvaise clé refusée");
  assert.throws(() => decryptBuffer(Buffer.alloc(10), KEY), "fichier trop court refusé");
});

test("parseDataKey : 32 octets en hexadécimal ou en base64, sinon refus", () => {
  assert.deepEqual(parseDataKey(KEY.toString("hex")), KEY);
  assert.deepEqual(parseDataKey(KEY.toString("base64")), KEY);
  assert.equal(parseDataKey(undefined), null);
  assert.equal(parseDataKey(""), null);
  assert.throws(() => parseDataKey("trop-court"), /DATA_KEY/);
  assert.throws(() => parseDataKey(crypto.randomBytes(16).toString("hex")), /DATA_KEY/);
});

test("stockage des fichiers : chiffré sur le disque quand une clé existe, en clair sinon", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
  try {
    const secret = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("visage-du-chauffeur")]);

    const enc = createUploadStore({ dir, key: KEY });
    const e = enc.save(secret, ".png");
    assert.equal(e.enc, 1);
    assert.match(e.stored_name, /^[0-9a-f]{32}\.png$/);
    assert.ok(!fs.readFileSync(path.join(dir, e.stored_name)).includes("visage-du-chauffeur"), "le disque ne contient pas le clair");
    assert.deepEqual(enc.read(e), secret);

    const plainStore = createUploadStore({ dir, key: null });
    const p = plainStore.save(secret, ".png");
    assert.equal(p.enc, 0);
    assert.deepEqual(plainStore.read(p), secret);
    assert.throws(() => plainStore.read(e), /DATA_KEY/, "lire un fichier chiffré sans clé échoue clairement");

    enc.remove(e.stored_name);
    assert.equal(fs.existsSync(path.join(dir, e.stored_name)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("configuration de production : tout ce qui manque est listé d'un coup", () => {
  const good = {
    NODE_ENV: "production", ADMIN_TOKEN: "a".repeat(32), DATA_KEY: KEY.toString("hex"), OTP_SECRET: "o".repeat(32),
    KYC_SERVICE_KEY: "k".repeat(24), KYC_BACKEND_URL: "https://kyc.example.tn", SMS_PROVIDER: "twilio", TRUST_PROXY: "1", PUBLIC_URL: "https://inscription.exemple.tn", ...LEGAL_ENV,
  };
  assert.doesNotThrow(() => assertProductionConfig(good));
  assert.doesNotThrow(() => assertProductionConfig({ ...good, NODE_ENV: "development", ADMIN_TOKEN: undefined, DATA_KEY: undefined }), "rien d'exigé hors production");

  let message = "";
  try {
    assertProductionConfig({ NODE_ENV: "production", ADMIN_TOKEN: "court", KYC_BACKEND_URL: "http://kyc.example.tn" });
  } catch (e) {
    message = e.message;
  }
  for (const needle of ["ADMIN_TOKEN", "DATA_KEY", "OTP_SECRET", "KYC_SERVICE_KEY", "KYC_BACKEND_URL", "SMS_PROVIDER", "TRUST_PROXY", "PUBLIC_URL"]) {
    assert.ok(message.includes(needle), `${needle} signalé`);
  }
  assert.doesNotThrow(() => assertProductionConfig({ ...good, KYC_BACKEND_URL: "http://localhost:4000" }), "http reste permis vers localhost (même machine)");
});

test("sameOriginGuard : bloque les requêtes d'écriture venues d'un autre site, laisse passer le reste", () => {
  const guard = sameOriginGuard({ allowed: ["https://admin.example.tn"] });
  const run = (method, headers) => {
    let out = { next: false };
    const req = { method, get: (h) => headers[h.toLowerCase()] };
    const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
    guard(req, res, () => { out.next = true; });
    return out;
  };
  const host = { host: "portail.example.tn" };
  assert.equal(run("POST", { ...host, origin: "https://evil.example" }).status, 403);
  assert.equal(run("PATCH", { ...host, "sec-fetch-site": "cross-site" }).status, 403);
  assert.equal(run("DELETE", { ...host, "sec-fetch-site": "same-site" }).status, 403);
  assert.equal(run("POST", { ...host, origin: "https://portail.example.tn" }).next, true);
  assert.equal(run("POST", { ...host, origin: "https://admin.example.tn" }).next, true, "origine autorisée explicitement");
  assert.equal(run("POST", { ...host, "sec-fetch-site": "same-origin" }).next, true);
  assert.equal(run("POST", host).next, true, "sans Origin (client non navigateur) : autorisé, les autres protections s'appliquent");
  assert.equal(run("GET", { ...host, origin: "https://evil.example" }).next, true, "la lecture n'est pas concernée");
  assert.equal(run("POST", { ...host, origin: "null" }).status, 403, "Origin: null refusé");
  assert.equal(run("POST", { ...host, origin: "pas une url" }).status, 403);
});

test("isAllowedAdminIp : liste vide = pas de restriction ; IPv4 mappée en IPv6 reconnue", () => {
  assert.equal(isAllowedAdminIp("203.0.113.9", []), true);
  assert.equal(isAllowedAdminIp("203.0.113.9", ["203.0.113.9"]), true);
  assert.equal(isAllowedAdminIp("::ffff:203.0.113.9", ["203.0.113.9"]), true);
  assert.equal(isAllowedAdminIp("198.51.100.1", ["203.0.113.9"]), false);
  assert.equal(isAllowedAdminIp(undefined, ["203.0.113.9"]), false);
});

test("migration : les fichiers restés en clair sont chiffrés sur place, une seule fois", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { rotateAllFiles } = await import("../uploads.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-"));
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE files (id INTEGER PRIMARY KEY, stored_name TEXT, enc INTEGER NOT NULL DEFAULT 0, key_id TEXT)");
    const store = createUploadStore({ dir, key: KEY });
    const clear = createUploadStore({ dir, key: null }).save(Buffer.from("CIN-EN-CLAIR"), ".png");
    const already = store.save(Buffer.from("DEJA-CHIFFRE"), ".png");
    db.prepare("INSERT INTO files (stored_name, enc, key_id) VALUES (?, ?, ?)").run(clear.stored_name, 0, null);
    db.prepare("INSERT INTO files (stored_name, enc, key_id) VALUES (?, ?, ?)").run(already.stored_name, 1, already.key_id);

    assert.equal(rotateAllFiles({ db, store }).rotated, 1);
    assert.ok(!fs.readFileSync(path.join(dir, clear.stored_name)).includes("CIN-EN-CLAIR"), "plus rien en clair");
    const row = db.prepare("SELECT stored_name, enc, key_id FROM files WHERE stored_name = ?").get(clear.stored_name);
    assert.deepEqual(store.read(row), Buffer.from("CIN-EN-CLAIR"));
    assert.equal(rotateAllFiles({ db, store }).rotated, 0, "idempotent");
    assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")).length, 0, "aucun fichier temporaire oublié");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
