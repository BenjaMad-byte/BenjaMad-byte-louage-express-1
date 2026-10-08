// Classement des circuits déclarés par les chauffeurs, par gouvernorat de départ (la source du réseau de louages : il n'existe pas de liste publique).
import { GOVERNORATES, LINE_TYPES } from "./validate.js";
import { places } from "./public/places.js";

/** Clé de regroupement : « Redeyef », « redeyef » et « Redéyef » sont la même ville (accents latins et voyelles brèves arabes ignorés). */
export const foldPlace = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ًͯ-ٰٟ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** `line_via` est stocké en JSON ; une valeur illisible ou absente (anciennes demandes) donne une liste vide. */
const parseViaColumn = (raw) => {
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((c) => typeof c === "string") : [];
  } catch {
    return [];
  }
};

/**
 * Identifie une ville saisie : nom officiel reconnu (français, arabe ou variante), sinon simple regroupement des orthographes.
 * `anywhere` : accepter aussi un nom unique dans tout le pays (arrêts en route, souvent hors du gouvernorat de la station).
 */
function resolveCity(text, governorates, anywhere = false) {
  const hit = places.find(text, governorates) ?? (anywhere ? places.find(text) : null);
  if (hit) return { key: `@${hit.governorate}|${hit.fr}`, fr: hit.fr, ar: hit.ar, recognized: true };
  return { key: foldPlace(text), fr: String(text), ar: null, recognized: false };
}

/**
 * @param {{governorate:string, line_type:string|null, line_from:string|null, line_to_gov:string|null, status:string}[]} rows
 * @returns {{governorate:string, drivers:number, regional:object[], interregional:object[], national:object[], rural:object[]}[]} les 24 gouvernorats, même ceux sans circuit.
 */
export function buildNetwork(rows) {
  const byGov = new Map(GOVERNORATES.map((g) => [g, { governorate: g, drivers: 0, groups: new Map() }]));
  for (const r of rows) {
    if (r.status === "rejected" || !LINE_TYPES.includes(r.line_type) || !r.line_from || !byGov.has(r.governorate)) continue;
    const gov = byGov.get(r.governorate);
    gov.drivers += 1;
    const from = resolveCity(r.line_from, [r.governorate]);
    const key = `${r.line_type}|${from.key}|${r.line_to_gov ?? ""}`;
    const g = gov.groups.get(key) ?? { type: r.line_type, to_gov: r.line_to_gov ?? null, from, spellings: new Map(), via: new Map(), drivers: 0, approved: 0, pickup: 0, partial: 0 };
    g.drivers += 1;
    if (r.status === "approved") g.approved += 1;
    if (r.pickup_en_route) g.pickup += 1;
    if (r.leaves_partial) g.partial += 1;
    for (const city of parseViaColumn(r.line_via)) {
      const stop = resolveCity(city, [r.governorate, r.line_to_gov].filter(Boolean), true);
      const cur = g.via.get(stop.key) ?? { stop, spellings: new Map(), drivers: 0 };
      cur.drivers += 1;
      cur.spellings.set(city, (cur.spellings.get(city) ?? 0) + 1);
      g.via.set(stop.key, cur);
    }
    g.spellings.set(r.line_from, (g.spellings.get(r.line_from) ?? 0) + 1);
    gov.groups.set(key, g);
  }
  return [...byGov.values()].map(({ governorate, drivers, groups }) => {
    const top = (spellings) => [...spellings.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const lines = [...groups.values()].map(({ spellings, via, from, type, to_gov, drivers: n, approved, pickup, partial }) => ({
      type,
      from: from.recognized ? from.fr : top(spellings),
      from_ar: from.ar,
      recognized: from.recognized,
      to_gov,
      drivers: n,
      approved,
      via: [...via.values()]
        .map((v) => ({ city: v.stop.recognized ? v.stop.fr : top(v.spellings), city_ar: v.stop.ar, recognized: v.stop.recognized, drivers: v.drivers }))
        .sort((a, b) => b.drivers - a.drivers || a.city.localeCompare(b.city)),
      pickup,
      partial,
    }));
    const sorted = (t) => lines.filter((l) => l.type === t).sort((a, b) => b.drivers - a.drivers || a.from.localeCompare(b.from));
    return { governorate, drivers, regional: sorted("regional"), interregional: sorted("interregional"), national: sorted("national"), rural: sorted("rural") };
  });
}

/** Les cellules qui commencent par = + - @ sont neutralisées (injection de formule à l'ouverture dans un tableur). */
const csvCell = (v) => {
  const s = String(v ?? "");
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function networkCsv(network) {
  const lines = [["gouvernorat_depart", "type", "ville_depart", "gouvernorat_arrivee", "chauffeurs", "acceptes", "arrets_en_route", "prennent_en_route", "partent_incomplets", "ville_depart_ar", "ville_reconnue"]];
  for (const g of network) {
    for (const l of [...g.regional, ...g.interregional, ...g.national, ...g.rural]) {
      lines.push([g.governorate, l.type, l.from, l.to_gov ?? "tous", l.drivers, l.approved, l.via.map((v) => v.city).join(" | "), l.pickup, l.partial, l.from_ar ?? "", l.recognized ? "oui" : "non"]);
    }
  }
  return "\ufeff" + lines.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
