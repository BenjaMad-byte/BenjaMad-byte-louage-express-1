// Remplissage des textes légaux : pur (aucun accès au navigateur), donc testable.

/** Valeurs sans lesquelles les textes sont incomplets (les mêmes que celles exigées en production par legal.js). */
export const REQUIRED_VALUES = ["entity", "address", "email", "host", "retention_rejected", "retention_approved", "backup_days"];

/**
 * Découpe un texte contenant des {marqueurs} : [{ text }] pour le texte fixe, [{ text, value: true }] pour une valeur insérée, [{ todo: nom }] pour une valeur absente.
 * Un marqueur inconnu n'est jamais deviné : il ressort en « à compléter », pas en {nom} brut.
 */
export function segments(template, values) {
  const out = [];
  let last = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    if (m.index > last) out.push({ text: template.slice(last, m.index) });
    const value = values[m[1]];
    out.push(value === null || value === undefined || value === "" ? { todo: m[1] } : { text: String(value), value: true });
    last = m.index + m[0].length;
  }
  if (last < template.length) out.push({ text: template.slice(last) });
  return out;
}

/** Les blocs `{ if: "phone" }` ne s'affichent que si la valeur est renseignée. */
export const visibleBlocks = (blocks, values) => blocks.filter((b) => !b.if || values[b.if]);

export const hasMissingValues = (values) => REQUIRED_VALUES.some((k) => values[k] === null || values[k] === undefined || values[k] === "");
