import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, launchBrowser, newContext, watchErrors, registerViaApi, ADMIN_TOKEN } from "./_harness.js";

let env, browser, skip;
before(async () => {
  env = await startApp({ notifications: { enabled: true, dailyCap: 50, reminderHours: 3 } });
  ({ browser, skip } = await launchBrowser());
});
after(async () => {
  await browser?.close();
  env.stop();
});

/** SMS de notification envoyés à ce numéro (les codes de vérification contiennent 6 chiffres : on les écarte). */
const notifications = (phone) => env.sms.sent.filter((s) => s.phone === phone && !s.code_only && !/votre code est/.test(s.text));

async function openDossier(page, phone) {
  await page.goto(env.base + "/admin");
  await page.fill("#token", ADMIN_TOKEN);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.fill("#f-q", phone);
  await page.waitForFunction(() => document.querySelectorAll("#apps tbody tr").length === 1);
  await page.locator("#apps tbody tr").first().click();
  await page.locator("#detail h2").waitFor();
}
const save = (page) => page.getByRole("button", { name: "Enregistrer", exact: true }).click();

test("console : changer le statut envoie un SMS au chauffeur, la case décochée n'en envoie pas, l'historique s'affiche", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const phone = "98720001";
  await registerViaApi(env, { phone, cin: "07200001" });
  const context = await newContext(browser, { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await openDossier(page, phone);
  assert.equal(await page.locator("#d-notify").isChecked(), true, "cochée par défaut");

  await page.selectOption("#d-status", "approved");
  await save(page);
  await page.locator("#detail .note", { hasText: "SMS mis en file" }).waitFor();
  await env.app.locals.notifier.drain();
  const sent = notifications(phone);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /acceptée/);

  // Corriger une erreur sans prévenir : case décochée.
  await page.selectOption("#d-status", "pending");
  await page.locator("#d-notify").uncheck();
  await save(page);
  await page.locator("#detail .note", { hasText: "Enregistré." }).waitFor();
  assert.ok(!(await page.locator("#detail .note").first().textContent()).includes("SMS"));
  await env.app.locals.notifier.drain();
  assert.equal(notifications(phone).length, 1, "aucun SMS pour la correction");

  // L'historique apparaît à la réouverture du dossier.
  await page.locator("#apps tbody tr").first().click();
  await page.locator("#detail .label", { hasText: "SMS au chauffeur" }).waitFor();
  assert.ok((await page.locator("#detail").innerText()).includes("dossier accepté — envoyé"));
  assert.deepEqual(errors, []);
  await context.close();
});
