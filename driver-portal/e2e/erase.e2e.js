import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startApp, launchBrowser, newContext, watchErrors, axeViolations, hasHorizontalOverflow, registerViaApi, T } from "./_harness.js";

let env, browser, skip;
before(async () => {
  env = await startApp();
  ({ browser, skip } = await launchBrowser());
});
after(async () => {
  await browser?.close();
  env.stop();
});

const F = T.fr;
const countApps = () => env.db.prepare("SELECT COUNT(*) AS n FROM applications").get().n;

async function openStatus(page, ref, phone) {
  await page.goto(env.base + "/status");
  await page.fill("#ref", ref);
  await page.fill("#phone", phone);
  await page.getByRole("button", { name: F.st_check }).click();
  await page.locator("#result").waitFor();
}

test("le chauffeur supprime sa demande : code SMS, confirmation, tout disparaît (base, pièces) et la page le confirme", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const ref = await registerViaApi(env, { phone: "98710001", cin: "07100001" });
  const stored = env.db.prepare("SELECT stored_name FROM files").all().map((f) => f.stored_name);
  assert.ok(stored.length >= 3);
  const { UPLOAD_DIR } = await import("../db.js"); // même instance que le serveur de test (importé après startApp)

  const context = await newContext(browser, { lang: "fr", viewport: { width: 375, height: 812 } });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await openStatus(page, ref, "98 710 001");
  assert.equal(await page.locator("#erase-panel").isHidden(), true, "le panneau est replié par défaut");

  await page.getByRole("button", { name: F.er_open }).click();
  assert.equal(await page.locator("#erase-open").getAttribute("aria-expanded"), "true");
  assert.ok((await page.locator("#erase-panel").innerText()).includes("définitive"));
  await page.getByRole("button", { name: F.otp_send }).click();
  await page.locator("#erase-step").waitFor();

  // Mauvais code : refusé, la demande reste.
  await page.fill("#erase_code", "000000");
  await page.getByRole("button", { name: F.er_confirm }).click();
  await page.waitForFunction((txt) => document.getElementById("erase-err").textContent === txt, F.e_otp_invalid);
  assert.equal(countApps(), 1);

  // Bon code : tout est supprimé.
  const code = env.sms.sent.findLast((s) => s.phone === "98710001").code;
  await page.fill("#erase_code", code);
  await page.getByRole("button", { name: F.er_confirm }).click();
  await page.locator("#banner.ok").waitFor();
  assert.equal((await page.locator("#banner").textContent()).trim(), F.er_done);
  assert.equal(await page.locator("#result").isHidden(), true);
  assert.equal(await page.locator("#st").isHidden(), true, "le formulaire de recherche disparaît aussi");
  assert.equal(countApps(), 0);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 0);
  assert.ok(stored.every((name) => !fs.existsSync(path.join(UPLOAD_DIR, name))), "pièces supprimées du disque");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("contact")), "{}", "plus de référence ni de téléphone gardés dans l'onglet");

  // Le suivi ne retrouve plus la demande.
  const again = await fetch(env.base + "/api/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref, phone: "98710001" }) });
  assert.equal(again.status, 404);
  assert.deepEqual(errors, []);
  await context.close();
});

test("panneau de suppression ouvert : arabe et français, sans débordement ni faille d'accessibilité", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const ref = await registerViaApi(env, { phone: "98710002", cin: "07100002" });
  for (const lang of ["ar", "fr"]) {
    const context = await newContext(browser, { lang, colorScheme: lang === "ar" ? "dark" : "light", viewport: { width: 375, height: 812 } });
    const page = await context.newPage();
    await page.goto(env.base + "/status");
    await page.fill("#ref", ref);
    await page.fill("#phone", "98710002");
    await page.locator("#st button[type=submit]").click();
    await page.locator("#result").waitFor();
    await page.locator("#erase-open").click();
    await page.locator("#erase-send").click();
    await page.locator("#erase-step").waitFor();
    assert.equal(await hasHorizontalOverflow(page), false, lang);
    assert.deepEqual((await axeViolations(page)).map((v) => `${v.id}:${v.nodes.join(",")}`), [], lang);
    await context.close();
  }
  assert.equal(countApps(), 1, "ouvrir le panneau ne supprime rien");
});
