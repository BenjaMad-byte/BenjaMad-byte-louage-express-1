// Garde-fous de sécurité : chiffrement des fichiers au repos, contrôle d'origine, configuration de production, liste blanche d'IP admin.
import crypto from "node:crypto";
import { legalProblems } from "./legal.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Chiffre un fichier (AES-256-GCM). Format : IV (12 o) | étiquette d'authentification (16 o) | contenu chiffré. */
export function encryptBuffer(plain, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** Déchiffre et authentifie : lève une erreur si la clé est mauvaise ou si le fichier a été modifié. */
export function decryptBuffer(blob, key) {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new Error("fichier chiffré invalide");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, blob.subarray(0, IV_BYTES));
  decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

/** DATA_KEY : 32 octets en hexadécimal (64 caractères) ou en base64. Retourne null si absente. */
export function parseDataKey(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  if (key.length !== 32) throw new Error("DATA_KEY doit représenter 32 octets (64 caractères hexadécimaux ou une valeur base64 de 32 octets)");
  return key;
}

/** Empreinte d'une clé : 16 caractères hexadécimaux, assez pour distinguer les clés, impossible à inverser. Elle seule est enregistrée, jamais la clé. */
export function keyId(key) {
  return crypto.createHash("sha256").update("louage-express:key-id:").update(key).digest("hex").slice(0, 16);
}

/**
 * Clé courante (écriture) + anciennes clés (lecture seule, pendant une rotation). `previousRaw` : liste séparée par des virgules.
 * Refuse les cas dangereux : anciennes clés sans clé courante, doublons, clé courante déjà présente parmi les anciennes.
 */
export function parseDataKeys(currentRaw, previousRaw) {
  const current = parseDataKey(currentRaw);
  const previous = String(previousRaw ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((raw) => {
    try {
      return parseDataKey(raw);
    } catch {
      throw new Error("DATA_KEY_PREVIOUS : chaque ancienne clé doit représenter 32 octets (64 caractères hexadécimaux ou base64), séparées par des virgules");
    }
  });
  if (previous.length && !current) throw new Error("DATA_KEY_PREVIOUS ne peut pas être défini sans DATA_KEY (la nouvelle clé qui sert à écrire)");
  const ids = previous.map(keyId);
  if (new Set(ids).size !== ids.length) throw new Error("DATA_KEY_PREVIOUS : une même clé est indiquée deux fois");
  if (current && ids.includes(keyId(current))) throw new Error("DATA_KEY_PREVIOUS est identique à DATA_KEY : retirer la clé courante de la liste des anciennes");
  return { current, previous };
}

const isLocalhost = (url) => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** En production, refuse de démarrer avec une configuration faible ; liste tous les problèmes d'un coup. */
export function assertProductionConfig(env) {
  if (env.NODE_ENV !== "production") return;
  const problems = [];
  if (String(env.ADMIN_TOKEN ?? "").length < 32) problems.push("ADMIN_TOKEN : 32 caractères minimum (ex. openssl rand -base64 32)");
  try {
    if (!parseDataKey(env.DATA_KEY)) problems.push("DATA_KEY : requise (chiffrement des pièces d'identité et des selfies au repos)");
  } catch (e) {
    problems.push(e.message);
  }
  if (env.DATA_KEY_PREVIOUS) {
    try {
      parseDataKeys(env.DATA_KEY, env.DATA_KEY_PREVIOUS);
    } catch (e) {
      problems.push(e.message);
    }
  }
  if (String(env.OTP_SECRET ?? "").length < 32) problems.push("OTP_SECRET : 32 caractères minimum");
  if (String(env.KYC_SERVICE_KEY ?? "").length < 16) problems.push("KYC_SERVICE_KEY : 16 caractères minimum");
  const kycUrl = env.KYC_BACKEND_URL || "http://localhost:4000";
  if (!kycUrl.startsWith("https://") && !isLocalhost(kycUrl)) problems.push("KYC_BACKEND_URL : https obligatoire (les photos de CIN et de visage y transitent)");
  // Le serveur ne fait pas le TLS lui-même : il est derrière un proxy. Sans TRUST_PROXY il ne verrait jamais « https » et redirigerait en boucle.
  if (!/^[1-9]\d*$/.test(String(env.TRUST_PROXY ?? ""))) problems.push("TRUST_PROXY : nombre de proxys devant l'app (1 derrière Caddy ou nginx) ; sans lui, le HTTPS forcé redirige en boucle");
  if (!/^https:\/\/[^/\s]+\/?$/i.test(String(env.PUBLIC_URL ?? ""))) problems.push("PUBLIC_URL : adresse https du site, ex. https://inscription.exemple.tn (aperçus WhatsApp, plan du site)");
  if (!env.SMS_PROVIDER || env.SMS_PROVIDER.toLowerCase() === "console") problems.push("SMS_PROVIDER : un vrai fournisseur est requis (twilio), pas « console »");
  problems.push(...legalProblems(env));
  if (problems.length) throw new Error(`Configuration de production refusée :\n - ${problems.join("\n - ")}`);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Bloque les requêtes d'écriture déclenchées depuis un autre site (CSRF). Les navigateurs envoient Origin et Sec-Fetch-Site ;
 * un client sans ces en-têtes (script, outil) passe, et reste soumis aux limites de débit, au SMS et à l'authentification.
 */
export function sameOriginGuard({ allowed = [] } = {}) {
  const deny = (res) => res.status(403).json({ error: "origin_forbidden" });
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const site = req.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return deny(res);
    const origin = req.get("origin");
    if (origin !== undefined) {
      let host;
      try {
        host = new URL(origin).host;
      } catch {
        return deny(res);
      }
      if (host !== req.get("host") && !allowed.includes(origin)) return deny(res);
    }
    next();
  };
}

/** Liste vide = pas de restriction. Les adresses IPv4 mappées en IPv6 (::ffff:1.2.3.4) sont ramenées en IPv4. */
export function isAllowedAdminIp(ip, allowedIps) {
  if (!allowedIps.length) return true;
  if (!ip) return false;
  return allowedIps.includes(ip.replace(/^::ffff:/, ""));
}
