// Configuration du service d'application chauffeur et garde-fous de production.
import { normalizePhone } from "../driver-portal/validate.js";

/** Numéros d'urgence affichés dans l'application : l'application ne les appelle PAS elle-même, le chauffeur touche pour composer. À vérifier avant la mise en ligne. */
export const DEFAULT_EMERGENCY = Object.freeze([
  { label: "Police", number: "197" },
  { label: "Protection civile", number: "198" },
  { label: "SAMU", number: "190" },
]);

/** « Police=197,SAMU=190 » → [{label, number}] ; entrées invalides ignorées (chiffres seulement : un numéro d'urgence ne se compose qu'en chiffres). */
export function parseEmergency(raw) {
  if (!raw) return [...DEFAULT_EMERGENCY];
  const out = String(raw).split(",").map((part) => {
    const [label, number] = part.split("=").map((x) => x?.trim());
    return label && /^\d{2,5}$/.test(number ?? "") ? { label: label.slice(0, 30), number } : null;
  }).filter(Boolean);
  return out.length ? out : [...DEFAULT_EMERGENCY];
}

/** Numéros de permanence qui reçoivent les alertes SOS (8 chiffres tunisiens). */
export const parsePhones = (raw) => [...new Set(String(raw ?? "").split(",").map((p) => normalizePhone(p.trim())).filter(Boolean))];

const isLocal = (url) => {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** En production, refuse de démarrer avec une configuration faible ; liste tous les problèmes d'un coup. */
export function assertAppConfig(env) {
  if (env.NODE_ENV !== "production") return;
  const problems = [];
  if (String(env.OTP_SECRET ?? "").length < 32) problems.push("OTP_SECRET : 32 caractères minimum");
  if (String(env.APP_SERVICE_KEY ?? "").length < 16) problems.push("APP_SERVICE_KEY : 16 caractères minimum (la même que dans l'environnement du site d'inscription)");
  if (String(env.OPS_SERVICE_KEY ?? "").length < 16) problems.push("OPS_SERVICE_KEY : 16 caractères minimum (clé de l'onglet Exploitation de la console d'administration)");
  if (env.OPS_SERVICE_KEY && env.OPS_SERVICE_KEY === env.APP_SERVICE_KEY) problems.push("OPS_SERVICE_KEY doit être différente de APP_SERVICE_KEY");
  const portal = env.PORTAL_URL || "";
  if (!portal.startsWith("https://") && !isLocal(portal)) problems.push("PORTAL_URL : https obligatoire (ou localhost sur la même machine)");
  if (!/^[1-9]\d*$/.test(String(env.TRUST_PROXY ?? ""))) problems.push("TRUST_PROXY : nombre de proxys devant l'application (1 derrière Caddy ou nginx)");
  if (!/^https:\/\/[^/\s]+\/?$/i.test(String(env.PUBLIC_URL ?? ""))) problems.push("PUBLIC_URL : adresse https du site de l'application");
  if (!env.SMS_PROVIDER || env.SMS_PROVIDER.toLowerCase() === "console") problems.push("SMS_PROVIDER : un vrai fournisseur est requis (twilio), pas « console »");
  if (env.RESERVATIONS === "on") {
    // Aucune connexion réelle à un opérateur n'existe : l'ouverture des réservations en ligne en production serait un faux paiement.
    if (!env.SVA_PROVIDER || env.SVA_PROVIDER.toLowerCase() === "simulated") problems.push("RESERVATIONS=on exige un vrai fournisseur SVA (SVA_PROVIDER) : seule la simulation existe aujourd'hui, elle est interdite en production");
    if (String(env.SVA_CALLBACK_SECRET ?? "").length < 32) problems.push("SVA_CALLBACK_SECRET : 32 caractères minimum (signature des retours de l'opérateur)");
  }
  if (parsePhones(env.SOS_ALERT_PHONES).length === 0) problems.push("SOS_ALERT_PHONES : au moins un numéro de permanence (8 chiffres) qui reçoit les alertes SOS. Sans personne de garde, ne pas activer le SOS auprès des chauffeurs");
  if (problems.length) throw new Error(`Configuration de production refusée :\n - ${problems.join("\n - ")}`);
}
