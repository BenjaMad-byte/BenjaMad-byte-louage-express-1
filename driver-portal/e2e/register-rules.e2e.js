import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, launchBrowser, newContext, watchErrors, T } from "./_harness.js";

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
const count = () => env.db.prepare("SELECT COUNT(*) AS n FROM applications").get().n;
const lastCode = async (phone) => {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const s = env.sms.sent.findLast((x) => x.phone === phone);
    if (s) return s.code;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("aucun SMS reçu");
};

async function open(lang = "fr") {
  const context = await newContext(browser, { lang });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(env.base + "/register");
  return { context, page, errors };
}

test("envoi du formulaire vide : message clair, focus sur le téléphone, rien n'est enregistré", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { context, page, errors } = await open();
  const before = count();
  await page.click("#submit");
  await page.locator("#banner").waitFor();
  assert.equal(await page.locator("#banner").textContent(), F.e_otp_required);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "phone");
  assert.equal(count(), before);
  assert.deepEqual(errors, []);
  await context.close();
});

test("téléphone invalide : erreur sous le champ et aucun SMS envoyé", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { context, page } = await open();
  const sent = env.sms.sent.length;
  await page.fill("#phone", "12345");
  await page.click("#otp-send");
  await page.locator('[data-err="phone"]:not(:empty)').waitFor();
  assert.equal(await page.locator('[data-err="phone"]').textContent(), F.e_invalid_phone);
  assert.equal(env.sms.sent.length, sent, "aucun SMS pour un numéro invalide");
  await context.close();
});

test("chiffres arabes (٩٨١٢٣٤٥٦) ramenés en chiffres latins dès la saisie", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { context, page } = await open("ar");
  await page.fill("#phone", "٩٨١٢٣٤٥٦");
  assert.equal(await page.inputValue("#phone"), "98123456");
  await page.fill("#cin", "۰۱۲۳۴۵۶۷");
  assert.equal(await page.inputValue("#cin"), "01234567");
  await context.close();
});

test("code SMS : un mauvais code est refusé, au bout de 5 essais le code est verrouillé même avec le bon", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { context, page } = await open();
  await page.fill("#phone", "98222333");
  await page.click("#otp-send");
  await page.waitForFunction(() => !document.getElementById("otp-step").hidden);
  const real = await lastCode("98222333");
  const wrong = real === "000000" ? "111111" : "000000";
  const err = page.locator('[data-err="otp_code"]');

  await page.fill("#otp_code", wrong);
  await page.waitForFunction(() => document.querySelector('[data-err="otp_code"]').textContent !== "");
  assert.equal(await err.textContent(), F.e_otp_invalid);
  assert.equal(await page.locator("#otp-ok").isHidden(), true);

  for (let i = 0; i < 4; i++) {
    await page.fill("#otp_code", "");
    await page.fill("#otp_code", wrong);
    await page.waitForTimeout(150);
  }
  assert.equal(await err.textContent(), F.e_otp_locked);
  await page.fill("#otp_code", "");
  await page.fill("#otp_code", real);
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#otp-ok").isHidden(), true, "même le bon code est refusé une fois verrouillé");
  await context.close();
});

test("changer de numéro après la vérification annule la vérification", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { context, page } = await open();
  await page.fill("#phone", "98444555");
  await page.click("#otp-send");
  await page.fill("#otp_code", await lastCode("98444555"));
  await page.locator("#otp-ok").waitFor();
  await page.fill("#phone", "98444556");
  assert.equal(await page.locator("#otp-ok").isHidden(), true);
  assert.equal(await page.locator("#otp-send").isVisible(), true, "le bouton d'envoi du code revient");
  await context.close();
});

test("erreurs du serveur affichées champ par champ (nom, véhicule, ligne, consentements)", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { context, page } = await open();
  await page.fill("#phone", "98666777");
  await page.click("#otp-send");
  await page.fill("#otp_code", await lastCode("98666777"));
  await page.locator("#otp-ok").waitFor();
  // deux photos par la galerie pour passer le contrôle local ; tout le reste est laissé vide
  await page.getByRole("button", { name: F.selfie_gallery }).click();
  const png = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 50; c.height = 50; return c.toDataURL("image/png").split(",")[1]; });
  const buffer = Buffer.from(png, "base64");
  const inputs = page.locator(".selfie-files input[type=file]");
  await inputs.nth(0).setInputFiles({ name: "a.png", mimeType: "image/png", buffer });
  await inputs.nth(1).setInputFiles({ name: "b.png", mimeType: "image/png", buffer });
  const before = count();
  await page.click("#submit");
  await page.locator('[data-err="full_name"]:not(:empty)').waitFor();
  assert.equal(await page.locator("#banner").textContent(), F.e_validation);
  for (const [field, key] of [["full_name", "e_invalid_name"], ["cin", "e_invalid_cin"], ["plate", "e_invalid_plate"], ["governorate", "e_invalid_governorate"],
    ["station", "e_invalid_station"], ["line_type", "e_invalid_line_type"], ["line_from", "e_invalid_line_from"], ["consent", "e_consent_required"],
    ["cin_front", "e_file_required"]]) {
    assert.equal(await page.locator(`[data-err="${field}"]`).textContent(), F[key], field);
  }
  assert.equal(count(), before, "rien n'est enregistré");
  await context.close();
});

test("type de ligne : régional verrouille l'arrivée, interrégional exclut le gouvernorat de la station, national masque l'arrivée", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { context, page } = await open();
  await page.selectOption("#governorate", "Gafsa");
  const options = () => page.locator("#line_to_gov option").evaluateAll((os) => os.map((o) => o.value).filter(Boolean));

  await page.locator("label.choice:has(input[value=regional])").click();
  assert.equal(await page.inputValue("#line_to_gov"), "Gafsa");
  assert.equal(await page.locator("#line_to_gov").isDisabled(), true);

  await page.locator("label.choice:has(input[value=interregional])").click();
  const inter = await options();
  assert.equal(inter.length, 23);
  assert.ok(!inter.includes("Gafsa"));
  assert.equal(await page.locator("#line_to_gov").isDisabled(), false);
  await page.selectOption("#line_to_gov", "Tunis");
  await page.selectOption("#governorate", "Tunis");
  assert.equal(await page.inputValue("#line_to_gov"), "", "changer la station vers le gouvernorat d'arrivée vide le choix devenu invalide");

  await page.locator("label.choice:has(input[value=rural])").click();
  assert.equal(await page.inputValue("#line_to_gov"), "Tunis", "rural : comme le régional, arrivée = gouvernorat de la station");

  await page.locator("label.choice:has(input[value=national])").click();
  assert.equal(await page.locator("#line-to-field").isHidden(), true);
  assert.equal(await page.locator("#line-national-hint").isVisible(), true);
  await context.close();
});
