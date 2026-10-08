// Informations propres à l'éditeur du site, lues dans l'environnement : les pages légales ne contiennent AUCUNE identité inventée.
// En développement, une valeur absente est simplement affichée « à compléter » ; en production, le démarrage est refusé (assertProductionConfig).

/** Variables obligatoires en production : [nom, explication]. */
export const LEGAL_REQUIRED = [
  ["LEGAL_ENTITY", "nom de la société ou de l'association qui édite le site"],
  ["LEGAL_ADDRESS", "adresse postale de l'éditeur"],
  ["LEGAL_EMAIL", "adresse e-mail pour exercer ses droits (accès, suppression)"],
  ["LEGAL_HOST", "hébergeur et pays du serveur, ex. « Tunisie Telecom Data Center, Tunisie »"],
  ["LEGAL_RETENTION_REJECTED_MONTHS", "mois de conservation d'un dossier refusé ou abandonné"],
  ["LEGAL_RETENTION_APPROVED_MONTHS", "mois de conservation après la fin de la collaboration avec un chauffeur accepté"],
  ["LEGAL_BACKUP_DAYS", "jours de conservation des sauvegardes : la MÊME valeur que KEEP_DAYS dans deploy/backup.sh"],
];

const SMS_PROVIDERS = { twilio: "Twilio (États-Unis)" };
const MONTHS = /^[1-9]\d{0,2}$/; // aussi utilisé pour les jours de sauvegarde

/** @returns {string[]} problèmes de configuration (jamais de valeur secrète : ces variables sont publiques). */
export function legalProblems(env) {
  const problems = [];
  for (const [name, hint] of LEGAL_REQUIRED) {
    const value = String(env[name] ?? "").trim();
    if (!value) problems.push(`${name} : ${hint}`);
    else if (/_(MONTHS|DAYS)$/.test(name) && !MONTHS.test(value)) problems.push(`${name} : nombre entier entre 1 et 999`);
  }
  if (env.LEGAL_EMAIL && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(env.LEGAL_EMAIL)) problems.push("LEGAL_EMAIL : adresse e-mail invalide");
  return problems;
}

/** Valeurs publiques envoyées aux pages légales. Une valeur absente vaut null (la page affiche « à compléter »). */
export function legalValues(env) {
  const text = (name) => String(env[name] ?? "").trim() || null;
  const months = (name) => (MONTHS.test(String(env[name] ?? "").trim()) ? Number(env[name]) : null);
  return {
    entity: text("LEGAL_ENTITY"),
    address: text("LEGAL_ADDRESS"),
    email: text("LEGAL_EMAIL"),
    phone: text("LEGAL_PHONE"),
    registration: text("LEGAL_REGISTRATION"),
    publisher: text("LEGAL_PUBLISHER"),
    host: text("LEGAL_HOST"),
    sms: SMS_PROVIDERS[String(env.SMS_PROVIDER ?? "").toLowerCase()] ?? null,
    retention_rejected: months("LEGAL_RETENTION_REJECTED_MONTHS"),
    retention_approved: months("LEGAL_RETENTION_APPROVED_MONTHS"),
    backup_days: months("LEGAL_BACKUP_DAYS"),
  };
}
