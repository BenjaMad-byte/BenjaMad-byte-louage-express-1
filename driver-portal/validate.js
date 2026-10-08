import crypto from "node:crypto";
import { places, matchKey } from "./public/places.js";

export const GOVERNORATES = [
  "Ariana", "Béja", "Ben Arous", "Bizerte", "Gabès", "Gafsa", "Jendouba", "Kairouan",
  "Kasserine", "Kébili", "Le Kef", "Mahdia", "La Manouba", "Médenine", "Monastir", "Nabeul",
  "Sfax", "Sidi Bouzid", "Siliana", "Sousse", "Tataouine", "Tozeur", "Tunis", "Zaghouan",
];

// national = louage qui circule dans tous les gouvernorats (pas de ligne fixe) : on retient seulement sa ville de départ habituelle.
// rural = desserte des villages (transport rural), comme le régional elle reste dans le gouvernorat de la station.
export const LINE_TYPES = ["regional", "interregional", "national", "rural"];
export const MAX_VIA = 5;
const isChecked = (v) => v === "on" || v === "true" || v === true;

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** « Métlaoui, Oum Larayes » → ["Métlaoui", "Oum Larayes"] (séparateurs , ، ; et retour à la ligne ; doublons ignorés). */
export function parseVia(raw, exclude = "") {
  const seen = new Set([String(exclude).trim().toLowerCase()]);
  const out = [];
  for (const part of String(raw ?? "").split(/[,،;\n]/)) {
    const c = clean(part, 60);
    const key = c.toLowerCase();
    if (!c || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Un clavier arabe peut produire des chiffres indo-arabes (٠-٩ / ۰-۹) : on les ramène à 0-9. */
export const latinDigits = (s) =>
  String(s ?? "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

/** Téléphone tunisien : 8 chiffres, mobile en 2/4/5/9, +216/00216 optionnel. */
export function normalizePhone(raw) {
  const digits = latinDigits(raw).replace(/[\s.\-()]/g, "").replace(/^(\+216|00216)/, "");
  return /^[2459]\d{7}$/.test(digits) ? digits : null;
}

export function normalizeCin(raw) {
  const digits = latinDigits(raw).replace(/\s/g, "");
  return /^\d{8}$/.test(digits) ? digits : null;
}

/** Valide le formulaire d'inscription. Retourne { ok, values, errors } avec des codes d'erreur traduits côté client. */
export function validateApplication(body) {
  const errors = {};
  const values = {
    full_name: clean(body.full_name, 80),
    phone: normalizePhone(body.phone),
    cin: normalizeCin(body.cin),
    role: "driver", // le site est réservé aux chauffeurs de louage
    plate: clean(body.plate, 20).toUpperCase(),
    governorate: clean(body.governorate, 40),
    station: clean(body.station, 80),
    line_type: body.line_type,
    line_from: clean(body.line_from, 60),
    line_to_gov: clean(body.line_to_gov, 40),
    line_via: [],
    pickup_en_route: isChecked(body.pickup_en_route),
    leaves_partial: isChecked(body.leaves_partial),
    lang: body.lang === "fr" ? "fr" : "ar",
  };
  if (values.full_name.length < 3) errors.full_name = "invalid_name";
  if (!values.phone) errors.phone = "invalid_phone";
  if (!values.cin) errors.cin = "invalid_cin";
  if (body.role !== undefined && body.role !== "" && body.role !== "driver") errors.role = "invalid_role";
  if (values.plate.length < 4) errors.plate = "invalid_plate";
  if (!GOVERNORATES.includes(values.governorate)) errors.governorate = "invalid_governorate";
  if (values.station.length < 2) errors.station = "invalid_station";
  // Circuit : ville de départ -> gouvernorat d'arrivée. Régional = reste dans le gouvernorat de la station ; interrégional = en sort.
  if (!LINE_TYPES.includes(values.line_type)) errors.line_type = "invalid_line_type";
  if (values.line_from.length < 2) errors.line_from = "invalid_line_from";
  if (values.line_type === "national") values.line_to_gov = "";
  else if (!GOVERNORATES.includes(values.line_to_gov)) errors.line_to_gov = "invalid_line_to_gov";
  else if (!errors.governorate && !errors.line_type) {
    const sameGov = values.line_to_gov === values.governorate;
    if (values.line_type === "regional" && !sameGov) errors.line_to_gov = "line_regional_same_gov";
    if (values.line_type === "rural" && !sameGov) errors.line_to_gov = "line_rural_same_gov";
    if (values.line_type === "interregional" && sameGov) errors.line_to_gov = "line_interregional_other_gov";
  }
  // Arrêts en route : un louage charge parfois des passagers dans d'autres villes sur son chemin, ou part incomplet et complète en route.
  values.line_via = parseVia(body.line_via, values.line_from);
  if (values.line_via.length > MAX_VIA) errors.line_via = "line_via_too_many";
  else if (values.line_via.some((c) => c.length < 2)) errors.line_via = "invalid_line_via";
  else if (values.pickup_en_route && values.line_via.length === 0) errors.line_via = "line_via_required";
  // La ligne AFFICHÉE utilise les noms officiels (« الرديف » et « Redeyef » donnent « Redeyef ») ; ce que le chauffeur a écrit reste enregistré tel quel.
  const officialName = (city, governorates, anywhere = false) => (places.find(city, governorates) ?? (anywhere ? places.find(city) : null))?.fr ?? city;
  const from = officialName(values.line_from, [values.governorate]);
  const seen = new Set([matchKey(from)]);
  const stops = values.line_via
    .map((city) => officialName(city, [values.governorate, values.line_to_gov].filter(Boolean), true))
    .filter((city) => {
      const key = matchKey(city);
      if (seen.has(key)) return false; // même ville écrite deux fois (arabe + français), ou identique au départ
      seen.add(key);
      return true;
    });
  const via = stops.length ? ` (via ${stops.join(", ")})` : "";
  values.route = `${from} → ${values.line_type === "national" ? "tous les gouvernorats" : values.line_to_gov}${via}`;
  const checked = isChecked;
  if (!checked(body.consent)) errors.consent = "consent_required";
  // Le visage est une donnée biométrique : consentement explicite et distinct.
  if (!checked(body.consent_biometric)) errors.consent_biometric = "consent_required";
  return { ok: Object.keys(errors).length === 0, values, errors };
}

/** Référence lisible sans caractères ambigus (0/O, 1/I). */
export function newRef() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return `LX-${out}`;
}

export function normalizeRef(raw) {
  const v = String(raw ?? "").trim().toUpperCase();
  return /^LX-[A-Z2-9]{8}$/.test(v) ? v : null;
}

/** Vérifie la signature binaire réelle du fichier (le type MIME déclaré par le client n'est pas fiable). */
export function sniffMime(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

export const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf" };
export { clean };
