// Comptes chauffeurs : matricule + mot de passe au quotidien. Le matricule n'est PAS secret (peint sur la voiture) : c'est un
// identifiant, comme un nom d'utilisateur ; le mot de passe est le seul secret. Le téléphone ne sert qu'à deux moments :
//   - ACTIVATION : à l'acceptation du dossier, un lien personnel à usage unique est envoyé par SMS (voir sendActivationSms) ;
//     le chauffeur l'ouvre, choisit son mot de passe, et est connecté tout de suite.
//   - RÉCUPÉRATION : mot de passe oublié → code SMS → nouveau mot de passe (même service OTP que le site d'inscription).
// Un appareil = une session de 30 jours glissants (l'application doit rester utilisable plusieurs jours hors ligne), révocable à tout moment.
import crypto from "node:crypto";
import { hashPassword, verifyPassword } from "../driver-portal/admin-auth.js";

const SESSION_MS = 30 * 24 * 3_600_000;
const TOUCH_EVERY_MS = 5 * 60_000; // la date de dernière utilisation n'est réécrite que toutes les 5 minutes
const ACTIVATION_MS = 7 * 24 * 3_600_000; // durée de vie du lien envoyé par SMS
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/** Un matricule peint sur une voiture, pas une donnée secrète : juste normalisé (majuscules, espaces simples), jamais validé pour un format précis. */
export function normalizePlate(raw) {
  const s = String(raw ?? "").toUpperCase().replace(/\s+/g, " ").trim();
  return s.length >= 3 ? s : null;
}

/** Mot de passe d'un chauffeur : barre plus basse qu'un compte d'équipe (clavier de téléphone, pas de données d'équipe à protéger), mais réelle. */
export function passwordProblem(password, plate = "") {
  const pw = String(password ?? "");
  if (pw.length < 6) return "too_short";
  if (pw.length > 200) return "too_long";
  if (new Set(pw).size < 3) return "too_simple";
  const flat = (s) => String(s).toUpperCase().replace(/\s+/g, "");
  if (plate && flat(pw) === flat(plate)) return "is_plate";
  return null;
}

export function createDriverAuth({ db, portal, otp, sms, appUrl = null, now = Date.now }) {
  const iso = () => new Date(now()).toISOString();
  const byId = (id) => db.prepare("SELECT * FROM drivers WHERE id = ?").get(id);
  const byPlate = (plate) => {
    const p = normalizePlate(plate);
    return p ? db.prepare("SELECT * FROM drivers WHERE plate_normalized = ? AND active = 1").get(p) : null;
  };
  let dummyHash = null; // vérifié quand le matricule n'existe pas, pour que le temps de réponse ne révèle rien
  const dummy = async () => (dummyHash ??= await hashPassword(crypto.randomBytes(16).toString("hex")));

  /** Lien d'activation à usage unique. Un seul lien actif à la fois : en recréer un invalide l'ancien. */
  function createActivation(driverId) {
    db.prepare("DELETE FROM activations WHERE driver_id = ? AND used_at IS NULL").run(driverId);
    const token = crypto.randomBytes(24).toString("base64url");
    const t = now();
    db.prepare("INSERT INTO activations (token_hash, driver_id, created_at, expires_at) VALUES (?,?,?,?)").run(sha(token), driverId, t, t + ACTIVATION_MS);
    return { token, expiresAt: t + ACTIVATION_MS };
  }

  /** Message bilingue (le chauffeur n'a pas encore de session, donc pas de langue d'affichage connue à cet instant). */
  function activationMessage(link) {
    return `Louage Express: تم قبولك! حمّل التطبيق وفعّل حسابك بكلمة سر: ${link}\nLouage Express : vous êtes accepté ! Installez l'application et choisissez votre mot de passe : ${link}`;
  }

  async function sendActivationSms(driver) {
    const { token } = createActivation(driver.id);
    const base = String(appUrl ?? "").replace(/\/+$/, "");
    const link = `${base}/activer?jeton=${token}`;
    await sms.send(driver.phone, activationMessage(link));
  }

  /** Crée ou met à jour la copie locale d'un chauffeur accepté. Mot de passe, échecs et verrouillage ne sont jamais touchés ici. */
  function upsertDriver(p) {
    const via = JSON.stringify(Array.isArray(p.line_via) ? p.line_via.slice(0, 10) : []);
    const plateNorm = normalizePlate(p.plate) ?? String(p.plate ?? "").toUpperCase();
    const lang = p.lang === "fr" ? "fr" : "ar";
    const found = db.prepare("SELECT id FROM drivers WHERE portal_ref = ?").get(p.ref);
    if (found) {
      db.prepare(
        `UPDATE drivers SET phone = ?, full_name = ?, plate = ?, plate_normalized = ?, lang = ?, governorate = ?, station = ?, line_type = ?, line_from = ?, line_to_gov = ?, line_via = ?,
         pickup_en_route = ?, leaves_partial = ?, approved_at = ?, active = 1, synced_at = ? WHERE id = ?`
      ).run(p.phone, p.full_name, p.plate, plateNorm, lang, p.governorate, p.station, p.line_type ?? null, p.line_from ?? null, p.line_to_gov ?? null, via, p.pickup_en_route ? 1 : 0, p.leaves_partial ? 1 : 0, p.approved_at ?? null, iso(), found.id);
      return byId(found.id);
    }
    const info = db.prepare(
      `INSERT INTO drivers (portal_ref, phone, full_name, plate, plate_normalized, lang, governorate, station, line_type, line_from, line_to_gov, line_via, pickup_en_route, leaves_partial, approved_at, synced_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(p.ref, p.phone, p.full_name, p.plate, plateNorm, lang, p.governorate, p.station, p.line_type ?? null, p.line_from ?? null, p.line_to_gov ?? null, via, p.pickup_en_route ? 1 : 0, p.leaves_partial ? 1 : 0, p.approved_at ?? null, iso(), iso());
    return byId(Number(info.lastInsertRowid));
  }

  const revokeAll = (driverId) => db.prepare("DELETE FROM sessions WHERE driver_id = ?").run(driverId);

  function createSession(driverId, device) {
    const token = crypto.randomBytes(32).toString("base64url");
    const t = now();
    db.prepare("INSERT INTO sessions (token_hash, driver_id, device, created_at, last_seen, expires_at) VALUES (?,?,?,?,?,?)").run(sha(token), driverId, String(device ?? "").slice(0, 80) || null, t, t, t + SESSION_MS);
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(t);
    return { token, expires_at: t + SESSION_MS };
  }

  function recordFailure(driver) {
    const failures = driver.failed_attempts + 1;
    const lock = failures >= MAX_FAILURES ? now() + LOCK_MS : 0;
    db.prepare("UPDATE drivers SET failed_attempts = ?, locked_until = ? WHERE id = ?").run(lock ? 0 : failures, lock, driver.id);
  }

  /**
   * Connexion de tous les jours : matricule + mot de passe. Réponse unique « invalid_credentials » pour un mauvais mot de passe,
   * un matricule inconnu ou un compte verrouillé (on ne confirme ni n'infirme rien). « not_activated » est une exception volontaire :
   * le matricule n'étant pas secret, dire qu'il attend son activation n'aide pas à deviner un mot de passe.
   */
  async function login({ plate, password, device }) {
    const driver = byPlate(plate);
    if (driver && !driver.password_hash) return { error: "not_activated" };
    const locked = Boolean(driver) && driver.locked_until > now();
    const passwordOk = await verifyPassword(String(password ?? ""), driver?.password_hash ?? (await dummy()));
    if (!driver || locked || !passwordOk) {
      if (driver && !locked) recordFailure(driver);
      return { error: "invalid_credentials" };
    }
    db.prepare("UPDATE drivers SET failed_attempts = 0, locked_until = 0 WHERE id = ?").run(driver.id);
    return { ...createSession(driver.id, device), driver };
  }

  /** @returns {{driver: object} | {error: string}} les infos à afficher sur l'écran d'activation (jamais avant d'avoir un jeton valable). */
  function activationInfo(token) {
    const row = token ? db.prepare("SELECT * FROM activations WHERE token_hash = ?").get(sha(token)) : null;
    if (!row || row.used_at || row.expires_at <= now()) return { error: "token_invalid" };
    const driver = byId(row.driver_id);
    if (!driver || !driver.active) return { error: "token_invalid" };
    return { driver };
  }

  /** Premier mot de passe choisi par le chauffeur : consomme le lien, active le compte, connecte tout de suite. */
  async function finishActivation({ token, password, device }) {
    const info = activationInfo(token);
    if (info.error) return info;
    const problem = passwordProblem(password, info.driver.plate_normalized);
    if (problem) return { error: "weak_password", reason: problem };
    db.prepare("UPDATE activations SET used_at = ? WHERE token_hash = ?").run(now(), sha(token));
    db.prepare("UPDATE drivers SET password_hash = ?, failed_attempts = 0, locked_until = 0 WHERE id = ?").run(await hashPassword(password), info.driver.id);
    return { ...createSession(info.driver.id, device), driver: byId(info.driver.id) };
  }

  /**
   * Mot de passe oublié : code reçu par téléphone puis nouveau mot de passe. Le code est consommé qu'il réussisse ou non
   * (mot de passe trop faible compris) : il ne doit jamais resservir à plusieurs essais.
   */
  async function recoverReset({ phone, code, password, device }) {
    const v = otp.verify(phone, code);
    if (v.error) return { error: v.error, ...(v.attempts_left !== undefined ? { attempts_left: v.attempts_left } : {}) };
    const driver = db.prepare("SELECT * FROM drivers WHERE phone = ? AND active = 1").get(phone);
    if (!driver) {
      otp.consume(v.token, phone);
      return { error: "not_found" };
    }
    const problem = passwordProblem(password, driver.plate_normalized);
    if (problem) {
      otp.consume(v.token, phone);
      return { error: "weak_password", reason: problem };
    }
    if (!otp.consume(v.token, phone)) return { error: "otp_required" };
    db.prepare("UPDATE drivers SET password_hash = ?, failed_attempts = 0, locked_until = 0 WHERE id = ?").run(await hashPassword(password), driver.id);
    revokeAll(driver.id); // les autres appareils doivent se reconnecter avec le nouveau mot de passe
    return { ...createSession(driver.id, device), driver: byId(driver.id) };
  }

  /** @returns {object|null} le chauffeur actif correspondant au jeton ; prolonge la session de 30 jours. */
  function authenticate(token) {
    if (!token) return null;
    const hash = sha(token);
    const s = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hash);
    const t = now();
    if (!s) return null;
    const driver = byId(s.driver_id);
    if (!driver || !driver.active || s.expires_at <= t) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
      return null;
    }
    if (t - s.last_seen > TOUCH_EVERY_MS) {
      db.prepare("UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?").run(t, t + SESSION_MS, hash);
      db.prepare("UPDATE drivers SET last_seen_at = ? WHERE id = ?").run(iso(), driver.id);
    }
    return driver;
  }

  const logout = (token) => db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token)).changes > 0;

  /**
   * Synchronisation périodique avec le site d'inscription : met à jour les chauffeurs acceptés, envoie le lien d'activation
   * à chaque NOUVEAU chauffeur (jamais à un chauffeur déjà connu), et DÉSACTIVE ceux qui ne le sont plus (refusés après coup,
   * fin de collaboration, demande supprimée). Une erreur sur un chauffeur (matricule en double, SMS en échec) n'interrompt pas les autres.
   * @returns {{ updated: number, activationsSent: number, deactivated: number }}
   */
  async function syncApproved() {
    const list = await portal.approved();
    const refs = new Set(list.map((d) => d.ref));
    let activationsSent = 0;
    for (const p of list) {
      const existedBefore = Boolean(db.prepare("SELECT 1 FROM drivers WHERE portal_ref = ?").get(p.ref));
      try {
        const driver = upsertDriver(p);
        if (!existedBefore) {
          await sendActivationSms(driver);
          activationsSent += 1;
        }
      } catch (e) {
        console.error(`[chauffeurs] synchronisation impossible pour ${p.ref} : ${e.message}`);
      }
    }
    let deactivated = 0;
    for (const row of db.prepare("SELECT id, portal_ref FROM drivers WHERE active = 1").all()) {
      if (refs.has(row.portal_ref)) continue;
      db.prepare("UPDATE drivers SET active = 0 WHERE id = ?").run(row.id);
      revokeAll(row.id);
      deactivated += 1;
    }
    return { updated: list.length, activationsSent, deactivated };
  }

  /** Renvoie un lien d'activation (perdu, expiré, ou jamais ouvert) : utilisé par l'onglet Exploitation. */
  async function resendActivation(driverId) {
    const driver = byId(driverId);
    if (!driver) return { error: "not_found" };
    await sendActivationSms(driver);
    return { ok: true };
  }

  return { login, authenticate, logout, upsertDriver, syncApproved, revokeAll, byId, byPlate, activationInfo, finishActivation, recoverReset, resendActivation, createActivation };
}
