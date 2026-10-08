// Brouillon du formulaire d'inscription, gardé SUR LE TÉLÉPHONE pour ne pas tout retaper après une coupure de réseau ou un rechargement.
// Module sans accès au navigateur (testé seul). Minimisation des données, puisque le téléphone peut être partagé :
//   - JAMAIS enregistrés : les photos (documents, selfies), les consentements (à redonner à chaque fois), le numéro de CIN, le code SMS ;
//   - effacé tout seul au bout de 3 jours, et après un envoi réussi ; un bouton permet de l'effacer à la main ;
//   - tout ce qui est relu est revalidé (type, longueur, valeurs permises) : un stockage modifié ou corrompu ne peut rien casser.

export const DRAFT_KEY = "lx_draft_v1";
export const OTP_KEY = "lx_otp_v1";
export const DRAFT_VERSION = 1;
export const DRAFT_TTL_MS = 3 * 24 * 3600 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000; // une horloge de téléphone mal réglée ne doit pas invalider un brouillon récent
const OTP_SAFETY_MS = 90 * 1000;            // on tient le jeton pour expiré un peu avant le serveur

const TEXT_MAX = { full_name: 80, phone: 20, plate: 20, station: 80, line_from: 60, line_via: 200, governorate: 40, line_to_gov: 40 };
const FLAGS = ["pickup_en_route", "leaves_partial"];
const LINE_TYPES = ["regional", "interregional", "rural", "national"];
export const DRAFT_FIELDS = [...Object.keys(TEXT_MAX), "line_type", ...FLAGS];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Ne garde que les champs prévus, avec le bon type et la bonne longueur. Retourne { fields, meaningful }. */
function sanitize(values) {
  const fields = {};
  let meaningful = false;
  for (const [name, max] of Object.entries(TEXT_MAX)) {
    if (typeof values[name] !== "string") continue;
    const v = values[name].trim().slice(0, max);
    if (v) { fields[name] = v; meaningful = true; }
  }
  if (typeof values.line_type === "string" && LINE_TYPES.includes(values.line_type)) { fields.line_type = values.line_type; meaningful = true; }
  for (const name of FLAGS) {
    if (typeof values[name] === "boolean") { fields[name] = values[name]; if (values[name]) meaningful = true; }
  }
  return { fields, meaningful };
}

/** @returns {{v: number, savedAt: number, fields: object} | null} null si rien de significatif n'a été saisi. */
export function buildDraft(values, now = Date.now()) {
  const { fields, meaningful } = sanitize(isObject(values) ? values : {});
  return meaningful ? { v: DRAFT_VERSION, savedAt: now, fields } : null;
}

/** Relit un brouillon depuis le stockage. Retourne { fields, savedAt } ou null (absent, périmé, autre version, illisible, vide). */
export function readDraft(raw, now = Date.now()) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(data) || data.v !== DRAFT_VERSION || typeof data.savedAt !== "number" || !Number.isFinite(data.savedAt)) return null;
  if (data.savedAt > now + FUTURE_TOLERANCE_MS || now - data.savedAt > DRAFT_TTL_MS) return null;
  if (!isObject(data.fields)) return null;
  const { fields, meaningful } = sanitize(data.fields);
  return meaningful ? { fields, savedAt: data.savedAt } : null;
}

/** Vérification du téléphone, gardée pour l'onglet seulement (sessionStorage) : un rechargement ne coûte pas un deuxième SMS. */
export function buildOtpState({ token, phone, expiresInSeconds }, now = Date.now()) {
  if (typeof token !== "string" || token.length < 20 || !/^\d{8}$/.test(String(phone))) return null;
  return { token, phone: String(phone), expiresAt: now + Math.max(0, Number(expiresInSeconds) * 1000 - OTP_SAFETY_MS) };
}

export function readOtpState(raw, now = Date.now()) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(data)) return null;
  const { token, phone, expiresAt } = data;
  if (typeof token !== "string" || token.length < 20 || token.length > 100 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  if (typeof phone !== "string" || !/^\d{8}$/.test(phone)) return null;
  if (typeof expiresAt !== "number" || !(expiresAt > now)) return null;
  return { token, phone };
}
