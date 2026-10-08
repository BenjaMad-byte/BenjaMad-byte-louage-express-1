import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { base32Decode, hotp, stepOf } from "../totp.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ops-"));
process.env.DATA_DIR = dataDir;
const LEGACY = "ops-legacy-admin-token-0123456789abc";
const OPS_KEY = "ops-key-0123456789abcdef";
const PW = "correct horse battery";
let db, app, server, base, noOpsServer, noOpsBase;
let clock = Date.parse("2026-10-08T10:00:00Z");
const seen = []; // appels reçus par la fausse application chauffeur
let appDown = false;
let appStatus = null;

const fakeFetch = async (url, opts = {}) => {
  seen.push({ url: String(url), method: opts.method ?? "GET", key: opts.headers?.["X-Service-Key"], body: opts.body ? JSON.parse(opts.body) : null });
  if (appDown) throw new TypeError("fetch failed");
  const u = new URL(url);
  const json = (status, body) => ({ status, json: async () => body });
  if (appStatus) return json(appStatus, { error: "x" });
  if (u.pathname.endsWith("/overview")) return json(200, { drivers: { total: 2, active: 2 }, lines: [], sos: [{ id: "s1", status: "open", full_name: "Test" }] });
  if (/\/sos\/[^/]+\/(ack|resolve)$/.test(u.pathname)) return json(200, { ok: true });
  if (u.pathname.endsWith("/drivers/sync")) return json(200, { updated: 2, deactivated: 0 });
  return json(404, {});
};

before(async () => {
  const { createApp } = await import("../server.js");
  ({ db } = await import("../db.js"));
  const common = { adminToken: LEGACY, rateLimits: false, forceHttps: false, dataKey: null, sms: { async send() {} }, now: () => clock };
  app = createApp({ ...common, appOps: { url: "http://app.local:4200/", key: OPS_KEY, fetchImpl: fakeFetch } });
  const bare = createApp({ ...common, appOps: { url: "", key: "" } });
  server = app.listen(0);
  noOpsServer = bare.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  noOpsBase = `http://127.0.0.1:${noOpsServer.address().port}`;
});
after(() => {
  server.close();
  noOpsServer.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  seen.length = 0;
  appDown = false;
  appStatus = null;
});

const call = (b, method, url, { token, body } = {}) =>
  fetch(`${b}/api/admin${url}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const code = (secret) => hotp(base32Decode(secret), stepOf(clock));

test("mode installation (jeton partagé) : la vue d'ensemble est relayée avec la clé de service, rien d'autre ne fuit", async () => {
  const r = await call(base, "GET", "/ops/overview", { token: LEGACY });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).drivers.active, 2);
  assert.deepEqual(seen.map((s) => [s.url, s.method, s.key]), [["http://app.local:4200/api/ops/overview", "GET", OPS_KEY]], "adresse nettoyée, clé de service transmise");
  assert.equal((await call(base, "GET", "/ops/overview")).status, 401, "sans connexion : refusé, l'application chauffeur n'est même pas appelée");
  assert.equal(seen.length, 1);
});

test("l'accusé de réception d'un SOS porte le NOM du compte connecté, jamais une valeur envoyée par le navigateur", async () => {
  const r = await call(base, "POST", "/ops/sos/abc-123/ack", { token: LEGACY, body: { by: "quelqu'un d'autre" } });
  assert.equal(r.status, 200);
  assert.deepEqual(seen[0].body, { by: "jeton-admin" });
  assert.equal(seen[0].url, "http://app.local:4200/api/ops/sos/abc-123/ack");
  const res = await call(base, "POST", "/ops/sos/abc-123/resolve", { token: LEGACY, body: { note: "Chauffeur joint, tout va bien", by: "faux" } });
  assert.equal(res.status, 200);
  assert.deepEqual(seen[1].body, { by: "jeton-admin", note: "Chauffeur joint, tout va bien" });
  const odd = await call(base, "POST", "/ops/sos/..%2F..%2Fdrivers/ack", { token: LEGACY, body: {} });
  assert.ok(seen.at(-1)?.url.includes("..%2F..%2Fdrivers") || odd.status >= 400, "l'identifiant est encodé : pas d'échappement vers une autre route");
  const audit = db.prepare("SELECT action, ref, actor FROM admin_audit WHERE action LIKE 'sos_%' ORDER BY id").all().map((x) => ({ ...x }));
  assert.deepEqual(audit.slice(0, 2), [{ action: "sos_ack", ref: "abc-123", actor: "jeton-admin" }, { action: "sos_resolve", ref: "abc-123", actor: "jeton-admin" }]);
});

test("application chauffeur injoignable, en erreur ou qui refuse la clé : réponse claire, jamais de trace d'appel ni de clé", async () => {
  appDown = true;
  const down = await call(base, "GET", "/ops/overview", { token: LEGACY });
  assert.deepEqual([down.status, (await down.json()).error], [503, "ops_unavailable"]);
  appDown = false;
  appStatus = 401;
  const refused = await call(base, "GET", "/ops/overview", { token: LEGACY });
  assert.equal(refused.status, 502, "clé refusée par l'application chauffeur : erreur de passerelle, pas un 401 qui déconnecterait l'administrateur");
  appStatus = 500;
  assert.equal((await call(base, "GET", "/ops/overview", { token: LEGACY })).status, 502);
  assert.ok(!JSON.stringify(await (await call(base, "GET", "/ops/overview", { token: LEGACY })).json()).includes(OPS_KEY));
});

test("non configuré (APP_URL / APP_OPS_KEY absents) : 503 sans aucun appel", async () => {
  const r = await call(noOpsBase, "GET", "/ops/overview", { token: LEGACY });
  assert.deepEqual([r.status, (await r.json()).error], [503, "ops_unavailable"]);
  assert.equal(seen.length, 0);
});

test("comptes nominatifs : un relecteur peut suivre et accuser réception d'un SOS (la permanence), seul un propriétaire déclenche la synchronisation des chauffeurs ; l'acteur du journal est le compte", async () => {
  // Premier compte (propriétaire) puis un relecteur, activés par l'API.
  const onboard = async (creator, username, role) => {
    const created = await (await call(base, "POST", "/users", { token: creator, body: { username, role } })).json();
    const first = await (await call(base, "POST", "/login", { body: { username, password: created.temp_password } })).json();
    await call(base, "POST", "/me/password", { token: first.token, body: { current: created.temp_password, next: PW } });
    const { secret } = await (await call(base, "POST", "/2fa/setup", { token: first.token })).json();
    await call(base, "POST", "/2fa/confirm", { token: first.token, body: { code: code(secret) } });
    clock += 31_000;
    const login = await (await call(base, "POST", "/login", { body: { username, password: PW, code: code(secret) } })).json();
    clock += 31_000;
    return login.token;
  };
  const owner = await onboard(LEGACY, "alice", "owner");
  const reviewer = await onboard(owner, "bob", "reviewer");

  assert.equal((await call(base, "GET", "/ops/overview", { token: reviewer })).status, 200);
  assert.equal((await call(base, "POST", "/ops/sos/s1/ack", { token: reviewer })).status, 200);
  assert.deepEqual(seen.at(-1).body, { by: "bob" });
  assert.equal((await call(base, "POST", "/ops/drivers/sync", { token: reviewer })).status, 403);
  assert.equal((await call(base, "POST", "/ops/drivers/sync", { token: owner })).status, 200);
  assert.equal((await call(base, "POST", "/ops/sos/s1/ack", { token: LEGACY })).status, 401, "le jeton partagé ne donne plus aucun accès");
  const who = db.prepare("SELECT action, actor FROM admin_audit WHERE action IN ('sos_ack','ops_drivers_sync') ORDER BY id DESC").all().map((x) => ({ ...x }));
  assert.deepEqual(who.slice(0, 2), [{ action: "ops_drivers_sync", actor: "alice" }, { action: "sos_ack", actor: "bob" }]);
});
