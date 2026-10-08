import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { base32Decode, hotp, stepOf } from "../totp.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-accounts-"));
process.env.DATA_DIR = dataDir;
const LEGACY = "legacy-admin-token-0123456789abcdef";
const PW = "correct horse battery";
let clock = Date.parse("2026-10-07T10:00:00Z");
let server, db, base;

before(async () => {
  const { createApp } = await import("../server.js");
  ({ db } = await import("../db.js"));
  server = createApp({ adminToken: LEGACY, rateLimits: false, forceHttps: false, dataKey: null, sms: { async send() {} }, now: () => clock }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const t of ["admin_sessions", "admin_recovery_codes", "admin_users", "admin_audit", "applications"]) db.exec(`DELETE FROM ${t}`);
  clock += 120_000;
});

const call = (method, url, { token, body } = {}) =>
  fetch(`${base}/api/admin${url}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (res) => ({ status: res.status, body: await res.json() });
const code = (secret) => hotp(base32Decode(secret), stepOf(clock));

/** Crée un compte (par `creatorToken`) puis le fait passer par la première connexion complète ; renvoie sa session et son secret TOTP. */
async function onboard(creatorToken, username, role) {
  const created = await json(await call("POST", "/users", { token: creatorToken, body: { username, display_name: username.toUpperCase(), role } }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const first = await json(await call("POST", "/login", { body: { username, password: created.body.temp_password } }));
  assert.deepEqual([first.status, first.body.scope], [200, "setup"]);
  const t = first.body.token;
  assert.equal((await call("POST", "/me/password", { token: t, body: { current: created.body.temp_password, next: PW } })).status, 200);
  const { secret } = await (await call("POST", "/2fa/setup", { token: t })).json();
  const done = await json(await call("POST", "/2fa/confirm", { token: t, body: { code: code(secret) } }));
  assert.deepEqual([done.status, done.body.scope, done.body.needs], [200, "full", []]);
  return { token: t, secret, id: created.body.user.id, recovery: done.body.recovery_codes, username };
}
const loginFull = async (u) => {
  clock += 30_000;
  const r = await json(await call("POST", "/login", { body: { username: u.username, password: PW, code: code(u.secret) } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
};
async function bootstrapOwner() {
  assert.equal((await json(await call("GET", "/mode"))).body.accounts, false);
  return onboard(LEGACY, "alice", "owner");
}

test("installation initiale : le jeton partagé sert à créer le premier compte (propriétaire obligatoire), puis il ne donne plus aucun accès", async () => {
  assert.equal((await call("POST", "/login", { body: { username: "a", password: "b" } })).status, 409, "pas encore de compte");
  assert.deepEqual((await json(await call("GET", "/me", { token: LEGACY }))).body, { user: { username: "jeton-admin", role: "owner" }, scope: "full", needs: [], legacy: true });
  assert.equal((await call("POST", "/me/password", { token: LEGACY, body: {} })).status, 409);
  assert.equal((await json(await call("POST", "/users", { token: LEGACY, body: { username: "bob", role: "reviewer" } }))).body.error, "first_must_be_owner");

  const alice = await onboard(LEGACY, "alice", "owner");
  assert.equal((await json(await call("GET", "/mode"))).body.accounts, true);
  for (const url of ["/applications", "/users", "/audit", "/security", "/me"]) assert.equal((await call("GET", url, { token: LEGACY })).status, 401, `${url} avec le jeton partagé`);
  assert.equal((await call("GET", "/applications", { token: alice.token })).status, 200);
});

test("première connexion : session limitée (403 « setup_required » partout sauf mot de passe / 2FA), puis accès complet", async () => {
  const alice = await bootstrapOwner();
  const created = await json(await call("POST", "/users", { token: alice.token, body: { username: "bob", role: "reviewer" } }));
  const login = await json(await call("POST", "/login", { body: { username: "bob", password: created.body.temp_password } }));
  assert.deepEqual([login.body.scope, login.body.needs], ["setup", ["password", "totp"]]);
  const t = login.body.token;
  const blocked = await json(await call("GET", "/applications", { token: t }));
  assert.deepEqual([blocked.status, blocked.body.error, blocked.body.needs], [403, "setup_required", ["password", "totp"]]);
  assert.equal((await call("GET", "/users", { token: t })).status, 403);
  assert.equal((await json(await call("GET", "/me", { token: t }))).body.scope, "setup");

  const weak = await json(await call("POST", "/me/password", { token: t, body: { current: created.body.temp_password, next: "court" } }));
  assert.deepEqual([weak.status, weak.body.reason], [400, "too_short"]);
  const changed = await json(await call("POST", "/me/password", { token: t, body: { current: created.body.temp_password, next: PW } }));
  assert.deepEqual([changed.status, changed.body.scope, changed.body.needs], [200, "setup", ["totp"]]);
  assert.equal((await call("GET", "/applications", { token: t })).status, 403, "le TOTP manque encore");

  const setup = await json(await call("POST", "/2fa/setup", { token: t }));
  assert.match(setup.body.uri, /^otpauth:\/\/totp\/Louage%20Express:bob\?secret=/);
  assert.equal((await json(await call("POST", "/2fa/confirm", { token: t, body: { code: "000000" } }))).body.error, "invalid_code");
  const ok = await json(await call("POST", "/2fa/confirm", { token: t, body: { code: code(setup.body.secret) } }));
  assert.deepEqual([ok.body.scope, ok.body.recovery_codes.length], ["full", 8]);
  assert.equal((await call("GET", "/applications", { token: t })).status, 200, "même jeton, désormais session complète");
  assert.equal((await json(await call("POST", "/2fa/setup", { token: t }))).status, 409, "TOTP déjà actif");
});

test("connexion : réponse unique en cas d'échec, journal nominatif, jamais un nom inconnu enregistré", async () => {
  const alice = await bootstrapOwner();
  clock += 30_000;
  const attempts = [
    { username: "alice", password: "mauvais mot de passe", code: code(alice.secret) },
    { username: "alice", password: PW, code: "000000" },
    { username: "alice", password: PW },
    { username: "personne", password: PW, code: "123456" },
    { username: "mot-de-passe-tape-dans-le-mauvais-champ", password: "x" },
  ];
  const results = [];
  for (const body of attempts) results.push(await json(await call("POST", "/login", { body })));
  assert.ok(results.every((r) => r.status === 401 && JSON.stringify(r.body) === '{"error":"invalid_credentials"}'));

  const { body } = await json(await call("GET", "/audit?limit=50", { token: await loginFull(alice) }));
  const failed = body.entries.filter((e) => e.action === "login_failed").map((e) => e.actor).sort();
  assert.deepEqual(failed, ["(inconnu)", "(inconnu)", "alice", "alice", "alice"]);
  assert.ok(!JSON.stringify(body.entries).includes("mot-de-passe-tape"), "un nom saisi qui n'est pas un compte n'est jamais enregistré");
  assert.ok(body.entries.some((e) => e.action === "login" && e.actor === "alice"));
});

test("blocage du compte après 5 échecs, déblocage par un propriétaire", async () => {
  const alice = await bootstrapOwner();
  const bob = await onboard(alice.token, "bob", "reviewer");
  for (let i = 0; i < 5; i++) await call("POST", "/login", { body: { username: "bob", password: "faux faux faux faux" } });
  clock += 30_000;
  assert.equal((await call("POST", "/login", { body: { username: "bob", password: PW, code: code(bob.secret) } })).status, 401, "bloqué même avec les bons identifiants");
  const listed = (await json(await call("GET", "/users", { token: alice.token }))).body.users;
  assert.equal(listed.find((u) => u.username === "bob").locked, true);
  assert.equal((await call("POST", `/users/${bob.id}/unlock`, { token: alice.token })).status, 200);
  clock += 30_000;
  assert.equal((await call("POST", "/login", { body: { username: "bob", password: PW, code: code(bob.secret) } })).status, 200);
  assert.equal((await call("POST", "/users/999/unlock", { token: alice.token })).status, 404);
});

test("rôles : un « reviewer » traite les dossiers mais ne gère ni comptes, ni journal, ni suppression ; chaque action porte son nom", async () => {
  const alice = await bootstrapOwner();
  const bob = await onboard(alice.token, "bob", "reviewer");
  db.prepare("INSERT INTO applications (ref, full_name, phone, cin, role, plate, governorate, station, route, consent_at) VALUES ('LX-ABCDEFGH','Test','98111222','01234567','driver','1 TUN 1','Gafsa','Gare','x',?)").run(new Date().toISOString());
  const t = await loginFull(bob);

  assert.equal((await call("GET", "/applications", { token: t })).status, 200);
  assert.equal((await call("GET", "/applications/LX-ABCDEFGH", { token: t })).status, 200);
  assert.equal((await call("PATCH", "/applications/LX-ABCDEFGH", { token: t, body: { status: "interview" } })).status, 200);
  assert.equal((await call("GET", "/network", { token: t })).status, 200);
  assert.equal((await call("GET", "/interviews", { token: t })).status, 200);
  for (const [method, url] of [["GET", "/users"], ["POST", "/users"], ["PATCH", "/users/1"], ["POST", "/users/1/reset-password"], ["POST", "/users/1/reset-2fa"], ["POST", "/users/1/unlock"], ["GET", "/audit"], ["GET", "/security"], ["DELETE", "/applications/LX-ABCDEFGH"]]) {
    const r = await json(await call(method, url, { token: t, body: method === "GET" || method === "DELETE" ? undefined : {} }));
    assert.deepEqual([r.status, r.body.error], [403, "forbidden_role"], `${method} ${url}`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM applications").get().n, 1, "le refus n'a rien supprimé");

  const entries = (await json(await call("GET", "/audit?limit=100", { token: await loginFull(alice) }))).body.entries;
  assert.ok(entries.some((e) => e.action === "application_update" && e.actor === "bob" && e.ref === "LX-ABCDEFGH"));
  assert.ok(entries.filter((e) => ["application_view", "application_update", "applications_list", "network_view", "interviews_list"].includes(e.action)).every((e) => e.actor === "bob" || e.actor === "alice"));

  assert.equal((await call("DELETE", "/applications/LX-ABCDEFGH", { token: await loginFull(alice) })).status, 200, "un propriétaire peut supprimer");
});

test("gestion des comptes : création, rôle, désactivation, réinitialisations, garde-fous", async () => {
  const alice = await bootstrapOwner();
  const bob = await onboard(alice.token, "bob", "reviewer");
  const bobToken = await loginFull(bob);

  const dup = await json(await call("POST", "/users", { token: alice.token, body: { username: "BOB", role: "reviewer" } }));
  assert.deepEqual([dup.status, dup.body.error], [409, "username_taken"]);
  assert.equal((await json(await call("POST", "/users", { token: alice.token, body: { username: "x" } }))).body.error, "invalid_username");
  assert.equal((await json(await call("POST", "/users", { token: alice.token, body: { username: "carol", role: "dieu" } }))).body.error, "invalid_role");

  assert.equal((await json(await call("PATCH", `/users/${alice.id}`, { token: alice.token, body: { role: "reviewer" } }))).status, 409, "dernier propriétaire");
  assert.equal((await json(await call("PATCH", `/users/${alice.id}`, { token: alice.token, body: { active: false } }))).body.error, "last_owner");
  assert.equal((await json(await call("PATCH", "/users/999", { token: alice.token, body: { active: false } }))).status, 404);
  assert.equal((await json(await call("PATCH", `/users/${bob.id}`, { token: alice.token, body: { active: "oui" } }))).status, 400);

  // Mot de passe oublié : ancienne session fermée, mot de passe provisoire, TOTP conservé.
  const reset = await json(await call("POST", `/users/${bob.id}/reset-password`, { token: alice.token }));
  assert.match(reset.body.temp_password, /^([a-z2-9]{4}-){3}[a-z2-9]{4}$/);
  assert.equal((await call("GET", "/me", { token: bobToken })).status, 401);
  clock += 30_000;
  const again = await json(await call("POST", "/login", { body: { username: "bob", password: reset.body.temp_password, code: code(bob.secret) } }));
  assert.deepEqual([again.body.scope, again.body.needs], ["setup", ["password"]]);

  // Téléphone perdu : le TOTP est effacé, un nouveau est exigé.
  assert.equal((await call("POST", `/users/${bob.id}/reset-2fa`, { token: alice.token })).status, 200);
  const view = (await json(await call("GET", "/users", { token: alice.token }))).body.users.find((u) => u.username === "bob");
  assert.deepEqual([view.totp_enabled, view.recovery_codes_left], [false, 0]);

  // Désactivation : plus de connexion.
  assert.equal((await json(await call("PATCH", `/users/${bob.id}`, { token: alice.token, body: { active: false } }))).body.user.active, false);
  const afterDisable = await call("POST", "/login", { body: { username: "bob", password: reset.body.temp_password } });
  assert.equal(afterDisable.status, 401);

  const entries = (await json(await call("GET", "/audit?limit=100", { token: alice.token }))).body.entries;
  for (const action of ["user_create", "user_reset_password", "user_reset_2fa", "user_update", "2fa_enabled", "password_change"]) assert.ok(entries.some((e) => e.action === action), action);
  assert.ok(entries.some((e) => e.action === "user_reset_2fa" && e.ref === "bob" && e.actor === "alice"));
  assert.ok(!JSON.stringify(entries).includes(PW) && !JSON.stringify(entries).includes(reset.body.temp_password), "aucun secret dans le journal");
});

test("la liste des comptes ne contient jamais de hash, de secret TOTP ni de code de secours", async () => {
  const alice = await bootstrapOwner();
  const { body } = await json(await call("GET", "/users", { token: alice.token }));
  const dump = JSON.stringify(body);
  assert.ok(!/hash|totp_secret|totp_pending|scrypt|enc1|raw1/.test(dump), dump);
  assert.ok(!dump.includes(alice.secret) && alice.recovery.every((c) => !dump.includes(c)));
  assert.deepEqual(Object.keys(body.users[0]).sort(), ["active", "created_at", "display_name", "id", "last_login_at", "locked", "must_change_password", "recovery_codes_left", "role", "totp_enabled", "username"]);
});

test("session : expire après 30 min d'inactivité, la déconnexion la ferme immédiatement", async () => {
  const alice = await bootstrapOwner();
  const t = await loginFull(alice);
  assert.equal((await call("GET", "/me", { token: t })).status, 200);
  clock += 31 * 60_000;
  assert.equal((await call("GET", "/me", { token: t })).status, 401);

  const t2 = await loginFull(alice);
  assert.equal((await call("POST", "/logout", { token: t2 })).status, 200);
  assert.equal((await call("GET", "/me", { token: t2 })).status, 401);
  assert.ok((await json(await call("GET", "/audit?limit=20", { token: await loginFull(alice) }))).body.entries.some((e) => e.action === "logout" && e.actor === "alice"));
});

test("changement de mot de passe : les autres sessions sont fermées, l'ancien mot de passe ne marche plus", async () => {
  const alice = await bootstrapOwner();
  const phone = await loginFull(alice);
  const laptop = await loginFull(alice);
  const NEW = "un autre mot de passe long";
  assert.equal((await call("POST", "/me/password", { token: laptop, body: { current: "faux", next: NEW } })).status, 400);
  assert.equal((await call("POST", "/me/password", { token: laptop, body: { current: PW, next: NEW } })).status, 200);
  assert.equal((await call("GET", "/me", { token: phone })).status, 401, "l'autre appareil est déconnecté");
  assert.equal((await call("GET", "/me", { token: laptop })).status, 200, "l'appareil courant reste connecté");
  clock += 30_000;
  assert.equal((await call("POST", "/login", { body: { username: "alice", password: PW, code: code(alice.secret) } })).status, 401);
  assert.equal((await call("POST", "/login", { body: { username: "alice", password: NEW, code: code(alice.secret) } })).status, 200);
});
