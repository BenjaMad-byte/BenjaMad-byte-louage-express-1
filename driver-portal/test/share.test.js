import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-share-"));
process.env.DATA_DIR = dataDir;

const PAGES = ["/", "/register", "/interview", "/status", "/privacy", "/terms", "/legal"];
const BASE = "https://inscription.exemple.tn";
const servers = [];
let createApp, db;
const launch = (opts = {}) => {
  const server = createApp({ adminToken: "share-test-token-123", rateLimits: false, forceHttps: false, dataKey: null, sms: { name: "stub", send: async () => {} }, ...opts }).listen(0);
  servers.push(server);
  return { port: server.address().port, base: `http://127.0.0.1:${server.address().port}` };
};

before(async () => {
  ({ createApp } = await import("../server.js"));
  ({ db } = await import("../db.js"));
});
after(() => {
  servers.forEach((s) => s.close());
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const text = async (url, headers = {}) => {
  const res = await fetch(url, { headers });
  return { res, body: await res.text() };
};
/** Requête brute : permet de forger l'en-tête Host. */
const raw = (port, urlPath, headers) =>
  new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });

test("chaque page publique porte ses balises de partage, avec des adresses absolues (aperçu WhatsApp)", async () => {
  const { base } = launch({ publicUrl: BASE });
  for (const p of PAGES) {
    const { res, body } = await text(base + p);
    assert.equal(res.status, 200, p);
    assert.ok(!body.includes("%PUBLIC_URL%"), `${p} : placeholder non remplacé`);
    for (const needle of [
      'name="description"', 'property="og:title"', 'property="og:description"', 'property="og:type"', 'property="og:site_name"',
      `property="og:url" content="${BASE}${p === "/" ? "/" : p}"`, `property="og:image" content="${BASE}/img/og-share.jpg"`,
      'property="og:image:width" content="1200"', 'property="og:image:height" content="630"', 'property="og:image:alt"',
      'property="og:locale" content="ar_TN"', 'name="twitter:card" content="summary_large_image"',
      `rel="canonical" href="${BASE}${p === "/" ? "/" : p}"`, 'name="theme-color"', 'rel="icon"', 'rel="apple-touch-icon"', 'rel="manifest"', "<noscript",
    ]) {
      assert.ok(body.includes(needle), `${p} : « ${needle} » manquant`);
    }
    assert.equal((body.match(/property="og:image"/g) ?? []).length, 1, `${p} : une seule image de partage`);
  }
});

test("le texte de partage est lisible sans JavaScript, en arabe et en français", async () => {
  const { base } = launch({ publicUrl: BASE });
  const { body } = await text(base + "/");
  const description = body.match(/property="og:description" content="([^"]+)"/)[1];
  assert.match(description, /[؀-ۿ]/, "arabe présent");
  assert.match(description, /chauffeurs de louage/i, "français présent");
  assert.ok(description.length <= 160, `description trop longue pour un aperçu (${description.length})`);
  const title = body.match(/property="og:title" content="([^"]+)"/)[1];
  assert.ok(title.length <= 70, `titre trop long (${title.length})`);
  assert.match(body, /<noscript[\s\S]*JavaScript[\s\S]*<\/noscript>/i);
  assert.match(body, /<noscript[\s\S]*[؀-ۿ][\s\S]*<\/noscript>/);
});

test("sans PUBLIC_URL (développement), l'adresse vient de la requête ; un en-tête Host piégé ne s'injecte jamais dans la page", async () => {
  const { port, base } = launch();
  const ok = await text(base + "/");
  assert.ok(ok.body.includes(`property="og:image" content="${base}/img/og-share.jpg"`));

  const evil = await raw(port, "/", { Host: 'evil.example"><script>alert(1)</script>' });
  assert.ok(!evil.body.includes("<script>alert(1)"), "aucune injection");
  assert.ok(!evil.body.includes("evil.example"), "l'hôte invalide est ignoré");
  assert.ok(evil.body.includes("og:image"), "la page reste servie");
});

test("pages sans script ni style en ligne (la CSP stricte reste valable)", () => {
  for (const f of ["index", "register", "interview", "status", "404"]) {
    const html = fs.readFileSync(path.join(publicDir, `${f}.html`), "utf8");
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${f}.html : script en ligne`);
    assert.ok(!/\sstyle=/i.test(html), `${f}.html : attribut style`);
    assert.ok(!/<style[\s>]/i.test(html), `${f}.html : balise style`);
  }
});

test("robots.txt et sitemap.xml : adresses absolues, ni l'admin ni l'API", async () => {
  const { base } = launch({ publicUrl: BASE });
  const robots = await text(base + "/robots.txt");
  assert.equal(robots.res.status, 200);
  assert.match(robots.res.headers.get("content-type"), /text\/plain/);
  assert.ok(robots.body.includes(`Sitemap: ${BASE}/sitemap.xml`));
  assert.ok(robots.body.includes("Disallow: /api/"));

  const map = await text(base + "/sitemap.xml");
  assert.equal(map.res.status, 200);
  assert.match(map.res.headers.get("content-type"), /xml/);
  for (const p of PAGES) assert.ok(map.body.includes(`<loc>${BASE}${p === "/" ? "/" : p}</loc>`), p);
  assert.ok(!map.body.includes("admin") && !map.body.includes("/api"));
});

test("page 404 : vraie page du site en arabe et français, statut 404, jamais indexée ; l'API garde sa réponse JSON", async () => {
  const { base } = launch({ publicUrl: BASE });
  const html = await text(base + "/cette-page-nexiste-pas", { Accept: "text/html" });
  assert.equal(html.res.status, 404);
  assert.match(html.res.headers.get("content-type"), /text\/html/);
  assert.match(html.body, /name="robots" content="noindex/);
  assert.ok(html.body.includes('data-i18n="nf_title"') && html.body.includes('href="/"') && html.body.includes('href="/register"'));
  assert.ok(!html.body.includes("%PUBLIC_URL%"));

  const api = await text(base + "/api/inconnu");
  assert.equal(api.res.status, 404);
  assert.deepEqual(JSON.parse(api.body), { error: "not_found" });

  const json = await text(base + "/ailleurs", { Accept: "application/json" });
  assert.equal(json.res.status, 404);
  assert.deepEqual(JSON.parse(json.body), { error: "not_found" });

  const post = await fetch(base + "/ailleurs", { method: "POST" });
  assert.equal(post.status, 404);
});

test("textes de la page 404 traduits dans les deux langues", async () => {
  const { DICT } = await import("../public/i18n.js");
  for (const lang of ["ar", "fr"]) for (const k of ["nf_title", "nf_text", "nf_home", "nf_register"]) assert.ok(DICT[lang][k], `${lang}.${k}`);
});

/** Dimensions d'un JPEG en lisant le marqueur SOF. */
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error("SOF introuvable");
}

test("image de partage : JPEG 1200×630 léger ; icônes et manifeste présents", async () => {
  const { base } = launch({ publicUrl: BASE });
  const og = await fetch(base + "/img/og-share.jpg");
  assert.equal(og.status, 200);
  assert.equal(og.headers.get("content-type"), "image/jpeg");
  const ogBuf = Buffer.from(await og.arrayBuffer());
  assert.deepEqual(jpegSize(ogBuf), { w: 1200, h: 630 });
  assert.ok(ogBuf.length < 300 * 1024, `image de partage trop lourde (${ogBuf.length} octets) : WhatsApp l'ignore souvent au-delà de 300 Ko`);

  const svg = await fetch(base + "/favicon.svg");
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get("content-type"), /svg/);
  assert.ok(!(await svg.text()).includes("<script"));

  for (const [file, size] of [["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]]) {
    const r = await fetch(`${base}/${file}`);
    assert.equal(r.status, 200, file);
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal(b.subarray(1, 4).toString(), "PNG", file);
    assert.equal(b.readUInt32BE(16), size, `${file} largeur`);
    assert.equal(b.readUInt32BE(20), size, `${file} hauteur`);
  }

  const mf = await fetch(base + "/site.webmanifest");
  assert.equal(mf.status, 200);
  const manifest = await mf.json();
  assert.ok(manifest.name && manifest.short_name && manifest.start_url === "/" && manifest.theme_color);
  assert.deepEqual(manifest.icons.map((i) => i.sizes).sort(), ["192x192", "512x512"]);
  assert.equal(manifest.lang, "ar");
  assert.equal(manifest.dir, "rtl");
});
