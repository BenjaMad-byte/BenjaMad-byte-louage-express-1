import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateSecrets } from "../deploy/secrets.js";
import { parseEnvFile, checkConfig } from "../deploy/check-config.js";
import { assertProductionConfig } from "../security.js";
import { LEGAL_ENV } from "./legal-fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-test-"));
const dataDir = path.join(tmp, "data");
fs.mkdirSync(dataDir);
process.env.DATA_DIR = dataDir;

let server, db;
before(async () => {
  const { createApp } = await import("../server.js");
  ({ db } = await import("../db.js"));
  server = createApp({ adminToken: "healthz-test-token-123", rateLimits: false, forceHttps: true, trustProxy: 1, dataKey: null, sms: { name: "stub", send: async () => {} } }).listen(0);
});
after(() => {
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("secrets générés : assez longs, aléatoires, acceptés par la vérification de production", () => {
  const a = generateSecrets();
  const b = generateSecrets();
  assert.match(a.DATA_KEY, /^[0-9a-f]{64}$/);
  assert.ok(a.ADMIN_TOKEN.length >= 32 && a.OTP_SECRET.length >= 32 && a.KYC_SERVICE_KEY.length >= 16);
  for (const k of Object.keys(a)) assert.notEqual(a[k], b[k], `${k} change à chaque appel`);
  assert.doesNotThrow(() => assertProductionConfig({ NODE_ENV: "production", ...a, KYC_BACKEND_URL: "http://localhost:4000", SMS_PROVIDER: "twilio", TRUST_PROXY: "1", PUBLIC_URL: "https://inscription.exemple.tn", ...LEGAL_ENV }));
});

test("parseEnvFile : commentaires, guillemets, export, valeurs contenant « = »", () => {
  const env = parseEnvFile(`# commentaire
NODE_ENV=production
export PORT=4100
ADMIN_TOKEN="abc=def=="
WHATSAPP_NUMBER='21698123456'

  ESPACES = avant et après
VIDE=
ligne sans egal
`);
  assert.deepEqual(env, { NODE_ENV: "production", PORT: "4100", ADMIN_TOKEN: "abc=def==", WHATSAPP_NUMBER: "21698123456", ESPACES: "avant et après", VIDE: "" });
});

test("le fichier d'exemple est complet : avec de vrais secrets et un vrai fournisseur SMS, il passe la vérification de production", () => {
  const example = parseEnvFile(fs.readFileSync(path.join(root, "deploy", "portal.env.example"), "utf8"));
  assert.equal(example.NODE_ENV, "production");
  assert.equal(example.HOST, "127.0.0.1");
  assert.equal(example.TRUST_PROXY, "1");
  const filled = { ...example, ...generateSecrets(), ...LEGAL_ENV, TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM: "+15550001111" };
  const { errors } = checkConfig(filled);
  assert.deepEqual(errors, []);
  // Les valeurs d'exemple (à remplacer) ne doivent jamais passer telles quelles.
  assert.ok(checkConfig(example).errors.length > 0, "l'exemple brut est refusé : il contient des valeurs à remplacer");
});

test("checkConfig : erreurs bloquantes, avertissements non bloquants", () => {
  const good = { ...generateSecrets(), NODE_ENV: "production", SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "+1555", TRUST_PROXY: "1", PUBLIC_URL: "https://inscription.exemple.tn", ...LEGAL_ENV, HOST: "127.0.0.1", DATA_DIR: "/srv/louage/data", ADMIN_ALLOWED_IPS: "203.0.113.9" };
  const ok = checkConfig(good);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.warnings, []);

  const warned = checkConfig({ ...good, ADMIN_ALLOWED_IPS: "", HOST: "0.0.0.0", DATA_DIR: "data" });
  assert.deepEqual(warned.errors, []);
  assert.equal(warned.warnings.length, 3);

  const noTwilio = checkConfig({ ...good, TWILIO_AUTH_TOKEN: "" });
  assert.ok(noTwilio.errors.some((e) => e.includes("TWILIO")));
});

test("check-config en ligne de commande : code 0 si valide, 1 sinon, aucun secret affiché", () => {
  const secrets = generateSecrets();
  const file = path.join(tmp, "good.env");
  const lines = Object.entries({ ...secrets, NODE_ENV: "production", SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "+1555", TRUST_PROXY: "1", PUBLIC_URL: "https://inscription.exemple.tn", ...LEGAL_ENV, HOST: "127.0.0.1", DATA_DIR: "/srv/louage/data" }).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(file, lines.join("\n"), { mode: 0o600 });
  const okRun = spawnSync(process.execPath, [path.join(root, "deploy", "check-config.js"), file], { encoding: "utf8" });
  assert.equal(okRun.status, 0, okRun.stderr + okRun.stdout);
  assert.match(okRun.stdout, /Configuration valide/);
  for (const v of Object.values(secrets)) assert.ok(!okRun.stdout.includes(v) && !okRun.stderr.includes(v), "un secret a été affiché");

  const badFile = path.join(tmp, "bad.env");
  fs.writeFileSync(badFile, "NODE_ENV=production\nADMIN_TOKEN=court\n");
  const badRun = spawnSync(process.execPath, [path.join(root, "deploy", "check-config.js"), badFile], { encoding: "utf8" });
  assert.equal(badRun.status, 1);
  assert.match(badRun.stderr, /DATA_KEY/);
  assert.ok(!badRun.stderr.includes("court"), "la valeur du jeton n'est pas affichée");

  assert.equal(spawnSync(process.execPath, [path.join(root, "deploy", "check-config.js"), path.join(tmp, "absent.env")], { encoding: "utf8" }).status, 1);
});

test("/healthz : répond sans HTTPS ni donnée (sonde locale du proxy ou de la supervision)", async () => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("checkConfig : une rotation de clé en cours est signalée (avertissement, pas une erreur) ; une ancienne clé identique à la courante est refusée", () => {
  const secrets = generateSecrets();
  const base = { ...secrets, NODE_ENV: "production", SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "+1555", TRUST_PROXY: "1", PUBLIC_URL: "https://inscription.exemple.tn", ...LEGAL_ENV, HOST: "127.0.0.1", DATA_DIR: "/srv/louage/data", ADMIN_ALLOWED_IPS: "203.0.113.9" };
  const old = generateSecrets().DATA_KEY;
  const rotating = checkConfig({ ...base, DATA_KEY_PREVIOUS: old });
  assert.deepEqual(rotating.errors, []);
  assert.equal(rotating.warnings.length, 1);
  assert.match(rotating.warnings[0], /rotate-key/);
  assert.ok(!rotating.warnings[0].includes(old), "l'avertissement ne révèle pas la clé");
  assert.ok(checkConfig({ ...base, DATA_KEY_PREVIOUS: secrets.DATA_KEY }).errors.some((e) => e.includes("DATA_KEY_PREVIOUS")));
});

test("check-config : SMS de notification activés sans vrai fournisseur ou sans plafond = avertissement", () => {
  const example = parseEnvFile(fs.readFileSync(path.join(root, "deploy", "portal.env.example"), "utf8"));
  const filled = { ...example, ...generateSecrets(), ...LEGAL_ENV, TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM: "+15550001111" };
  assert.equal(example.SMS_NOTIFICATIONS, "off", "désactivés par défaut dans le fichier d'exemple");
  assert.deepEqual(checkConfig(filled).warnings.filter((w) => w.includes("SMS_NOTIFICATIONS")), []);
  const on = checkConfig({ ...filled, SMS_NOTIFICATIONS: "on", NOTIFY_DAILY_CAP: "" }).warnings.join(" | ");
  assert.match(on, /NOTIFY_DAILY_CAP/);
  assert.match(checkConfig({ ...filled, SMS_NOTIFICATIONS: "on", SMS_PROVIDER: "console" }).warnings.join(" | "), /fournisseur SMS réel/);
});
