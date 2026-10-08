import crypto from "node:crypto";
import { otpMessage } from "./sms.js";
import { latinDigits } from "./validate.js";

export const OTP = {
  ttlMs: 5 * 60_000,          // validité du code
  maxAttempts: 5,             // essais avant verrouillage du code
  cooldownMs: 60_000,         // délai minimum entre deux envois au même numéro
  perPhoneHour: 3,            // envois max par numéro et par heure
  tokenTtlMs: 30 * 60_000,    // validité du jeton « téléphone vérifié »
};

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * Service OTP. Garde-fous contre le détournement d'envois (« SMS pumping ») : numéros tunisiens uniquement
 * (validés en amont), délai entre envois, quota par numéro, plafond quotidien global.
 * `now` est injectable pour tester l'expiration sans attendre.
 */
export function createOtpService({ db, sms, secret, now = Date.now, dailyCap = Number(process.env.SMS_DAILY_CAP || 200) }) {
  const codeHash = (phone, code) => crypto.createHmac("sha256", secret).update(`${phone}:${code}`).digest("hex");

  const housekeeping = (t) => {
    db.prepare("DELETE FROM otp_sends WHERE at < ?").run(t - 2 * 86_400_000);
    db.prepare("DELETE FROM phone_verifications WHERE expires_at < ? OR used = 1").run(t - 86_400_000);
    db.prepare("DELETE FROM otp_codes WHERE expires_at < ?").run(t - 3_600_000);
  };

  async function send(phone, lang) {
    const t = now();
    housekeeping(t);

    const last = db.prepare("SELECT sent_at FROM otp_codes WHERE phone = ?").get(phone);
    if (last && t - last.sent_at < OTP.cooldownMs) {
      return { error: "otp_cooldown", retry_after: Math.ceil((OTP.cooldownMs - (t - last.sent_at)) / 1000) };
    }
    const hourly = db.prepare("SELECT COUNT(*) AS n FROM otp_sends WHERE phone = ? AND at > ?").get(phone, t - 3_600_000).n;
    if (hourly >= OTP.perPhoneHour) return { error: "otp_limit" };
    const daily = db.prepare("SELECT COUNT(*) AS n FROM otp_sends WHERE at > ?").get(t - 86_400_000).n;
    if (daily >= dailyCap) return { error: "sms_unavailable" };

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const prev = db.prepare("SELECT * FROM otp_codes WHERE phone = ?").get(phone);
    db.prepare(
      `INSERT INTO otp_codes (phone, code_hash, expires_at, attempts, sent_at) VALUES (?,?,?,0,?)
       ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`
    ).run(phone, codeHash(phone, code), t + OTP.ttlMs, t);
    const logged = Number(db.prepare("INSERT INTO otp_sends (phone, at) VALUES (?, ?)").run(phone, t).lastInsertRowid);

    try {
      await sms.send(phone, otpMessage(code, lang));
    } catch (e) {
      // L'envoi a échoué : on annule pour que l'utilisateur puisse réessayer tout de suite et que le quota ne soit pas consommé.
      db.prepare("DELETE FROM otp_sends WHERE id = ?").run(logged);
      if (prev) {
        db.prepare("UPDATE otp_codes SET code_hash = ?, expires_at = ?, attempts = ?, sent_at = ? WHERE phone = ?").run(prev.code_hash, prev.expires_at, prev.attempts, prev.sent_at, phone);
      } else {
        db.prepare("DELETE FROM otp_codes WHERE phone = ?").run(phone);
      }
      console.error("[otp] échec d'envoi SMS:", e.message);
      return { error: "sms_failed" };
    }
    return { ok: true, retry_after: OTP.cooldownMs / 1000 };
  }

  function verify(phone, code) {
    const t = now();
    const row = db.prepare("SELECT * FROM otp_codes WHERE phone = ?").get(phone);
    const digits = latinDigits(code);
    if (!row || !/^\d{6}$/.test(digits)) return { error: "otp_invalid" };
    if (t > row.expires_at) {
      db.prepare("DELETE FROM otp_codes WHERE phone = ?").run(phone);
      return { error: "otp_expired" };
    }
    if (row.attempts >= OTP.maxAttempts) return { error: "otp_locked" };

    const given = Buffer.from(codeHash(phone, digits), "hex");
    const stored = Buffer.from(row.code_hash, "hex");
    if (!crypto.timingSafeEqual(given, stored)) {
      const attempts = row.attempts + 1;
      db.prepare("UPDATE otp_codes SET attempts = ? WHERE phone = ?").run(attempts, phone);
      return attempts >= OTP.maxAttempts ? { error: "otp_locked" } : { error: "otp_invalid", attempts_left: OTP.maxAttempts - attempts };
    }
    db.prepare("DELETE FROM otp_codes WHERE phone = ?").run(phone);
    const token = crypto.randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO phone_verifications (token_hash, phone, expires_at) VALUES (?,?,?)").run(sha(token), phone, t + OTP.tokenTtlMs);
    return { token, expires_in: OTP.tokenTtlMs / 1000 };
  }

  /** Vérifie un jeton sans le consommer. */
  function peek(token, phone) {
    if (!token || !phone) return false;
    return Boolean(
      db.prepare("SELECT 1 FROM phone_verifications WHERE token_hash = ? AND phone = ? AND used = 0 AND expires_at > ?").get(sha(String(token)), phone, now())
    );
  }

  /** Consomme le jeton de façon atomique (à appeler dans la transaction d'inscription). */
  function consume(token, phone) {
    const info = db
      .prepare("UPDATE phone_verifications SET used = 1 WHERE token_hash = ? AND phone = ? AND used = 0 AND expires_at > ?")
      .run(sha(String(token)), phone, now());
    return info.changes === 1;
  }

  return { send, verify, peek, consume };
}
