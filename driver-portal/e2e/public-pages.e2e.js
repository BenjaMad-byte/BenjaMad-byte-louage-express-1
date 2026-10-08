import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, launchBrowser, newContext, watchErrors, axeViolations, hasHorizontalOverflow, T } from "./_harness.js";

let env, browser, skip;
before(async () => {
  env = await startApp();
  ({ browser, skip } = await launchBrowser());
});
after(async () => {
  await browser?.close();
  env.stop();
});

const PAGES = ["/", "/register", "/interview", "/status", "/privacy", "/terms", "/legal", "/une-page-qui-nexiste-pas"];
const COMBOS = [["fr", "light"], ["fr", "dark"], ["ar", "light"], ["ar", "dark"]];

for (const [lang, colorScheme] of COMBOS) {
  test(`pages publiques en ${lang === "fr" ? "français" : "arabe"}, thème ${colorScheme === "light" ? "clair" : "sombre"} : aucune erreur de sécurité, pas de débordement, accessibilité (axe) sans faille sérieuse`, { timeout: 120_000 }, async (t) => {
    if (skip) return t.skip(skip);
    const problems = [];
    for (const viewport of [{ width: 375, height: 812 }, { width: 1280, height: 800 }]) {
      const context = await newContext(browser, { lang, colorScheme, viewport });
      for (const p of PAGES) {
        const page = await context.newPage();
        const errors = watchErrors(page);
        const res = await page.goto(env.base + p, { waitUntil: "networkidle" });
        const where = `${p} @${viewport.width}`;
        if (res.status() !== (p.includes("nexiste") ? 404 : 200)) problems.push(`${where} : statut ${res.status()}`);
        await page.locator("main").first().waitFor();
        if (await hasHorizontalOverflow(page)) problems.push(`${where} : défilement horizontal`);
        if (errors.length) problems.push(`${where} : ${errors.join(" | ")}`);
        const violations = await axeViolations(page);
        for (const v of violations) problems.push(`${where} : accessibilité ${v.impact} « ${v.id} » (${v.nodes.join(", ")})`);
        await page.close();
      }
      await context.close();
    }
    assert.deepEqual(problems, []);
  });
}

test("accueil : les 5 scènes, les 24 gouvernorats, le bouton d'inscription mène au formulaire", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "fr", viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(env.base + "/");
  assert.equal((await page.locator("h1").first().textContent()).trim(), T.fr.home_title);
  for (const sel of [".hero-cine", ".scene", ".route", ".dawn", ".trust"]) assert.equal(await page.locator(sel).count(), 1, sel);
  assert.equal(await page.locator(".govs li").count(), 24);
  assert.equal(await page.locator(".stops .stop").count(), 10);
  assert.equal(await page.locator(".stops .stop svg use").count(), 10, "dix emblèmes de villes");
  assert.equal(await page.locator("body").evaluate((b) => /propri[eé]taire/i.test(b.innerText)), false, "le site est réservé aux chauffeurs");
  await page.locator(".hero-cine .btn", { hasText: T.fr.home_cta }).click();
  await page.waitForURL("**/register");
  await context.close();
});

test("navigation : chaque lien du menu ouvre la bonne page ; la page 404 ramène à l'accueil", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "fr", viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(env.base + "/");
  for (const [key, url] of [["nav_register", "/register"], ["nav_interview", "/interview"], ["nav_status", "/status"], ["nav_home", "/"]]) {
    await page.locator("nav").getByRole("link", { name: T.fr[key] }).click();
    await page.waitForURL(`**${url}`);
    assert.equal(await page.locator("nav a[aria-current=page]").textContent(), T.fr[key]);
  }
  const res = await page.goto(env.base + "/introuvable");
  assert.equal(res.status(), 404);
  assert.equal((await page.locator("h1").textContent()).trim(), T.fr.nf_title);
  await page.getByRole("link", { name: T.fr.nf_home }).click();
  await page.waitForURL(env.base + "/");
  await context.close();
});

test("aperçu de lien : balises de partage lisibles SANS JavaScript, image de partage accessible", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(env.base + "/");
  const meta = (sel) => page.locator(sel).getAttribute("content");
  assert.match(await meta('meta[property="og:image"]'), /^https:\/\/inscription\.exemple\.tn\/img\/og-share\.jpg$/);
  assert.match(await meta('meta[property="og:description"]'), /[؀-ۿ].*chauffeurs de louage/);
  assert.equal(await page.locator("noscript").count() > 0, true);
  assert.equal((await page.request.get(env.base + "/img/og-share.jpg")).status(), 200);
  await context.close();
});

test("accueil : les boutons du hero ne sont jamais recouverts (mobile et bureau, français et arabe)", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const problems = [];
  for (const lang of ["fr", "ar"]) {
    for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
      const context = await newContext(browser, { lang, viewport });
      const page = await context.newPage();
      await page.goto(env.base + "/");
      await page.locator(".hero-cine .btn").first().waitFor();
      for (const link of await page.locator(".hero-cine .btn").all()) {
        await link.scrollIntoViewIfNeeded();
        const covered = await link.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !(top === el || el.contains(top));
        });
        if (covered) problems.push(`${lang} @${viewport.width} : « ${(await link.textContent()).trim()} » est recouvert`);
      }
      await context.close();
    }
  }
  assert.deepEqual(problems, []);
});
