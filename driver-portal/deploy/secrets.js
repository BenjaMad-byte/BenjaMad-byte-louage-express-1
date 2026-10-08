// Génère les secrets du portail. Usage : node deploy/secrets.js   (les valeurs sont affichées UNE fois : à copier dans portal.env et dans un gestionnaire de mots de passe).
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const b64url = (bytes) => crypto.randomBytes(bytes).toString("base64url");
const hex = (bytes) => crypto.randomBytes(bytes).toString("hex");

export function generateSecrets() {
  return {
    ADMIN_TOKEN: b64url(32),      // 43 caractères
    DATA_KEY: hex(32),            // 64 caractères hexadécimaux = 32 octets (AES-256)
    OTP_SECRET: hex(32),
    KYC_SERVICE_KEY: b64url(24),  // identique côté portail et côté backend KYC
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error("# Secrets générés. DATA_KEY : la perdre = perdre définitivement les pièces. La sauvegarder HORS du serveur.\n");
  for (const [k, v] of Object.entries(generateSecrets())) console.log(`${k}=${v}`);
}
