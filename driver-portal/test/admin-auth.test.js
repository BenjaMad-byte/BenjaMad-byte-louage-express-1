import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { base32Decode, hotp, stepOf } from "../totp.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-adminauth-"));
process.env.DATA_DIR = dataDir;
let db, mod;
before(async () => {
  ({ db } = await import("../db.js"));
  mod = await import("../admin-auth.js");
});
after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const t of ["admin_sessions", "admin_recovery_codes", "admin_users"]) db.exec(`DELETE FROM ${t}`);
});

let clock = Date.parse("2026-10-07T10:00:00Z");
const KEY_A = crypto.randomBytes(32);
const KEY_B = crypto.randomBytes(32);
const make = (keys = { current: null, previous: [] }) => mod.createAdminAuth({ db, keys, now: () => clock });
const code = (secretB32, offset = 0) => hotp(base32Decode(secretB32), stepOf(clock) + offset);
const NEW_PW = "correct horse battery";

/** Compte prêt à l'emploi : mot de passe changé et TOTP activé. */
async function readyUser(auth, username = "alice", role = "owner") {
  const { temp_password } = await auth.createUser({ username, displayName: "Alice A.", role });
  const first = await auth.login({ username, password: temp_password });
  const user = auth.authenticate(first.token).user;
  assert.deepEqual((await auth.changePassword(user.id, temp_password, NEW_PW, first.token ? auth.authenticate(first.token).hash : null)).ok, true);
  const { secret } = auth.totpSetup(user.id);
  const confirmed = auth.totpConfirm(user.id, code(secret));
  return { id: user.id, secret, recovery: confirmed.recovery_codes, username };
}

test("mots de passe : scrypt salé, vérification, politique (longueur, variété, pas le nom du compte)", async () => {
  const h1 = await mod.hashPassword("un mot de passe solide");
  const h2 = await mod.hashPassword("un mot de passe solide");
  assert.notEqual(h1, h2, "sel différent à chaque fois");
  assert.match(h1, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await mod.verifyPassword("un mot de passe solide", h1), true);
  assert.equal(await mod.verifyPassword("un mot de passe solidE", h1), false);
  assert.equal(await mod.verifyPassword("x", "n'importe quoi"), false);
  assert.equal(mod.passwordProblem("court"), "too_short");
  assert.equal(mod.passwordProblem("aaaaaaaaaaaaaaaa"), "too_simple");
  assert.equal(mod.passwordProblem("alice-et-son-mot-de-passe", "alice"), "contains_username");
  assert.equal(mod.passwordProblem("x".repeat(201) + "abcde"), "too_long");
  assert.equal(mod.passwordProblem(NEW_PW, "alice"), null);
});

test("création de compte : nom valide et unique, rôle valide, mot de passe provisoire affiché une fois et jamais stocké", async () => {
  const auth = make();
  assert.equal(auth.hasUsers(), false);
  const r = await auth.createUser({ username: "  Alice.B ", displayName: "Alice B.", role: "owner" });
  assert.equal(r.user.username, "alice.b");
  assert.match(r.temp_password, /^([a-z2-9]{4}-){3}[a-z2-9]{4}$/);
  assert.equal(r.user.must_change_password, true);
  assert.equal(r.user.totp_enabled, false);
  assert.ok(!JSON.stringify(r.user).includes("hash"), "jamais de hash dans la vue publique");
  assert.ok(!db.prepare("SELECT * FROM admin_users").all().some((u) => JSON.stringify(u).includes(r.temp_password)));
  for (const [input, error] of [[{ username: "alice.b" }, "username_taken"], [{ username: "ab" }, "invalid_username"], [{ username: "Alice B" }, "invalid_username"], [{ username: "../etc" }, "invalid_username"], [{ username: "bob", role: "root" }, "invalid_role"]]) {
    assert.equal((await auth.createUser(input)).error, error, JSON.stringify(input));
  }
  assert.equal(auth.hasUsers(), true);
});

test("première connexion : session limitée « setup » ; mot de passe changé + TOTP confirmé → session complète", async () => {
  const auth = make();
  const { temp_password } = await auth.createUser({ username: "alice", role: "owner" });
  const login = await auth.login({ username: "ALICE", password: temp_password });
  assert.deepEqual([login.scope, login.needs], ["setup", ["password", "totp"]]);
  const s = auth.authenticate(login.token);
  assert.equal(s.scope, "setup");
  assert.equal(auth.upgradeIfDone(s.hash), false, "rien n'est fait : pas de passage en session complète");

  assert.deepEqual(await auth.changePassword(s.user.id, "mauvais", NEW_PW, s.hash), { error: "invalid_credentials" });
  assert.equal((await auth.changePassword(s.user.id, temp_password, "court", s.hash)).reason, "too_short");
  assert.equal((await auth.changePassword(s.user.id, temp_password, temp_password, s.hash)).error, "same_password");
  assert.equal((await auth.changePassword(s.user.id, temp_password, NEW_PW, s.hash)).ok, true);
  assert.equal(auth.upgradeIfDone(s.hash), false, "le TOTP manque encore");

  const { secret, uri } = auth.totpSetup(s.user.id);
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.ok(uri.startsWith("otpauth://totp/Louage%20Express:alice?secret="));
  assert.equal(auth.totpConfirm(s.user.id, "000000").error, "invalid_code");
  const confirmed = auth.totpConfirm(s.user.id, code(secret));
  assert.equal(confirmed.recovery_codes.length, 8);
  assert.ok(confirmed.recovery_codes.every((c) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)));
  assert.equal(auth.upgradeIfDone(s.hash), true);
  assert.equal(auth.authenticate(login.token).scope, "full");
  assert.equal(auth.totpSetup(s.user.id).error, "already_enabled");
});

test("connexion normale : mot de passe + code ; un code ne sert qu'une fois ; tout échec donne la même réponse", async () => {
  const auth = make();
  const u = await readyUser(auth);
  const bad = { error: "invalid_credentials", actor: "alice" };
  assert.deepEqual(await auth.login({ username: "alice", password: NEW_PW }), bad, "sans code");
  assert.deepEqual(await auth.login({ username: "alice", password: NEW_PW, code: "123456" }), bad, "mauvais code");
  assert.deepEqual(await auth.login({ username: "alice", password: "mauvais mot de passe", code: code(u.secret) }), bad, "mauvais mot de passe");
  assert.deepEqual(await auth.login({ username: "inconnu", password: NEW_PW, code: code(u.secret) }), { error: "invalid_credentials", actor: null }, "compte inconnu : même réponse");

  clock += 30_000; // le code utilisé à la confirmation (pas courant) ne doit pas resservir
  const ok = await auth.login({ username: "alice", password: NEW_PW, code: code(u.secret) });
  assert.deepEqual([ok.scope, ok.needs], ["full", []]);
  assert.equal(ok.user.role, "owner");
  assert.equal((await auth.login({ username: "alice", password: NEW_PW, code: code(u.secret) })).error, "invalid_credentials", "même code rejoué");
  clock += 30_000;
  assert.equal((await auth.login({ username: "alice", password: NEW_PW, code: code(u.secret) })).scope, "full", "le code suivant fonctionne");
});

test("blocage : 5 échecs verrouillent le compte 15 minutes (même avec les bons identifiants), le déblocage rétablit", async () => {
  const auth = make();
  const u = await readyUser(auth);
  clock += 30_000;
  for (let i = 0; i < 5; i++) assert.equal((await auth.login({ username: "alice", password: "faux faux faux faux" })).error, "invalid_credentials");
  const locked = await auth.login({ username: "alice", password: NEW_PW, code: code(u.secret) });
  assert.equal(locked.error, "invalid_credentials", "bons identifiants refusés pendant le blocage, sans l'indiquer");
  assert.equal(auth.listUsers()[0].locked, true);
  clock += 16 * 60_000;
  assert.equal((await auth.login({ username: "alice", password: NEW_PW, code: code(u.secret) })).scope, "full", "blocage expiré");

  for (let i = 0; i < 5; i++) await auth.login({ username: "alice", password: "faux faux faux faux" });
  assert.equal(auth.unlock(u.id), true);
  clock += 30_000;
  assert.equal((await auth.login({ username: "alice", password: NEW_PW, code: code(u.secret) })).scope, "full");
});

test("codes de secours : à usage unique, remplacent le TOTP, un mauvais code compte comme un échec", async () => {
  const auth = make();
  const u = await readyUser(auth);
  const [first, second] = u.recovery;
  const ok = await auth.login({ username: "alice", password: NEW_PW, code: first.toUpperCase() });
  assert.equal(ok.scope, "full", "casse tolérée");
  assert.equal((await auth.login({ username: "alice", password: NEW_PW, code: first })).error, "invalid_credentials", "déjà utilisé");
  assert.equal((await auth.login({ username: "alice", password: NEW_PW, code: second })).scope, "full");
  assert.equal(auth.recoveryLeft(u.id), 6);
  assert.ok(!db.prepare("SELECT code_hash FROM admin_recovery_codes").all().some((r) => u.recovery.includes(r.code_hash)), "stockés hachés");
});

test("sessions : expiration par inactivité et par durée maximale, déconnexion, compte désactivé", async () => {
  const auth = make();
  const u = await readyUser(auth);
  clock += 30_000;
  const login = await auth.login({ username: "alice", password: NEW_PW, code: code(u.secret) });
  assert.ok(auth.authenticate(login.token));
  clock += 20 * 60_000;
  assert.ok(auth.authenticate(login.token), "20 min d'inactivité : encore valide, et prolongée");
  clock += 20 * 60_000;
  assert.ok(auth.authenticate(login.token), "chaque requête repousse l'inactivité");
  clock += 31 * 60_000;
  assert.equal(auth.authenticate(login.token), null, "plus de 30 min d'inactivité");
  assert.equal(auth.authenticate(login.token), null, "et la session est supprimée");

  clock += 30_000;
  const second = await auth.login({ username: "alice", password: NEW_PW, code: code(u.secret) });
  for (let i = 0; i < 20; i++) { clock += 25 * 60_000; if (!auth.authenticate(second.token)) break; }
  assert.equal(auth.authenticate(second.token), null, "durée maximale de 8 h, même en restant actif");

  clock += 30_000;
  const third = await auth.login({ username: "alice", password: NEW_PW, code: code(u.secret) });
  assert.equal(auth.logout(third.token), true);
  assert.equal(auth.authenticate(third.token), null);
  assert.equal(auth.authenticate("n'importe quoi"), null);
  assert.equal(auth.authenticate(""), null);
  assert.ok(!db.prepare("SELECT token_hash FROM admin_sessions").all().some((s) => s.token_hash === third.token), "seul le hash du jeton est stocké");
});

test("rôles et comptes : dernier propriétaire protégé, désactivation et changement de rôle ferment les sessions", async () => {
  const auth = make();
  const a = await readyUser(auth, "alice", "owner");
  const b = await readyUser(auth, "bob", "reviewer");
  clock += 30_000;
  const bobLogin = await auth.login({ username: "bob", password: NEW_PW, code: code(b.secret) });
  assert.ok(auth.authenticate(bobLogin.token));

  assert.equal(auth.updateUser(a.id, { role: "reviewer" }, b.id).error, "last_owner");
  assert.equal(auth.updateUser(a.id, { active: false }, a.id).error, "last_owner");
  assert.equal(auth.updateUser(b.id, { role: "owner" }, a.id).user.role, "owner");
  assert.equal(auth.authenticate(bobLogin.token), null, "rôle modifié : reconnexion exigée");
  assert.equal(auth.updateUser(a.id, { active: false }, a.id).error, "cannot_disable_self");
  assert.equal(auth.updateUser(a.id, { role: "reviewer" }, b.id).user.role, "reviewer", "deux propriétaires : on peut en rétrograder un");
  assert.equal(auth.updateUser(999, { active: false }, a.id).error, "not_found");
  assert.equal(auth.updateUser(a.id, { role: "root" }, b.id).error, "invalid_role");
  assert.equal(auth.updateUser(a.id, { active: "non" }, b.id).error, "invalid_active");

  clock += 30_000;
  assert.equal(auth.updateUser(a.id, { active: false }, b.id).user.active, false);
  assert.equal((await auth.login({ username: "alice", password: NEW_PW, code: code(a.secret) })).error, "invalid_credentials", "compte désactivé");
});

test("réinitialisations : mot de passe (TOTP conservé) et double authentification (nouveau TOTP exigé) ; sessions fermées", async () => {
  const auth = make();
  const u = await readyUser(auth);
  clock += 30_000;
  const login = await auth.login({ username: "alice", password: NEW_PW, code: code(u.secret) });

  const { temp_password } = await auth.resetPassword(u.id);
  assert.equal(auth.authenticate(login.token), null);
  clock += 30_000;
  assert.equal((await auth.login({ username: "alice", password: NEW_PW, code: code(u.secret) })).error, "invalid_credentials", "ancien mot de passe refusé");
  const afterReset = await auth.login({ username: "alice", password: temp_password, code: code(u.secret) });
  assert.deepEqual([afterReset.scope, afterReset.needs], ["setup", ["password"]], "TOTP conservé, mot de passe à changer");

  auth.resetTotp(u.id);
  assert.equal(auth.authenticate(afterReset.token), null);
  assert.equal(auth.recoveryLeft(u.id), 0, "codes de secours supprimés");
  const noTotp = await auth.login({ username: "alice", password: temp_password });
  assert.deepEqual(noTotp.needs, ["password", "totp"]);
  assert.equal((await auth.resetPassword(999)).error, "not_found");
  assert.equal(auth.resetTotp(999).error, "not_found");
});

test("secrets TOTP : jamais en clair avec une clé ; rotation de DATA_KEY (rechiffrement), clé manquante signalée", async () => {
  const withKey = make({ current: KEY_A, previous: [] });
  const u = await readyUser(withKey);
  const stored = db.prepare("SELECT totp_secret FROM admin_users").get().totp_secret;
  assert.match(stored, /^enc1:[0-9a-f]{16}:/);
  assert.ok(!stored.includes(u.secret) && !Buffer.from(stored.split(":")[2], "base64").includes(Buffer.from(base32Decode(u.secret))));
  clock += 30_000;
  assert.equal((await withKey.login({ username: "alice", password: NEW_PW, code: code(u.secret) })).scope, "full");

  // Nouvelle clé : l'ancienne reste lisible le temps de la rotation.
  const rotating = make({ current: KEY_B, previous: [KEY_A] });
  assert.equal(rotating.unsealedCount(), 1);
  clock += 30_000;
  assert.equal((await rotating.login({ username: "alice", password: NEW_PW, code: code(u.secret) })).scope, "full");
  assert.equal(rotating.reseal(), 1);
  assert.equal(rotating.unsealedCount(), 0);
  assert.equal(rotating.reseal(), 0, "idempotent");

  // Après retrait de l'ancienne clé, tout fonctionne encore.
  const rotated = make({ current: KEY_B, previous: [] });
  clock += 30_000;
  assert.equal((await rotated.login({ username: "alice", password: NEW_PW, code: code(u.secret) })).scope, "full");
  // Une mauvaise clé ne déchiffre pas : la connexion échoue franchement plutôt que d'accepter n'importe quoi.
  const wrong = make({ current: crypto.randomBytes(32), previous: [] });
  clock += 30_000;
  await assert.rejects(wrong.login({ username: "alice", password: NEW_PW, code: code(u.secret) }), /illisible/);
});

test("sans clé (développement) : secret scellé « raw1 » mais fonctionnel", async () => {
  const auth = make();
  const u = await readyUser(auth);
  assert.match(db.prepare("SELECT totp_secret FROM admin_users").get().totp_secret, /^raw1::/);
  clock += 30_000;
  assert.equal((await auth.login({ username: "alice", password: NEW_PW, code: code(u.secret) })).scope, "full");
});
