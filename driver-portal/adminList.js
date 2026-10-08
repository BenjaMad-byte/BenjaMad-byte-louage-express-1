// Liste des dossiers de la console admin : filtres, tri, pagination, compteurs.
// Aucune valeur du client n'est jamais concaténée dans le SQL : les valeurs passent par des listes blanches ou des paramètres liés.
import { GOVERNORATES, LINE_TYPES, clean } from "./validate.js";

export const STATUSES = ["pending", "interview", "approved", "rejected"];
export const KYC_FILTERS = ["queued", "processing", "verified", "review", "skipped", "error", "none"];
export const PAGE_SIZE = { default: 50, max: 100 };

const SORTS = {
  created_desc: "a.created_at DESC, a.id DESC",
  created_asc: "a.created_at ASC, a.id ASC",
  name: "a.full_name COLLATE NOCASE ASC, a.id ASC",
  governorate: "a.governorate COLLATE NOCASE ASC, a.created_at DESC, a.id DESC",
};

/**
 * Valide la requête. Retourne { filters } ou { error: "<champ>" }.
 * Une valeur vide = pas de filtre ; une valeur inconnue, répétée ou de forme inattendue est refusée (pas ignorée en silence).
 */
export function parseListQuery(query) {
  const read = (name) => {
    const v = query[name];
    if (v === undefined || v === "") return { value: undefined };
    if (typeof v !== "string") return { bad: true };
    return { value: v };
  };
  const oneOf = (name, allowed) => {
    const r = read(name);
    if (r.bad || (r.value !== undefined && !allowed.includes(r.value))) return { error: name };
    return { value: r.value };
  };
  const integer = (name, fallback) => {
    const r = read(name);
    if (r.bad || (r.value !== undefined && !/^[1-9]\d{0,6}$/.test(r.value))) return { error: name };
    return { value: r.value === undefined ? fallback : Number(r.value) };
  };

  const filters = {};
  for (const [name, allowed] of [["status", STATUSES], ["governorate", GOVERNORATES], ["line_type", LINE_TYPES], ["kyc", KYC_FILTERS]]) {
    const r = oneOf(name, allowed);
    if (r.error) return { error: r.error };
    filters[name] = r.value;
  }
  const sort = oneOf("sort", Object.keys(SORTS));
  if (sort.error) return { error: "sort" };
  filters.sort = sort.value ?? "created_desc";
  const page = integer("page", 1);
  const size = integer("page_size", PAGE_SIZE.default);
  if (page.error || size.error) return { error: page.error ?? size.error };
  filters.page = page.value;
  filters.pageSize = Math.min(size.value, PAGE_SIZE.max);
  const q = read("q");
  if (q.bad) return { error: "q" };
  filters.q = clean(q.value ?? "", 40);
  return { filters };
}

/** WHERE commun à la liste et aux compteurs ; `skip` retire un filtre (un compteur ne tient pas compte de son propre filtre). */
function buildWhere(f, skip) {
  const parts = [];
  const params = [];
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, "\\$&")}%`;
    parts.push("(a.full_name LIKE ? ESCAPE '\\' OR a.phone LIKE ? ESCAPE '\\' OR a.ref LIKE ? ESCAPE '\\' OR a.cin LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  if (f.status && skip !== "status") { parts.push("a.status = ?"); params.push(f.status); }
  if (f.governorate) { parts.push("a.governorate = ?"); params.push(f.governorate); }
  if (f.line_type) { parts.push("a.line_type = ?"); params.push(f.line_type); }
  if (f.kyc && skip !== "kyc") {
    if (f.kyc === "none") parts.push("k.status IS NULL");
    else { parts.push("k.status = ?"); params.push(f.kyc); }
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

const FROM = "FROM applications a LEFT JOIN kyc_checks k ON k.application_id = a.id";

function countBy(db, expr, f, skip) {
  const { sql, params } = buildWhere(f, skip);
  const rows = db.prepare(`SELECT ${expr} AS key, COUNT(*) AS n ${FROM} ${sql} GROUP BY key`).all(...params);
  return Object.fromEntries(rows.map((r) => [r.key, r.n]));
}

export function queryApplications(db, f) {
  const { sql, params } = buildWhere(f);
  const total = db.prepare(`SELECT COUNT(*) AS n ${FROM} ${sql}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / f.pageSize));
  const applications = db
    .prepare(
      `SELECT a.ref, a.full_name, a.phone, a.plate, a.governorate, a.station, a.route, a.line_type, a.line_from, a.line_to_gov, a.line_via,
              a.pickup_en_route, a.leaves_partial, a.status, a.created_at,
              (SELECT COUNT(*) FROM files f WHERE f.application_id = a.id) AS files,
              k.status AS kyc_status
         ${FROM} ${sql}
        ORDER BY ${SORTS[f.sort]} LIMIT ? OFFSET ?`
    )
    .all(...params, f.pageSize, (f.page - 1) * f.pageSize);
  return {
    applications,
    total,
    page: f.page,
    pages,
    counts: {
      status: countBy(db, "a.status", f, "status"),
      kyc: countBy(db, "COALESCE(k.status, 'none')", f, "kyc"),
    },
  };
}
