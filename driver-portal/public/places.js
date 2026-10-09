// Villes (délégations et chefs-lieux) de chaque gouvernorat, en arabe et en français : suggestions de saisie et fusion des orthographes.
// Module sans accès au navigateur : le formulaire s'en sert pour proposer des villes, le serveur pour reconnaître « الرديف », « Redeyef »
// et « redeyef » comme la même ville. La saisie libre reste toujours permise : une ville inconnue n'est jamais refusée.
import { PLACES, ALIASES } from "./places-data.js";

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
 */
export function createPlaceIndex(data, aliases = {}) {
  const byGov = new Map(); // gouvernorat → Map(clé → { fr, ar })
  for (const [gov, list] of Object.entries(data)) {
    const keys = new Map();
    const seen = new Set();
    for (const [fr, ar] of list) {
      if (seen.has(fr)) throw new Error(`doublon dans ${gov} : « ${fr} » est listée deux fois`);
      seen.add(fr);
      const entry = { fr, ar };
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
     * @returns {{fr: string, ar: string, governorate: string} | null}
     */
    find(text, governorates) {
      const key = matchKey(text);
      if (!key) return null;
      if (governorates?.length) {
        for (const gov of governorates) {
          const entry = byGov.get(gov)?.get(key);
          if (entry) return { fr: entry.fr, ar: entry.ar, governorate: gov };
        }
        return null;
      }
      const hits = [];
      for (const [gov, keys] of byGov) {
        const entry = keys.get(key);
        if (entry) hits.push({ fr: entry.fr, ar: entry.ar, governorate: gov });
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
  };
}

export const places = createPlaceIndex(PLACES, ALIASES);
