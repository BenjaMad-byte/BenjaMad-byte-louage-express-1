import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { stubSms, makeClock, verifiedToken } from "./_helpers.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-sec-"));
process.env.DATA_DIR = dataDir;
const TOKEN = "t".repeat(40);
const KEY = crypto.randomBytes(32).toString("hex");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("VISAGE-ET-CIN-EN-CLAIR"), Buffer.alloc(32, 7)]);
const sms = stubSms();
const clock = makeClock();

let createApp, db, uploadDir;
const servers = [];
const started = (app) => {
  const server = app.listen(0);
  servers.push(server);
  return { app, base: `http://127.0.0.1:${server.address().port}`, port: server.address().port };
};
const launch = (opts = {}) => started(createApp({ adminToken: TOKEN, rateLimits: false, sms, now: clock.now, dataKey: KEY, ...opts }));

before(async () => {
  ({ createApp } = await import("../server.js"));
  ({ db, UPLOAD_DIR: uploadDir } = await import("../db.js"));
});

after(async () => {
  for (const s of servers) s.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Requête HTTP brute : permet d'envoyer des en-têtes de navigateur (Origin, Sec-Fetch-Site) qu'un client fetch refuse. */
function raw(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const json = (r) => JSON.parse(r.body.toString("utf8"));

async function registerOne(base, over = {}) {
  const phone = over.phone ?? "98123456";
  const fd = new FormData();
  const fields = {
    full_name: "Ali Ben Salah", phone, cin: over.cin ?? "01234567", plate: "123 TUN 4567", governorate: "Tunis", station: "Bab Alioua",
    line_type: "interregional", line_from: "Tunis", line_to_gov: "Sousse", consent: "true", consent_biometric: "true", lang: "fr",
    otp_token: await verifiedToken(base, sms, clock, phone),
  };
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const name of ["cin_front", "cin_back", "permis", "selfie_1", "selfie_2"]) fd.append(name, new Blob([PNG], { type: "image/png" }), `${name}.png`);
  const res = await fetch(`${base}/api/applications`, { method: "POST", body: fd });
  assert.equal(res.status, 201);
  return (await res.json()).ref;
}
const adminGet = (base, p, token = TOKEN) => fetch(`${base}/api/admin${p}`, { headers: { Authorization: `Bearer ${token}` } });

let ref;

test("fichiers chiffrés au repos : rien en clair sur le disque, l'admin les relit intacts, le worker KYC aussi", async () => {
  const sent = [];
  const kycFetch = async (_url, opts) => {
    if (opts.method === "POST") sent.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ status: "review", faceMatch: { score: 0.5, provider: "x", isRealBiometric: false }, liveness: { passed: true }, ocrCin: { rawText: "01234567", confidence: 90 }, reasons: [] }) };
  };
  const { app, base } = launch({ kycFetch });
  ref = await registerOne(base);

  const names = fs.readdirSync(uploadDir);
  assert.equal(names.length, 5);
  for (const n of names) {
    const bytes = fs.readFileSync(path.join(uploadDir, n));
    assert.ok(!bytes.includes("VISAGE-ET-CIN-EN-CLAIR"), `${n} ne contient pas le contenu en clair`);
    assert.notDeepEqual(bytes.subarray(0, 4), PNG.subarray(0, 4), `${n} ne commence pas par l'en-tête PNG`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE enc = 1").get().n, 5);

  const detail = await (await adminGet(base, `/applications/${ref}`)).json();
  const file = await adminGet(base, `/files/${detail.files[0].id}`);
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG, "l'admin récupère le fichier d'origine");
  assert.equal(file.headers.get("cache-control"), "no-store");
  assert.equal(file.headers.get("x-content-type-options"), "nosniff");
  assert.match(file.headers.get("content-security-policy"), /sandbox/);

  await app.locals.kyc.drain();
  assert.equal(sent.length, 1, "le worker a envoyé la demande au backend KYC");
  assert.equal(sent[0].cinPhoto, `data:image/png;base64,${PNG.toString("base64")}`, "le worker déchiffre avant d'envoyer");
});

test("sans clé de chiffrement (développement) : les fichiers restent lisibles, avec un avertissement au démarrage", async () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    const { base } = launch({ dataKey: null });
    const before = db.prepare("SELECT COUNT(*) AS n FROM files WHERE enc = 0").get().n;
    await registerOne(base, { phone: "55111222", cin: "11111111" });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE enc = 0").get().n, before + 5);
  } finally {
    console.warn = orig;
  }
  assert.ok(warnings.some((w) => w.includes("DATA_KEY")), "avertissement DATA_KEY");
});

test("requêtes d'écriture venues d'un autre site : refusées (403) ; même origine ou client sans Origin : acceptées", async () => {
  const { port } = launch();
  const j = { "Content-Type": "application/json" };
  const body = JSON.stringify({ phone: "123" }); // invalide : on teste seulement que la requête atteint la validation (400)
  const evil = await raw(port, "POST", "/api/otp/send", { headers: { ...j, Origin: "https://evil.example" }, body });
  assert.equal(evil.status, 403);
  assert.deepEqual(json(evil), { error: "origin_forbidden" });
  const cross = await raw(port, "POST", "/api/otp/send", { headers: { ...j, "Sec-Fetch-Site": "cross-site" }, body });
  assert.equal(cross.status, 403);
  const same = await raw(port, "POST", "/api/otp/send", { headers: { ...j, Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" }, body });
  assert.equal(same.status, 400);
  const none = await raw(port, "POST", "/api/otp/send", { headers: j, body });
  assert.equal(none.status, 400);
  const read = await raw(port, "GET", "/api/config", { headers: { Origin: "https://evil.example" } });
  assert.equal(read.status, 200);
});

test("erreurs : JSON invalide → 400, trop gros → 413, jamais de trace d'appel", async () => {
  const { port } = launch();
  const j = { "Content-Type": "application/json" };
  const bad = await raw(port, "POST", "/api/otp/send", { headers: j, body: "{pas du json" });
  assert.equal(bad.status, 400);
  assert.deepEqual(json(bad), { error: "bad_request" });
  assert.ok(!bad.body.toString().includes(" at "), "pas de pile d'appels");
  const big = await raw(port, "POST", "/api/otp/send", { headers: j, body: JSON.stringify({ phone: "9".repeat(30_000) }) });
  assert.equal(big.status, 413);
  assert.deepEqual(json(big), { error: "too_large" });
});

test("réponses d'API : jamais mises en cache, jamais indexées", async () => {
  const { base } = launch();
  for (const p of ["/api/config", "/api/admin/applications"]) {
    const r = await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.headers.get("cache-control"), "no-store", p);
    assert.match(r.headers.get("x-robots-tag"), /noindex/, p);
  }
});

test("jeton admin : trop court refusé au démarrage ; échecs répétés bloqués (429), succès jamais comptés", async () => {
  assert.throws(() => createApp({ adminToken: "abc", rateLimits: false, sms }), /ADMIN_TOKEN/);

  const limited = launch({ rateLimits: true });
  for (let i = 0; i < 10; i++) assert.equal((await adminGet(limited.base, "/applications", "faux-" + i)).status, 401);
  assert.equal((await adminGet(limited.base, "/applications", "encore-faux")).status, 429, "11e échec bloqué");

  const fine = launch({ rateLimits: true });
  for (let i = 0; i < 15; i++) assert.equal((await adminGet(fine.base, "/applications")).status, 200);
  assert.equal((await adminGet(fine.base, "/applications", "faux")).status, 401, "les succès n'ont pas consommé le quota d'échecs");
});

test("liste blanche d'IP admin : les autres sont refusées même avec le bon jeton", async () => {
  const blocked = launch({ adminAllowedIps: ["10.9.9.9"] });
  const r = await adminGet(blocked.base, "/applications");
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: "forbidden" });
  const allowed = launch({ adminAllowedIps: ["127.0.0.1", "::1"] });
  assert.equal((await adminGet(allowed.base, "/applications")).status, 200);
});

test("journal d'audit : chaque consultation de dossier ou de pièce est tracée, sans données personnelles", async () => {
  const { base } = launch();
  const detail = await (await adminGet(base, `/applications/${ref}`)).json();
  await adminGet(base, `/files/${detail.files[0].id}`);
  await adminGet(base, "/network.csv");
  const res = await adminGet(base, "/audit?limit=50");
  assert.equal(res.status, 200);
  const { entries } = await res.json();
  const actions = entries.map((e) => e.action);
  for (const a of ["application_view", "file_view", "network_export"]) assert.ok(actions.includes(a), a);
  assert.ok(entries.some((e) => e.action === "file_view" && e.ref === ref));
  for (const e of entries) assert.deepEqual(Object.keys(e).sort(), ["action", "actor", "at", "id", "ip", "ref"]);
  assert.ok(entries.filter((e) => e.action !== "retention_purge").every((e) => e.actor === "jeton-admin"), "installation sans compte : l'acteur est le jeton partagé");
  const dump = JSON.stringify(entries);
  assert.ok(!dump.includes("Ali Ben Salah") && !dump.includes("98123456") && !dump.includes("01234567"), "aucune donnée personnelle dans le journal");
});

test("HTTPS : redirigé en lecture, refusé en écriture, accepté derrière un proxy qui l'annonce", async () => {
  const { port } = launch({ forceHttps: true, trustProxy: 1 });
  const get = await raw(port, "GET", "/api/config");
  assert.equal(get.status, 308);
  assert.equal(get.headers.location, `https://127.0.0.1:${port}/api/config`);
  const post = await raw(port, "POST", "/api/otp/send", { headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(post.status, 400);
  assert.deepEqual(json(post), { error: "https_required" });
  const ok = await raw(port, "GET", "/api/config", { headers: { "X-Forwarded-Proto": "https" } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers["strict-transport-security"], /max-age=\d+/);
  assert.match(ok.headers["content-security-policy"], /upgrade-insecure-requests/);
});

test("envoi démesuré : refusé (413) dès l'en-tête, avant de lire le corps en mémoire", async () => {
  const { port } = launch();
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/api/applications", headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": String(60 * 1024 * 1024) } },
      (res) => { resolve(res.statusCode); req.destroy(); }
    );
    req.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
    req.write("--x\r\n");
  });
  assert.equal(status, 413);
});
