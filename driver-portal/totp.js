// Mots de passe à usage unique basés sur le temps (TOTP, RFC 6238) : Google Authenticator, Microsoft Authenticator, FreeOTP, etc.
// SHA-1, 6 chiffres, pas de 30 s : les valeurs que ces applications acceptent toutes.
import crypto from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const PERIOD_SECONDS = 30;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Tolère espaces, tirets, minuscules et « = » de remplissage (saisie à la main d'une clé affichée par groupes). */
export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error("clé base32 invalide");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 160 bits : la taille recommandée par la RFC 4226. */
export const generateSecret = () => crypto.randomBytes(20);

export const stepOf = (ms) => Math.floor(ms / 1000 / PERIOD_SECONDS);

export function hotp(secret, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secret).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const binary = ((hmac[offset] & 127) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * Vérifie un code saisi. `window` : nombre de pas de tolérance de part et d'autre (horloges légèrement décalées).
 * `lastStep` : dernier pas déjà accepté pour ce compte ; un code d'un pas déjà utilisé (ou antérieur) est refusé, donc un code ne sert qu'une fois.
 * @returns {number|null} le pas accepté, à enregistrer comme nouveau `lastStep`, ou null.
 */
export function verifyTotp(secret, code, nowMs, { lastStep = -1, window = 1 } = {}) {
  const given = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  const current = stepOf(nowMs);
  let accepted = null;
  for (let step = current - window; step <= current + window; step++) {
    if (step <= lastStep) continue;
    const expected = hotp(secret, step);
    // Pas de sortie anticipée : le temps de calcul ne dépend pas du pas qui correspond.
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given)) && accepted === null) accepted = step;
  }
  return accepted;
}

/** Adresse à encoder en QR ou à ouvrir sur un téléphone : otpauth://totp/Louage%20Express:alice?secret=...&issuer=... */
export function otpauthUri({ secret, account, issuer = "Louage Express" }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${PERIOD_SECONDS}`;
}
