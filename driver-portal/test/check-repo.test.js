import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crlfProblems, cssProblems, secretProblems, i18nProblems, i18nUsages, referenceProblems, envProblems, envUsed, envDocumented, checkRepo } from "../tools/check-repo.js";

test("le dépôt réel passe tous les contrôles (fins de ligne, CSS, syntaxe, secrets, traductions, liens, variables d'environnement)", async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { problems, filesChecked } = await checkRepo(root);
  assert.deepEqual(problems, []);
  assert.ok(filesChecked > 80);
});

test("fins de ligne : un fichier en CRLF est signalé, un fichier en LF non", () => {
  const found = crlfProblems([{ path: "deploy/a.sh", content: "echo a\r\necho b\r\n" }, { path: "deploy/b.sh", content: "echo a\necho b\n" }]);
  assert.equal(found.length, 1);
  assert.match(found[0], /deploy\/a\.sh/);
});

test("CSS : accolades équilibrées, en ignorant commentaires et chaînes", () => {
  assert.deepEqual(cssProblems("a.css", "a { color: red; } @media (x) { b { margin: 0; } }"), []);
  assert.deepEqual(cssProblems("a.css", '/* } */ a::before { content: "}"; }'), [], "accolades dans un commentaire ou une chaîne ignorées");
  assert.match(cssProblems("a.css", "@media (x) { a { color: red; }")[0], /1 accolade\(s\) non fermée/);
  assert.match(cssProblems("a.css", "a { } }")[0], /en trop/);
});

test("secrets : clés AWS, Twilio, clés privées, jetons et affectations de secrets sont repérés ; exemples et valeurs factices non", () => {
  const bad = [
    "aws = AKIAABCDEFGHIJKLMNOP",
    `sid = AC${"0123456789abcdef".repeat(2)}`,
    "-----BEGIN RSA PRIVATE KEY-----",
    `token ghp_${"a1".repeat(20)}`,
    `DATA_KEY=${"ab12".repeat(16)}`,
    'ADMIN_TOKEN="Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZg"',
    `export TWILIO_AUTH_TOKEN=${"9f".repeat(16)}`,
  ];
  for (const content of bad) assert.equal(secretProblems("x.md", content).length, 1, content);
  const fine = [
    "ADMIN_TOKEN=CHANGE_ME",
    "DATA_KEY=",
    "DATA_KEY_PREVIOUS=\nOTP_SECRET=CHANGE_ME",
    'ADMIN_TOKEN="choisis-un-long-secret" npm start',
    "DATA_KEY=<nouvelle>   DATA_KEY_PREVIOUS=<ancienne>",
    "const adminToken = process.env.ADMIN_TOKEN;",
    "AC123",
  ];
  for (const content of fine) assert.deepEqual(secretProblems("x.md", content), [], content);
  assert.deepEqual(secretProblems("package-lock.json", "AKIAABCDEFGHIJKLMNOP"), [], "le fichier de verrouillage n'est pas analysé");
  assert.ok(!secretProblems("x.md", `DATA_KEY=${"ab12".repeat(16)}`)[0].includes("ab12"), "le message ne recopie jamais le secret");
});

test("traductions : clé absente d'une langue, clé vide, clé utilisée mais non définie", () => {
  const dict = { ar: { a: "أ", b: "ب", only_ar: "x", empty: "" }, fr: { a: "A", b: "B", only_fr: "y", empty: "z" } };
  const problems = i18nProblems(dict, [{ file: "p.html", key: "a" }, { file: "p.html", key: "missing" }, { file: "q.js", key: "only_ar" }]);
  assert.ok(problems.some((p) => p.includes("« only_ar » existe en arabe mais pas en français")));
  assert.ok(problems.some((p) => p.includes("« only_fr » existe en français mais pas en arabe")));
  assert.ok(problems.some((p) => p.includes("« empty » est vide en ar")));
  assert.ok(problems.some((p) => p.includes("p.html") && p.includes("« missing »")));
  assert.ok(problems.some((p) => p.includes("q.js") && p.includes("« only_ar »")), "définie dans une seule langue = non définie");
  assert.ok(!problems.some((p) => p.includes("« a »")));
});

test("traductions : clés lues dans les pages (data-i18n*, data-title) et dans les appels littéraux t(\"clé\")", () => {
  const html = '<html data-title="title_x"><h1 data-i18n="a_b"></h1><img data-i18n-alt="alt_k"><input data-i18n-ph="ph_k" data-i18n-label="lab_k">';
  assert.deepEqual(i18nUsages("p.html", html).map((u) => u.key).sort(), ["a_b", "alt_k", "lab_k", "ph_k", "title_x"]);
  const js = 'x.textContent = t("st_title"); y = t(`e_${k}`); z = t(name); fmt.t("x_y"); const q = t( \'ok_key\' );';
  assert.deepEqual(i18nUsages("p.js", js).map((u) => u.key), ["st_title", "ok_key"], "ni clés dynamiques, ni méthodes d'autres objets");
});

test("références : fichier absent de public/ signalé ; routes, API, URL externes et ancres ignorées", () => {
  const exists = (p) => ["/styles.css", "/img/og.jpg"].includes(p);
  const html = '<link href="/styles.css"><script src="/missing.js"></script><a href="/register">r</a><a href="/api/x">a</a><a href="https://x.tn/a.js">e</a><a href="//cdn/x.js">c</a><a href="#top">t</a><img src="/img/gone.png"><meta content="%PUBLIC_URL%/img/og.jpg"><meta content="%PUBLIC_URL%/img/nope.jpg"><link href="%PUBLIC_URL%/privacy">';
  const problems = referenceProblems("p.html", html, exists);
  assert.deepEqual(problems.map((p) => p.match(/« (.+?) »/)[1]).sort(), ["/img/gone.png", "/img/nope.jpg", "/missing.js"]);
  assert.deepEqual(referenceProblems("a.js", 'import { x } from "/common.js"; import y from "./local.js"; import z from "/ghost.js";', (p) => p === "/common.js").map((p) => p.match(/« (.+?) »/)[1]), ["/ghost.js"]);
});

test("variables d'environnement : lues par le code mais non documentées = signalées", () => {
  const used = new Set(envUsed("const a = process.env.PORT; const b = env.ADMIN_TOKEN; const c = process.env.NEW_THING || 1; if (process.env.x) {} env.lower; const d = env.AB;"));
  assert.deepEqual([...used].sort(), ["ADMIN_TOKEN", "NEW_THING", "PORT"]);
  const documented = new Set(envDocumented("# commentaire\nPORT=4100\n# SLOT_DAYS=7\nADMIN_TOKEN=CHANGE_ME\n  # indenté=non\n"));
  assert.deepEqual([...documented].sort(), ["ADMIN_TOKEN", "PORT", "SLOT_DAYS"]);
  assert.match(envProblems(used, documented)[0], /NEW_THING/);
  assert.deepEqual(envProblems(used, new Set([...documented, "NEW_THING"])), []);
  assert.deepEqual(envProblems(new Set(["CI"]), new Set()), [], "liste d'exceptions");
});
