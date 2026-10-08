import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, launchBrowser, newContext, watchErrors, axeViolations } from "./_harness.js";
import { LEGAL_ENV } from "../test/legal-fixture.js";

let complete, draft, browser, skip;
before(async () => {
  complete = await startApp({ legalEnv: { ...LEGAL_ENV, SMS_PROVIDER: "twilio", LEGAL_PHONE: "+216 70 000 000" } });
  draft = await startApp(); // aucune information d'éditeur : état de développement
  ({ browser, skip } = await launchBrowser());
});
after(async () => {
  await browser?.close();
  complete.stop();
  draft.stop();
});

test("confidentialité en français : valeurs de l'éditeur, durées, prestataire SMS, aucun marqueur brut ni avertissement", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "fr", viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(complete.base + "/privacy");
  await page.locator("#legal-body h2").first().waitFor();
  const body = await page.locator("main").innerText();
  assert.equal((await page.locator("h1").textContent()).trim(), "Politique de confidentialité");
  for (const expected of [LEGAL_ENV.LEGAL_ENTITY, LEGAL_ENV.LEGAL_ADDRESS, LEGAL_ENV.LEGAL_EMAIL, LEGAL_ENV.LEGAL_HOST, "Twilio (États-Unis)", "dossier refusé : 6 mois après la décision", "12 mois après la fin de la collaboration", "14 jours au plus", "7 octobre 2026"]) {
    assert.ok(body.includes(expected), `texte attendu : ${expected}`);
  }
  assert.ok(!/[{}]/.test(body), "aucun {marqueur} affiché");
  assert.equal(await page.locator("mark.todo").count(), 0);
  assert.ok((await page.locator("#legal-body bdi").count()) >= 5, "valeurs insérées isolées pour le sens d'écriture");
  assert.equal(await page.locator("#legal-draft").isHidden(), true, "pas d'avertissement quand tout est renseigné");
  assert.deepEqual(errors, []);
  assert.deepEqual((await axeViolations(page)).map((v) => v.id), []);
  await context.close();
});

test("changement de langue : la même page passe en arabe (RTL) avec les mêmes valeurs", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "fr", viewport: { width: 375, height: 812 } });
  const page = await context.newPage();
  await page.goto(complete.base + "/terms");
  await page.locator("#legal-body h2").first().waitFor();
  await page.locator("button.lang").click();
  await page.waitForFunction(() => document.documentElement.lang === "ar");
  assert.equal(await page.evaluate(() => document.documentElement.dir), "rtl");
  assert.equal((await page.locator("h1").textContent()).trim(), "شروط الاستعمال");
  assert.ok((await page.locator("main").innerText()).includes(LEGAL_ENV.LEGAL_ENTITY));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "pas de défilement horizontal sur mobile");
  await context.close();
});

test("mentions légales : téléphone affiché s'il est renseigné, identifiant et responsable masqués sinon ; source OpenStreetMap citée", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "fr" });
  const page = await context.newPage();
  await page.goto(complete.base + "/legal");
  await page.locator("#legal-body h2").first().waitFor();
  const body = await page.locator("main").innerText();
  assert.ok(body.includes("+216 70 000 000"));
  assert.ok(!body.includes("Identifiant (registre") && !body.includes("Responsable de la publication"));
  assert.ok(body.includes("OpenStreetMap") && body.includes("ODbL"));
  await context.close();
});

test("sans informations d'éditeur (développement) : « à compléter » visible et avertissement affiché, jamais de texte vide", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "fr" });
  const page = await context.newPage();
  await page.goto(draft.base + "/privacy");
  await page.locator("#legal-body h2").first().waitFor();
  assert.ok((await page.locator("mark.todo").count()) > 3);
  assert.equal(await page.locator("#legal-draft").isVisible(), true);
  assert.ok(!/[{}]/.test(await page.locator("main").innerText()));
  await context.close();
});

test("liens : le pied de page de chaque page mène aux trois pages légales ; le formulaire renvoie à la confidentialité dans un nouvel onglet", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "fr", viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  for (const p of ["/", "/register", "/interview", "/status", "/privacy", "/une-page-inconnue"]) {
    await page.goto(complete.base + p);
    await page.locator("footer .foot-links a").first().waitFor();
    const hrefs = await page.locator("footer .foot-links a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    assert.deepEqual(hrefs, ["/privacy", "/terms", "/legal"], p);
  }
  await page.goto(complete.base + "/register");
  const link = page.locator("#sec-consent a[href='/privacy']");
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.equal(await link.getAttribute("rel"), "noopener");
  const [popup] = await Promise.all([context.waitForEvent("page"), link.click()]);
  await popup.waitForLoadState();
  assert.ok(popup.url().endsWith("/privacy"));
  await context.close();
});
