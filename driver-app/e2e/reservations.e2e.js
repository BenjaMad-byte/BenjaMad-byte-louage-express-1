import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, launchBrowser, newContext, watchErrors, loginViaUi, portalDriver, T } from "./_harness.js";

let env, browser, skip;
before(async () => {
  env = await startApp({ reservations: true });
  ({ browser, skip } = await launchBrowser());
});
after(async () => {
  await browser?.close();
  env.stop();
});
const F = T.fr;

test("réservation de bout en bout : le passager réserve et « paie » (simulé), le chauffeur voit le code, confirme la montée HORS LIGNE, et tout se synchronise", { timeout: 150_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const d = portalDriver();
  const driverCtx = await newContext(browser);
  const driverPage = await driverCtx.newPage();
  const errors = watchErrors(driverPage);
  await loginViaUi(driverPage, env, d);
  await driverPage.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await driverPage.locator("#join").click();
  await driverPage.locator("#board").waitFor();
  await driverPage.waitForFunction(() => window.__lx.pending === 0);

  // Le passager (autre appareil) réserve depuis la page de démonstration.
  const paxCtx = await newContext(browser);
  const pax = await paxCtx.newPage();
  await pax.goto(env.base + "/passager.html");
  await pax.locator("#form:not([hidden])").waitFor();
  await pax.fill("#phone", "97111222");
  await pax.getByRole("button", { name: "Réserver" }).click();
  await pax.locator("#ticket:not([hidden])").waitFor();
  const code = (await pax.locator("#code").innerText()).trim();
  assert.match(code, /^[A-HJ-KM-NP-Z2-9]{6}$/);
  await pax.waitForFunction(() => document.querySelector("#status").innerText.includes("En attente du paiement"));
  await pax.getByRole("button", { name: "Simuler la réponse de l'opérateur" }).click();
  await pax.waitForFunction(() => document.querySelector("#status").innerText.includes("Réservation confirmée"));
  assert.ok((await pax.locator("#plate").innerText()).includes(d.plate), "le passager voit la plaque du louage");
  assert.ok(!(await pax.locator("body").innerText()).includes(d.full_name), "jamais le nom du chauffeur");

  // Le chauffeur rouvre son application : il voit la place réservée et le code à comparer.
  await driverPage.reload();
  await driverPage.locator("#seats").waitFor();
  await driverPage.locator(".pax summary").click();
  assert.ok((await driverPage.locator(".pax").innerText()).includes(code));
  assert.equal(await driverPage.locator("#seats").innerText(), "1 / 8");

  // Il confirme la montée SANS réseau (le code est déjà sur son téléphone).
  await driverCtx.setOffline(true);
  await driverPage.getByRole("button", { name: F.pax_arrived }).click();
  await driverPage.waitForFunction(() => window.__lx.pending === 1);
  assert.equal(env.db.prepare("SELECT status FROM reservations").get().status, "confirmed", "le serveur ne sait encore rien");
  await driverCtx.setOffline(false);
  await driverPage.waitForFunction(() => window.__lx.pending === 0, null, { timeout: 30_000 });
  assert.equal(env.db.prepare("SELECT status FROM reservations").get().status, "boarded");
  await pax.waitForFunction(() => document.querySelector("#status").innerText.includes("Vous êtes monté"), null, { timeout: 15_000 });
  assert.deepEqual(errors, []);
  await driverCtx.close();
  await paxCtx.close();
});

test("page passager : message clair quand aucun louage n'est disponible", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  env.db.exec("DELETE FROM reservations; DELETE FROM boardings; DELETE FROM trips; DELETE FROM lines");
  const ctx = await newContext(browser);
  const pax = await ctx.newPage();
  await pax.goto(env.base + "/passager.html");
  await pax.locator("#empty:not([hidden])").waitFor();
  assert.ok((await pax.locator("#empty").innerText()).includes("Aucun louage"));
  await ctx.close();
});
