// Comptes d'administration nominatifs : mot de passe (scrypt), double authentification TOTP, codes de secours, sessions côté serveur.
//
// Principes :
//  - un compte par personne, deux rôles : « owner » (gère les comptes, journal, suppressions) et « reviewer » (traite les dossiers) ;
//  - une réponse unique « identifiants invalides » (mot de passe, code, compte inconnu, compte verrouillé ou désactivé) : on n'apprend rien sur les comptes ;
//  - blocage du compte après 5 échecs pendant 15 minutes ; un code TOTP ne sert qu'une fois ;
//  - première connexion (ou après réinitialisation) : session « setup » limitée au changement de mot de passe et à l'activation du TOTP ;
//  - sessions côté serveur (jeton aléatoire, seul son hash est stocké), expiration par inactivité et durée maximale.
import crypto from "node:crypto";
import { promisify } from "node:util";
import { encryptBuffer, decryptBuffer, keyId } from "./security.js";
import { base32Encode, generateSecret, verifyTotp, otpauthUri } from "./totp.js";

const scrypt = promisify(crypto.scrypt);
export const ROLES = ["owner", "reviewer"];
export const LIMITS = {
  maxFailures: 5,
  lockMs: 15 * 60_000,
  idleMs: 30 * 60_000,       // session inutilisée
  sessionMs: 8 * 3_600_000,  // durée maximale d'une session complète
  setupMs: 15 * 60_000,      // session limitée (première connexion)
  recoveryCodes: 8,
};
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // sans caractères ambigus (0/o, 1/l/i)
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const randomText = (n) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
const group = (text, size) => text.match(new RegExp(`.{1,${size}}`, "g")).join("-");

// ---------------------------------------------------------------- mots de passe
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt" || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(String(password), Buffer.from(salt, "base64"), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(actual, expected);
}

/** @returns {string|null} code du problème, ou null si le mot de passe convient. */
export function passwordProblem(password, username = "") {
  const pw = String(password ?? "");
  if (pw.length < 12) return "too_short";
  if (pw.length > 200) return "too_long";
  if (new Set(pw).size < 5) return "too_simple";
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return "contains_username";
  return null;
}

// ---------------------------------------------------------------- secrets TOTP scellés
/** « enc1:<empreinte de clé>:<base64> » (AES-256-GCM avec DATA_KEY) ; sans clé (développement) « raw1::<base64> ». */
function seal(buf, keys) {
  if (!keys.current) return `raw1::${buf.toString("base64")}`;
  return `enc1:${keyId(keys.current)}:${encryptBuffer(buf, keys.current).toString("base64")}`;
}
function open(text, keys) {
  const [scheme, id, body] = String(text).split(":");
  if (scheme === "raw1") return Buffer.from(body, "base64");
  if (scheme !== "enc1") throw new Error("secret 2FA illisible");
  const key = [keys.current, ...keys.previous].filter(Boolean).find((k) => keyId(k) === id);
  if (!key) throw new Error("secret 2FA illisible : clé manquante");
  return decryptBuffer(Buffer.from(body, "base64"), key);
}
const sealedWithCurrent = (text, keys) => (keys.current ? String(text).startsWith(`enc1:${keyId(keys.current)}:`) : String(text).startsWith("raw1:"));

// ---------------------------------------------------------------- service
/**
 * @param {object} o
 * @param {{current: Buffer|null, previous: Buffer[]}} o.keys  DATA_KEY courante et anciennes (lecture seule) : scellent les secrets TOTP
 */
export function createAdminAuth({ db, keys = { current: null, previous: [] }, now = Date.now }) {
  const iso = () => new Date(now()).toISOString();
  let dummyHash = null; // vérifié quand le compte n'existe pas, pour que le temps de réponse ne révèle rien
  const dummy = async () => (dummyHash ??= await hashPassword(crypto.randomBytes(16).toString("hex")));

  const publicUser = (u) => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role, active: Boolean(u.active), totp_enabled: Boolean(u.totp_enabled), must_change_password: Boolean(u.must_change_password), locked: u.locked_until > now(), last_login_at: u.last_login_at, created_at: u.created_at });
  const needs = (u) => [...(u.must_change_password ? ["password"] : []), ...(u.totp_enabled ? [] : ["totp"])];
  const byId = (id) => db.prepare("SELECT * FROM admin_users WHERE id = ?").get(id);
  const byName = (name) => db.prepare("SELECT * FROM admin_users WHERE username = ?").get(String(name ?? "").trim().toLowerCase());

  const hasUsers = () => db.prepare("SELECT COUNT(*) AS n FROM admin_users").get().n > 0;
  const activeOwners = () => db.prepare("SELECT COUNT(*) AS n FROM admin_users WHERE role = 'owner' AND active = 1").get().n;

  function newTempPassword() {
    return group(randomText(16), 4);
  }

  /** Crée un compte avec un mot de passe provisoire, à changer à la première connexion. */
  async function createUser({ username, displayName, role = "reviewer" }) {
    const name = String(username ?? "").trim().toLowerCase();
    if (!USERNAME.test(name)) return { error: "invalid_username" };
    if (!ROLES.includes(role)) return { error: "invalid_role" };
    const display = String(displayName ?? "").trim().slice(0, 80) || name;
    if (byName(name)) return { error: "username_taken" };
    const temp = newTempPassword();
    const info = db.prepare("INSERT INTO admin_users (username, display_name, role, password_hash, created_at) VALUES (?,?,?,?,?)").run(name, display, role, await hashPassword(temp), iso());
    return { user: publicUser(byId(Number(info.lastInsertRowid))), temp_password: temp };
  }

  const sessionRow = (hash) => db.prepare("SELECT * FROM admin_sessions WHERE token_hash = ?").get(hash);
  function startSession(user) {
    const token = crypto.randomBytes(32).toString("base64url");
    const t = now();
    const scope = needs(user).length ? "setup" : "full";
    const expires = t + (scope === "full" ? LIMITS.sessionMs : LIMITS.setupMs);
    db.prepare("INSERT INTO admin_sessions (token_hash, user_id, scope, created_at, last_seen, expires_at) VALUES (?,?,?,?,?,?)").run(sha(token), user.id, scope, t, t, expires);
    db.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").run(t); // ménage au passage
    return { token, scope, expires_at: expires, needs: needs(user) };
  }
  const revokeUser = (userId, exceptHash = null) => db.prepare("DELETE FROM admin_sessions WHERE user_id = ? AND token_hash IS NOT ?").run(userId, exceptHash);

  function recordFailure(user) {
    if (!user) return;
    const failures = user.failed_attempts + 1;
    const lock = failures >= LIMITS.maxFailures ? now() + LIMITS.lockMs : 0;
    db.prepare("UPDATE admin_users SET failed_attempts = ?, locked_until = ? WHERE id = ?").run(lock ? 0 : failures, lock, user.id);
  }

  /** Code de secours : « xxxxx-xxxxx », à usage unique. */
  function useRecoveryCode(user, code) {
    const hash = sha(String(code).trim().toLowerCase());
    const row = db.prepare("SELECT id FROM admin_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL").get(user.id, hash);
    if (!row) return false;
    return db.prepare("UPDATE admin_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL").run(iso(), row.id).changes === 1;
  }

  /**
   * @returns {Promise<{error: "invalid_credentials"} | {token, scope, expires_at, needs: string[], user}>}
   * `code` : code TOTP à 6 chiffres, ou code de secours ; facultatif tant que le TOTP n'est pas activé (première connexion).
   */
  async function login({ username, password, code }) {
    const user = byName(username);
    const passwordOk = await verifyPassword(String(password ?? ""), user?.password_hash ?? (await dummy()));
    const usable = Boolean(user) && user.active === 1 && user.locked_until <= now();
    if (!user || !passwordOk || !usable) {
      if (user && usable) recordFailure(user);
      return { error: "invalid_credentials", actor: user?.username ?? null };
    }
    if (user.totp_enabled) {
      const given = String(code ?? "").trim();
      let ok = false;
      if (/^[\d\s]{6,7}$/.test(given)) {
        const step = verifyTotp(open(user.totp_secret, keys), given, now(), { lastStep: user.totp_last_step });
        if (step !== null) ok = db.prepare("UPDATE admin_users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?").run(step, user.id, step).changes === 1;
      } else if (given) {
        ok = useRecoveryCode(user, given);
      }
      if (!ok) {
        recordFailure(user);
        return { error: "invalid_credentials", actor: user.username };
      }
    }
    db.prepare("UPDATE admin_users SET failed_attempts = 0, locked_until = 0, last_login_at = ? WHERE id = ?").run(iso(), user.id);
    return { ...startSession(byId(user.id)), user: publicUser(byId(user.id)) };
  }

  /** @returns {{user, scope, hash} | null} la session valide correspondant au jeton (et la prolonge d'un cran d'inactivité). */
  function authenticate(token) {
    if (!token) return null;
    const hash = sha(token);
    const s = sessionRow(hash);
    const t = now();
    if (!s) return null;
    const user = byId(s.user_id);
    const idle = s.scope === "full" ? LIMITS.idleMs : LIMITS.setupMs;
    if (!user || !user.active || s.expires_at <= t || t - s.last_seen > idle) {
      db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(hash);
      return null;
    }
    db.prepare("UPDATE admin_sessions SET last_seen = ? WHERE token_hash = ?").run(t, hash);
    return { user, scope: s.scope, hash };
  }

  const logout = (token) => db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(sha(token)).changes > 0;

  /** Passe une session « setup » en session complète dès que plus rien n'est à faire. */
  function upgradeIfDone(hash) {
    const s = sessionRow(hash);
    const user = s && byId(s.user_id);
    if (!user || needs(user).length || s.scope === "full") return false;
    const t = now();
    db.prepare("UPDATE admin_sessions SET scope = 'full', expires_at = ?, last_seen = ? WHERE token_hash = ?").run(t + LIMITS.sessionMs, t, hash);
    return true;
  }

  async function changePassword(userId, current, next, keepHash) {
    const user = byId(userId);
    if (!user || !(await verifyPassword(String(current ?? ""), user.password_hash))) return { error: "invalid_credentials" };
    const problem = passwordProblem(next, user.username);
    if (problem) return { error: "weak_password", reason: problem };
    if (String(next) === String(current)) return { error: "same_password" };
    db.prepare("UPDATE admin_users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(await hashPassword(String(next)), userId);
    revokeUser(userId, keepHash); // les autres appareils doivent se reconnecter
    return { ok: true };
  }

  /** Démarre l'activation du TOTP : renvoie le secret à saisir dans l'application d'authentification. Rien n'est actif tant que le code n'est pas confirmé. */
  function totpSetup(userId) {
    const user = byId(userId);
    if (!user || user.totp_enabled) return { error: "already_enabled" };
    const secret = generateSecret();
    db.prepare("UPDATE admin_users SET totp_pending = ? WHERE id = ?").run(seal(secret, keys), userId);
    return { secret: base32Encode(secret), uri: otpauthUri({ secret, account: user.username }) };
  }

  function totpConfirm(userId, code) {
    const user = byId(userId);
    if (!user || user.totp_enabled || !user.totp_pending) return { error: "no_setup" };
    const secret = open(user.totp_pending, keys);
    const step = verifyTotp(secret, code, now());
    if (step === null) return { error: "invalid_code" };
    const codes = Array.from({ length: LIMITS.recoveryCodes }, () => group(randomText(10), 5));
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE admin_users SET totp_secret = ?, totp_pending = NULL, totp_enabled = 1, totp_last_step = ? WHERE id = ?").run(seal(secret, keys), step, userId);
      db.prepare("DELETE FROM admin_recovery_codes WHERE user_id = ?").run(userId);
      const ins = db.prepare("INSERT INTO admin_recovery_codes (user_id, code_hash) VALUES (?, ?)");
      for (const c of codes) ins.run(userId, sha(c));
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return { recovery_codes: codes };
  }

  const recoveryLeft = (userId) => db.prepare("SELECT COUNT(*) AS n FROM admin_recovery_codes WHERE user_id = ? AND used_at IS NULL").get(userId).n;

  const listUsers = () => db.prepare("SELECT * FROM admin_users ORDER BY username").all().map((u) => ({ ...publicUser(u), recovery_codes_left: recoveryLeft(u.id) }));

  /** Changement de rôle ou activation. Refuse de retirer le dernier propriétaire actif (plus personne ne pourrait gérer les comptes). */
  function updateUser(id, { role, active }, actorId) {
    const user = byId(id);
    if (!user) return { error: "not_found" };
    if (role !== undefined && !ROLES.includes(role)) return { error: "invalid_role" };
    if (active !== undefined && typeof active !== "boolean") return { error: "invalid_active" };
    const nextRole = role ?? user.role;
    const nextActive = active ?? Boolean(user.active);
    const losesOwner = user.role === "owner" && user.active && (nextRole !== "owner" || !nextActive);
    if (losesOwner && activeOwners() <= 1) return { error: "last_owner" };
    if (id === actorId && !nextActive) return { error: "cannot_disable_self" };
    db.prepare("UPDATE admin_users SET role = ?, active = ? WHERE id = ?").run(nextRole, nextActive ? 1 : 0, id);
    if (!nextActive || nextRole !== user.role) revokeUser(id); // droits modifiés : reconnexion exigée
    return { user: publicUser(byId(id)) };
  }

  /** Mot de passe oublié : nouveau mot de passe provisoire ; toutes les sessions sont fermées. Le TOTP reste actif. */
  async function resetPassword(id) {
    const user = byId(id);
    if (!user) return { error: "not_found" };
    const temp = newTempPassword();
    db.prepare("UPDATE admin_users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = 0 WHERE id = ?").run(await hashPassword(temp), id);
    revokeUser(id);
    return { temp_password: temp };
  }

  /** Téléphone perdu : désactive le TOTP et les codes de secours ; la personne devra en activer un nouveau à sa prochaine connexion. */
  function resetTotp(id) {
    const user = byId(id);
    if (!user) return { error: "not_found" };
    db.prepare("UPDATE admin_users SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, totp_last_step = -1, failed_attempts = 0, locked_until = 0 WHERE id = ?").run(id);
    db.prepare("DELETE FROM admin_recovery_codes WHERE user_id = ?").run(id);
    revokeUser(id);
    return { ok: true };
  }

  const unlock = (id) => db.prepare("UPDATE admin_users SET failed_attempts = 0, locked_until = 0 WHERE id = ?").run(id).changes === 1;

  /** Rotation de DATA_KEY : rechiffre les secrets TOTP restés sur une ancienne clé. @returns {number} secrets rechiffrés */
  function reseal() {
    let n = 0;
    for (const u of db.prepare("SELECT id, totp_secret, totp_pending FROM admin_users").all()) {
      const next = {};
      for (const col of ["totp_secret", "totp_pending"]) {
        if (u[col] && !sealedWithCurrent(u[col], keys)) next[col] = seal(open(u[col], keys), keys);
      }
      if (Object.keys(next).length) {
        db.prepare("UPDATE admin_users SET totp_secret = COALESCE(?, totp_secret), totp_pending = COALESCE(?, totp_pending) WHERE id = ?").run(next.totp_secret ?? null, next.totp_pending ?? null, u.id);
        n += Object.keys(next).length;
      }
    }
    return n;
  }
  const unsealedCount = () => db.prepare("SELECT totp_secret, totp_pending FROM admin_users").all().flatMap((u) => [u.totp_secret, u.totp_pending]).filter((v) => v && !sealedWithCurrent(v, keys)).length;

  return {
    hasUsers, activeOwners, createUser, login, authenticate, logout, upgradeIfDone, changePassword, totpSetup, totpConfirm,
    listUsers, updateUser, resetPassword, resetTotp, unlock, reseal, unsealedCount, recoveryLeft, publicUser, needs, byName,
  };
}
