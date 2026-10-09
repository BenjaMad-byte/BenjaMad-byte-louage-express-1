// Villes (délégations et chefs-lieux) de chaque gouvernorat, en arabe et en français : suggestions de saisie et fusion des orthographes.
// Module sans accès au navigateur : le formulaire s'en sert pour proposer des villes, le serveur pour reconnaître « الرديف », « Redeyef »
// et « redeyef » comme la même ville. La saisie libre reste toujours permise : une ville inconnue n'est jamais refusée.
import { PLACES, ALIASES, COORDS } from "./places-data.js";

const LATIN_MARKS = /[̀-ͯ]/g;
const ARABIC_MARKS = /[ً-ٰٟـ]/g; // voyelles brèves et tatwil
const SKIPPED_TOKENS = new Set(["el", "al", "le", "la"]); // « El Jem » = « Jem », « Le Kef » = « Kef »

/** Clé de comparaison : insensible à la casse, aux accents, aux tirets, aux articles et aux variantes d'écriture arabes courantes. */
export function matchKey(text) {
  const base = String(text ?? "")
    .normalize("NFD")
    .replace(LATIN_MARKS, "")
    .replace(ARABIC_MARKS, "")
    .toLowerCase()
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ئ/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!base) return "";
  return base
    .split(" ")
    .map((tok) => (/^ال.{2,}$/u.test(tok) ? tok.slice(2) : tok)) // article arabe « ال »
    .filter((tok) => !SKIPPED_TOKENS.has(tok))
    .join(" ");
}

/**
 * @param {Record<string, [string, string][]>} data  gouvernorat → [[nom français, nom arabe], ...]
 * @param {Record<string, string[]>} aliases        nom français → variantes d'écriture courantes
 * @param {Record<string, Record<string, [number, number]>>} coords  gouvernorat → nom français → [latitude, longitude]
 */
export function createPlaceIndex(data, aliases = {}, coords = {}) {
  const byGov = new Map(); // gouvernorat → Map(clé → { fr, ar, lat, lon })
  for (const [gov, list] of Object.entries(data)) {
    const keys = new Map();
    const seen = new Set();
    for (const [fr, ar] of list) {
      if (seen.has(fr)) throw new Error(`doublon dans ${gov} : « ${fr} » est listée deux fois`);
      seen.add(fr);
      const point = coords[gov]?.[fr];
      const entry = { fr, ar, lat: point?.[0] ?? null, lon: point?.[1] ?? null };
      for (const name of new Set([fr, ar])) {
        const key = matchKey(name);
        const existing = keys.get(key);
        if (existing) throw new Error(`doublon dans ${gov} : « ${name} » désigne deux villes (${existing.fr} et ${fr})`);
        keys.set(key, entry);
      }
    }
    for (const [fr, variants] of Object.entries(aliases)) {
      const entry = [...keys.values()].find((e) => e.fr === fr);
      if (!entry) continue;
      for (const variant of variants) {
        const key = matchKey(variant);
        const existing = keys.get(key);
        if (existing && existing !== entry) throw new Error(`alias « ${variant} » : c'est déjà le nom d'une autre ville (${existing.fr}) dans ${gov}`);
        keys.set(key, entry);
      }
    }
    byGov.set(gov, keys);
  }

  return {
    governorates: [...byGov.keys()],
    /**
     * Retrouve une ville à partir de ce que le chauffeur a tapé (français, arabe, variante). `governorates` = contexte, par ordre de priorité.
     * Sans contexte : trouvée seulement si le nom est unique dans tout le pays (jamais de deviner en cas d'ambiguïté).
     * `lat`/`lon` présents seulement quand la coordonnée est connue (géorepérage) : absents, pas `null`, pour ne rien changer
     * à la forme attendue par ce qui n'en a pas besoin.
     * @returns {{fr: string, ar: string, governorate: string, lat?: number, lon?: number} | null}
     */
    find(text, governorates) {
      const key = matchKey(text);
      if (!key) return null;
      const toResult = (entry, gov) => ({ fr: entry.fr, ar: entry.ar, governorate: gov, ...(entry.lat != null ? { lat: entry.lat, lon: entry.lon } : {}) });
      if (governorates?.length) {
        for (const gov of governorates) {
          const entry = byGov.get(gov)?.get(key);
          if (entry) return toResult(entry, gov);
        }
        return null;
      }
      const hits = [];
      for (const [gov, keys] of byGov) {
        const entry = keys.get(key);
        if (entry) hits.push(toResult(entry, gov));
      }
      return hits.length === 1 ? hits[0] : null;
    },
    /** Noms à proposer pour un gouvernorat, dans la langue de l'interface : le chef-lieu (même nom que le gouvernorat) d'abord, puis l'ordre alphabétique. */
    suggestions(governorate, lang) {
      const list = data[governorate];
      if (!list) return [];
      const index = lang === "ar" ? 1 : 0;
      const locale = lang === "ar" ? "ar" : "fr";
      const names = list.map((p) => p[index]);
      const head = list.find(([fr]) => matchKey(fr) === matchKey(governorate))?.[index]; // chef-lieu : même nom que le gouvernorat (« Manouba » pour « La Manouba »)
      return [...(head ? [head] : []), ...names.filter((n) => n !== head).sort((a, b) => a.localeCompare(b, locale))];
    },
    /** Toutes les délégations du pays, avec leur gouvernorat (pour une suggestion de saisie qui ne se limite pas à un seul gouvernorat). */
    all() {
      const out = [];
      for (const [gov, list] of Object.entries(data)) for (const [fr, ar] of list) out.push({ fr, ar, governorate: gov });
      return out.sort((a, b) => a.fr.localeCompare(b.fr, "fr"));
    },
    /** Comme all(), avec en plus les variantes d'écriture latines connues (« Om Larayes »), pour qu'une suggestion de saisie
     * les propose aussi telles quelles — pas les variantes arabes, inutiles dans un champ saisi en alphabet latin. */
    allWithAliases() {
      const base = this.all();
      const extra = [];
      for (const [fr, variants] of Object.entries(aliases)) {
        const hit = base.find((p) => p.fr === fr);
        if (!hit) continue;
        for (const variant of variants) if (!/[؀-ۿ]/.test(variant)) extra.push({ fr: variant, ar: hit.ar, governorate: hit.governorate });
      }
      return [...base, ...extra].sort((a, b) => a.fr.localeCompare(b.fr, "fr"));
    },
  };
}

export const places = createPlaceIndex(PLACES, ALIASES, COORDS);
