import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, launchBrowser, newContext, watchErrors, hasHorizontalOverflow, registerViaApi, file, T } from "./_harness.js";

let env, browser, skip;
before(async () => {
  env = await startApp();
  ({ browser, skip } = await launchBrowser());
});
after(async () => {
  await browser?.close();
  env.stop();
});

const stamps = (page) => page.locator("#stamps .stamp.done").count();

test("inscription complète sur un téléphone (français), avec la vraie caméra simulée", { timeout: 120_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const t_ = T.fr;
  const context = await newContext(browser, { lang: "fr" });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(env.base + "/register");

  // 1. Vos informations + vérification du téléphone par SMS
  await page.fill("#full_name", "Ali Ben Salah");
  await page.fill("#phone", "98 123 456");
  await page.fill("#cin", "01234567");
  assert.equal(await stamps(page), 0);
  await page.click("#otp-send");
  await page.waitForFunction(() => !document.getElementById("otp-step").hidden);
  const code = (await pollFor(() => env.sms.sent.at(-1)?.code));
  assert.equal(env.sms.sent.at(-1).phone, "98123456", "le numéro est normalisé avant l'envoi du SMS");
  await page.fill("#otp_code", code);
  await page.locator("#otp-ok").waitFor();
  assert.equal(await stamps(page), 1, "tampon « Vos informations » posé dès que le téléphone est vérifié");

  // 2. Véhicule et station
  await page.fill("#plate", "123 TUN 4567");
  await page.selectOption("#governorate", "Gafsa");
  await page.fill("#station", "Gare de Redeyef");
  assert.equal(await stamps(page), 2);

  // 3. Ligne : régional, arrivée verrouillée sur le gouvernorat de la station, arrêts en route
  await page.locator("label.choice:has(input[value=regional])").click();
  assert.equal(await page.inputValue("#line_to_gov"), "Gafsa");
  assert.equal(await page.locator("#line_to_gov").isDisabled(), true);
  await page.fill("#line_from", "Redeyef");
  await page.locator("label.consent:has(input[name=pickup_en_route])").click();
  assert.equal(await stamps(page), 2, "« je prends des passagers en route » sans ville d'arrêt : la section n'est pas complète");
  await page.fill("#line_via", "Oum Larayes, Métlaoui");
  assert.equal(await stamps(page), 3);

  // 4. Documents
  for (const name of ["cin_front", "cin_back", "permis"]) await page.setInputFiles(`#${name}`, file(name));
  assert.equal(await stamps(page), 4);

  // 5. Selfies : vraie capture par la caméra simulée du navigateur (3 poses de 1,8 s)
  await page.getByRole("button", { name: t_.selfie_open }).click();
  const take = page.getByRole("button", { name: t_.selfie_take });
  await take.waitFor();
  await page.waitForFunction(() => { const b = document.querySelector(".selfie-cam .btn"); return b && !b.disabled; });
  await take.click();
  await page.locator(".selfie-done").waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".thumbs img").count(), 3, "trois photos prises");
  assert.equal(await stamps(page), 5);

  // 6. Consentements (séparés, jamais pré-cochés)
  assert.equal(await page.locator("input[name=consent]").isChecked(), false);
  assert.equal(await page.locator("input[name=consent_biometric]").isChecked(), false);
  await page.locator("label.consent:has(input[name=consent])").click();
  assert.equal(await stamps(page), 5, "un seul consentement ne suffit pas");
  await page.locator("label.consent:has(input[name=consent_biometric])").click();
  assert.equal(await stamps(page), 6);
  assert.equal(await page.locator(".stamps-count").textContent(), t_.stamps_all);
  assert.equal(await hasHorizontalOverflow(page), false, "pas de défilement horizontal sur mobile");

  // 7. Envoi
  await page.click("#submit");
  await page.locator("#done-view").waitFor();
  const ref = (await page.locator("#done-ref").textContent()).trim();
  assert.match(ref, /^LX-[A-Z2-9]{8}$/);
  assert.equal(await page.locator("#done-stamps .stamp").count(), 6, "la carte des six tampons s'affiche à la confirmation");
  assert.equal(await page.locator("#form-view").isHidden(), true);

  // Ce que le serveur a réellement enregistré
  const row = env.db.prepare("SELECT * FROM applications WHERE ref = ?").get(ref);
  assert.equal(row.full_name, "Ali Ben Salah");
  assert.equal(row.phone, "98123456");
  assert.equal(row.governorate, "Gafsa");
  assert.equal(row.line_type, "regional");
  assert.equal(row.route, "Redeyef → Gafsa (via Oum El Araies, Metlaoui)", "ligne affichée avec les noms officiels");
  assert.equal(row.line_from, "Redeyef");
  assert.deepEqual(JSON.parse(row.line_via), ["Oum Larayes", "Métlaoui"]);
  assert.equal(row.pickup_en_route, 1);
  assert.equal(row.role, "driver");
  const files = env.db.prepare("SELECT kind, enc FROM files WHERE application_id = ? ORDER BY kind").all(row.id);
  assert.deepEqual(files.map((f) => f.kind), ["cin_back", "cin_front", "permis", "selfie_1", "selfie_2", "selfie_3"]);
  assert.ok(files.every((f) => f.enc === 1), "toutes les pièces sont chiffrées au repos");

  // La vérification d'identité reçoit les 3 images de la caméra, différentes les unes des autres (mouvement)
  await env.app.locals.kyc.drain();
  assert.equal(env.kycCalls.length, 1);
  const frames = env.kycCalls[0].selfieFrames;
  assert.equal(frames.length, 3);
  assert.ok(frames.every((f) => f.startsWith("data:image/jpeg;base64,")));
  assert.equal(new Set(frames).size, 3, "les trois photos de la caméra sont distinctes");

  assert.deepEqual(errors, []);
  await context.close();
});

test("le même chauffeur ne peut pas s'inscrire deux fois (téléphone ou CIN déjà utilisé)", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  await registerViaApi(env, { phone: "21111111", cin: "05555555" }); // un dossier existe déjà avec cette CIN
  const context = await newContext(browser, { lang: "fr" });
  const page = await context.newPage();
  await page.goto(env.base + "/register");
  await fillEverythingButSubmit(page, { phone: "98123457", cin: "05555555" }); // autre téléphone, même CIN
  await page.click("#submit");
  await page.locator("#banner").waitFor();
  assert.equal(await page.locator("#banner").textContent(), T.fr.e_duplicate);
  assert.equal(await page.locator("#done-view").isHidden(), true);
  await context.close();
});

test("version arabe : sens de lecture droite → gauche, textes arabes, changement de langue sans perdre la saisie", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "ar" });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(env.base + "/register");
  assert.equal(await page.getAttribute("html", "dir"), "rtl");
  assert.equal(await page.getAttribute("html", "lang"), "ar");
  assert.equal(await page.locator("#form-view h1").textContent(), T.ar.reg_title);
  assert.equal(await page.locator("#stamps .stamp-name").first().textContent(), T.ar.sec_you);
  assert.equal(await page.locator(".stamps-count").textContent(), "0 / 6");
  assert.equal(await page.locator(".stamps-count").getAttribute("dir"), "ltr", "le compteur numérique ne doit pas être inversé en arabe (« 6 / 0 »)");
  assert.equal(await page.locator(".stamps-count").evaluate((el) => getComputedStyle(el).direction), "ltr");

  await page.fill("#full_name", "علي بن صالح");
  await page.selectOption("#governorate", "Gafsa");
  await page.locator("button.lang").click();
  assert.equal(await page.getAttribute("html", "dir"), "ltr");
  assert.equal(await page.locator("#form-view h1").textContent(), T.fr.reg_title);
  assert.equal(await page.inputValue("#full_name"), "علي بن صالح", "le nom saisi est conservé");
  assert.equal(await page.inputValue("#governorate"), "Gafsa", "le gouvernorat choisi est conservé");
  assert.deepEqual(errors, []);
  await context.close();
});

/** Remplit tout le formulaire (sans caméra : photos choisies dans la galerie) sans l'envoyer. */
async function fillEverythingButSubmit(page, { phone, cin }) {
  await page.fill("#full_name", "Autre Chauffeur");
  await page.fill("#phone", phone);
  await page.fill("#cin", cin);
  await page.click("#otp-send");
  await page.waitForFunction(() => !document.getElementById("otp-step").hidden);
  await page.fill("#otp_code", await pollFor(() => env.sms.sent.findLast((s) => s.phone === phone)?.code));
  await page.locator("#otp-ok").waitFor();
  await page.fill("#plate", "456 TUN 1111");
  await page.selectOption("#governorate", "Sousse");
  await page.fill("#station", "Gare");
  await page.locator("label.choice:has(input[value=interregional])").click();
  await page.fill("#line_from", "Sousse");
  await page.selectOption("#line_to_gov", "Tunis");
  for (const name of ["cin_front", "cin_back", "permis"]) await page.setInputFiles(`#${name}`, file(name));
  await page.getByRole("button", { name: T.fr.selfie_gallery }).click();
  const inputs = page.locator(".selfie-files input[type=file]");
  await inputs.nth(0).setInputFiles(await realImage(page, 0));
  await inputs.nth(1).setInputFiles(await realImage(page, 6));
  await page.locator("label.consent:has(input[name=consent])").click();
  await page.locator("label.consent:has(input[name=consent_biometric])").click();
}

/** Un vrai PNG décodable (le navigateur le relit pour le réduire avant l'envoi), créé dans la page. */
async function realImage(page, shift) {
  const b64 = await page.evaluate(async (dx) => {
    const c = document.createElement("canvas");
    c.width = 200; c.height = 200;
    const x = c.getContext("2d");
    x.fillStyle = "#c9a97a"; x.fillRect(0, 0, 200, 200);
    x.fillStyle = "#000"; x.fillRect(40 + dx, 40, 60, 90);
    return c.toDataURL("image/png").split(",")[1];
  }, shift);
  return { name: `photo-${shift}.png`, mimeType: "image/png", buffer: Buffer.from(b64, "base64") };
}

async function pollFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("délai dépassé en attendant la condition");
}
