// Contrôles d'hygiène du dépôt, rapides et sans dépendance : tout ce qui casse « en silence » et que les tests ne voient pas.
//
//   npm run check
//
// Lancé par l'intégration continue (.github/workflows/ci.yml) et par `npm run ci`. Code de sortie 1 si un contrôle échoue.
// Chaque contrôle est une fonction pure (testée dans test/check-repo.test.js) ; checkRepo() les applique aux vrais fichiers.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEXT_EXT = new Set([".js", ".html", ".css", ".md", ".sh", ".json", ".example", ".svg", ".webmanifest", ".py", ".conf", ".service", ".txt", ".yml", ".yaml"]);
const SKIP_DIRS = new Set(["node_modules", "data", ".git"]);
const isText = (file) => TEXT_EXT.has(path.extname(file)) || ["Caddyfile", ".gitignore", ".gitattributes", ".editorconfig"].includes(path.basename(file));

/** Routes servies par l'application (pas des fichiers de public/) : un lien vers elles n'est pas « cassé ». */
const ROUTES = new Set(["/", "/register", "/interview", "/status", "/privacy", "/terms", "/legal", "/admin", "/404", "/healthz", "/robots.txt", "/sitemap.xml"]);
/** Variables lues par le code mais volontairement absentes des fichiers d'exemple (réglages de test ou internes). */
const ENV_ALLOWLIST = new Set(["PATH", "HOME", "E2E_CHANNEL", "E2E_REQUIRE_BROWSER", "CI"]);

// ---------------------------------------------------------------- contrôles purs
/** Fins de ligne Windows : un script shell ou un fichier systemd en CRLF casse sur un serveur Linux. */
export function crlfProblems(files) {
  return files.filter((f) => f.content.includes("\r\n")).map((f) => `${f.path} : fins de ligne Windows (CRLF), le dépôt est en LF (voir .gitattributes)`);
}

/** Accolades CSS équilibrées (hors commentaires et chaînes) : une accolade oubliée casse toute la suite de la feuille. */
export function cssProblems(file, css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  let depth = 0;
  for (const ch of clean) {
    depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    if (depth < 0) return [`${file} : accolade fermante en trop`];
  }
  return depth === 0 ? [] : [`${file} : ${depth} accolade(s) non fermée(s)`];
}

const SECRET_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, "clé d'accès AWS"],
  [/\bAC[0-9a-f]{32}\b/, "identifiant de compte Twilio"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "clé privée"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "jeton GitHub"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "jeton Slack"],
  [/\bsk_live_[A-Za-z0-9]{16,}/, "clé secrète de paiement"],
  [/\b(?:DATA_KEY(?:_PREVIOUS)?|ADMIN_TOKEN|OTP_SECRET|KYC_SERVICE_KEY|TWILIO_AUTH_TOKEN|AWS_SECRET_ACCESS_KEY)[ \t]*=[ \t]*["']?(?!CHANGE_ME)(?=[A-Za-z+/_=-]*\d)[A-Za-z0-9+/_=-]{16,}/, "secret affecté dans un fichier"], // une vraie clé contient des chiffres : « choisis-un-long-secret » (exemple de doc) n'en est pas une
];
/** Secrets collés par erreur dans un fichier. Les valeurs d'exemple (CHANGE_ME, <...>) et les fichiers de test ne comptent pas. */
export function secretProblems(file, content) {
  if (/(^|[\\/])package-lock\.json$/.test(file)) return [];
  return SECRET_PATTERNS.filter(([re]) => re.test(content)).map(([, label]) => `${file} : ressemble à un secret (${label}) : le retirer et le changer s'il était réel`);
}

/** Les clés de traduction existent des deux côtés (arabe ET français), et toutes celles utilisées par les pages et les scripts sont définies. */
export function i18nProblems(dict, usages) {
  const problems = [];
  const ar = new Set(Object.keys(dict.ar));
  const fr = new Set(Object.keys(dict.fr));
  for (const k of ar) if (!fr.has(k)) problems.push(`i18n : « ${k} » existe en arabe mais pas en français`);
  for (const k of fr) if (!ar.has(k)) problems.push(`i18n : « ${k} » existe en français mais pas en arabe`);
  for (const { file, key } of usages) if (!ar.has(key) || !fr.has(key)) problems.push(`${file} : clé de traduction « ${key} » non définie dans les deux langues`);
  for (const lang of ["ar", "fr"]) for (const [k, v] of Object.entries(dict[lang])) if (typeof v === "string" && v.trim() === "") problems.push(`i18n : « ${k} » est vide en ${lang}`);
  return problems;
}

/** Clés de traduction citées dans une page HTML (data-i18n*, data-title) ou, pour un script, dans des appels littéraux t("clé"). */
export function i18nUsages(file, content) {
  const keys = [];
  if (file.endsWith(".html")) for (const m of content.matchAll(/data-(?:i18n(?:-alt|-label|-ph)?|title)="([a-z0-9_]+)"/g)) keys.push(m[1]);
  else for (const m of content.matchAll(/(?<![\w.$])t\(\s*["']([a-z0-9_]+)["']\s*\)/g)) keys.push(m[1]);
  return keys.map((key) => ({ file, key }));
}

/** Liens, images, scripts et imports qui pointent vers un fichier de public/ qui n'existe pas. `exists(p)` : p est-il un fichier de public/ ? */
export function referenceProblems(file, content, exists) {
  const problems = [];
  const check = (ref, kind) => {
    const p = ref.split(/[?#]/)[0];
    if (!p.startsWith("/") || p.startsWith("//") || p.startsWith("/api/") || ROUTES.has(p)) return;
    if (!exists(p)) problems.push(`${file} : ${kind} vers « ${p} » introuvable dans public/`);
  };
  if (file.endsWith(".html")) {
    for (const m of content.matchAll(/\b(?:href|src)="([^"]+)"/g)) check(m[1].replace("%PUBLIC_URL%", ""), "lien");
    for (const m of content.matchAll(/\bcontent="%PUBLIC_URL%(\/[^"]*)"/g)) check(m[1], "image de partage");
  } else if (file.endsWith(".js")) {
    for (const m of content.matchAll(/\bfrom\s+"(\/[^"]+)"/g)) check(m[1], "import");
  }
  return problems;
}

/** Variables d'environnement lues par le code mais décrites dans aucun fichier d'exemple : un déploiement les oublierait. */
export function envProblems(used, documented, allow = ENV_ALLOWLIST) {
  return [...used].filter((v) => !documented.has(v) && !allow.has(v)).sort().map((v) => `variable d'environnement ${v} lue par le code mais absente des fichiers deploy/*.env.example`);
}
export const envUsed = (content) => [...content.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]{2,})/g)].map((m) => m[1]);
export const envDocumented = (content) => [...content.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);

// ---------------------------------------------------------------- application aux vrais fichiers
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export async function checkRepo(root) {
  const rel = (f) => path.relative(root, f).split(path.sep).join("/");
  const all = walk(root).filter(isText).map((f) => ({ abs: f, path: rel(f), content: fs.readFileSync(f, "utf8") }));
  const problems = [...crlfProblems(all)];

  for (const f of all.filter((x) => x.path.endsWith(".css"))) problems.push(...cssProblems(f.path, f.content));
  for (const f of all.filter((x) => !x.path.startsWith("test/") && !x.path.startsWith("e2e/") && !x.path.startsWith("tools/check-repo"))) problems.push(...secretProblems(f.path, f.content));

  // Syntaxe : les scripts shell (bash -n) et les modules JavaScript (node --check) qui ne sont pas couverts par un import dans les tests.
  const bash = spawnSync("bash", ["--version"], { encoding: "utf8" });
  for (const f of all.filter((x) => x.path.endsWith(".sh"))) {
    if (bash.status !== 0) break;
    const r = spawnSync("bash", ["-n", f.abs], { encoding: "utf8" });
    if (r.status !== 0) problems.push(`${f.path} : erreur de syntaxe shell : ${r.stderr.trim().split("\n")[0]}`);
  }
  for (const f of all.filter((x) => x.path.endsWith(".js") && !x.path.startsWith("backend/"))) {
    const r = spawnSync(process.execPath, ["--check", f.abs], { encoding: "utf8" });
    if (r.status !== 0) problems.push(`${f.path} : erreur de syntaxe JavaScript : ${r.stderr.split("\n").find((l) => /Error/.test(l)) ?? "voir node --check"}`);
  }

  // Traductions et références des pages.
  const publicDir = path.join(root, "public");
  const { DICT } = await import(pathToFileURL(path.join(publicDir, "i18n.js")).href);
  const pub = all.filter((x) => x.path.startsWith("public/"));
  const usages = pub.filter((x) => (x.path.endsWith(".html") || x.path.endsWith(".js")) && x.path !== "public/i18n.js" && x.path !== "public/legal-text.js")
    .filter((x) => x.path !== "public/admin.html" && x.path !== "public/admin.js" && x.path !== "public/admin-accounts.js") // console d'administration : français seulement, hors i18n
    .flatMap((x) => i18nUsages(x.path, x.content));
  problems.push(...i18nProblems(DICT, usages));
  const exists = (p) => fs.existsSync(path.join(publicDir, p));
  for (const f of pub.filter((x) => x.path.endsWith(".html") || x.path.endsWith(".js"))) problems.push(...referenceProblems(f.path, f.content, exists));

  // Variables d'environnement.
  const code = all.filter((x) => x.path.endsWith(".js") && !x.path.startsWith("public/") && !x.path.startsWith("test/") && !x.path.startsWith("e2e/") && !x.path.startsWith("backend/"));
  const examples = all.filter((x) => /^deploy\/[\w-]+\.env\.example$/.test(x.path));
  const used = new Set(code.flatMap((x) => envUsed(x.content)));
  const documented = new Set(examples.flatMap((x) => envDocumented(x.content)));
  problems.push(...envProblems(used, documented));

  return { problems, filesChecked: all.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Sans argument : le site d'inscription (le dossier qui contient tools/). Avec un argument : un autre paquet, ex. node tools/check-repo.js ../driver-app
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { problems, filesChecked } = await checkRepo(root);
  if (problems.length) {
    console.error(`✖ ${problems.length} problème(s) :\n - ${problems.join("\n - ")}`);
    process.exit(1);
  }
  console.log(`✔ ${filesChecked} fichiers contrôlés : fins de ligne, CSS, syntaxe, secrets, traductions, liens, variables d'environnement.`);
}
