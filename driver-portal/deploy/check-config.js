// Vérifie un fichier d'environnement AVANT de démarrer en production. Usage : node deploy/check-config.js /etc/louage/portal.env
// Code de sortie 0 = prêt, 1 = erreurs bloquantes. Ne jamais afficher les valeurs des secrets.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertProductionConfig } from "../security.js";

/** Lit un fichier KEY=VALUE (commentaires #, `export`, guillemets simples ou doubles). */
export function parseEnvFile(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    env[m[1]] = value;
  }
  return env;
}

/** @returns {{errors: string[], warnings: string[]}} les erreurs ne contiennent jamais la valeur d'un secret. */
export function checkConfig(env) {
  const errors = [];
  const warnings = [];
  try {
    assertProductionConfig({ ...env, NODE_ENV: "production" });
  } catch (e) {
    errors.push(...e.message.split("\n - ").slice(1));
  }
  if (String(env.SMS_PROVIDER ?? "").toLowerCase() === "twilio") {
    const missing = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"].filter((k) => !env[k]);
    if (!env.TWILIO_FROM && !env.TWILIO_MESSAGING_SERVICE_SID) missing.push("TWILIO_FROM (ou TWILIO_MESSAGING_SERVICE_SID)");
    if (missing.length) errors.push(`TWILIO : ${missing.join(", ")} manquant(s)`);
  }
  if (env.SMS_NOTIFICATIONS === "on" && String(env.SMS_PROVIDER ?? "").toLowerCase() !== "twilio") warnings.push("SMS_NOTIFICATIONS=on sans fournisseur SMS réel : les notifications ne partiront pas.");
  if (env.SMS_NOTIFICATIONS === "on" && !(Number(env.NOTIFY_DAILY_CAP) > 0)) warnings.push("SMS_NOTIFICATIONS=on sans NOTIFY_DAILY_CAP : plafond par défaut de 300 SMS par 24 h (le même budget que les codes de vérification, SMS_DAILY_CAP, est compté à part).");
  if (env.DATA_KEY_PREVIOUS) warnings.push("DATA_KEY_PREVIOUS est défini : rotation de clé en cours. Lancer « npm run rotate-key », vérifier avec --status, puis retirer cette variable une fois les anciennes sauvegardes expirées.");
  if (!env.ADMIN_ALLOWED_IPS) warnings.push("ADMIN_ALLOWED_IPS est vide : l'API admin est joignable depuis n'importe où (le jeton reste exigé). Recommandé : l'IP de ton bureau ou de ton VPN.");
  if (!["127.0.0.1", "::1", "localhost"].includes(env.HOST ?? "")) warnings.push("HOST n'est pas 127.0.0.1 : l'application doit n'écouter que le proxy local.");
  if (!path.isAbsolute(env.DATA_DIR ?? "")) warnings.push("DATA_DIR n'est pas un chemin absolu : indiquer le volume chiffré (ex. /srv/louage/data).");
  return { errors, warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error("Usage : node deploy/check-config.js <fichier .env>  (fichier introuvable)");
    process.exit(1);
  }
  const { errors, warnings } = checkConfig(parseEnvFile(fs.readFileSync(file, "utf8")));
  if (process.platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0) warnings.push(`${file} est lisible par d'autres comptes : chmod 600 ${file}`);
  for (const w of warnings) console.warn(`⚠ ${w}`);
  if (errors.length) {
    console.error(`✖ Configuration refusée :\n - ${errors.join("\n - ")}`);
    process.exit(1);
  }
  console.log("✔ Configuration valide.");
}
