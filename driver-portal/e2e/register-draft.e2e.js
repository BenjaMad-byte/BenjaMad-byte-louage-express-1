import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, launchBrowser, newContext, watchErrors, file, T } from "./_harness.js";

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
const DRAFT_KEY = "lx_draft_v1";
const OTP_KEY = "lx_otp_v1";
const local = (page, key = DRAFT_KEY) => page.evaluate((k) => localStorage.getItem(k), key);
const session = (page, key = OTP_KEY) => page.evaluate((k) => sessionStorage.getItem(k), key);
const waitSaved = (page) => page.waitForFunction((k) => localStorage.getItem(k) !== null, DRAFT_KEY);

async function lastCode(phone) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const s = env.sms.sent.findLast((x) => x.phone === phone);
    if (s) return s.code;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("aucun SMS reçu");
}

async function fillMostOfIt(page, { phone = "98300001", cin = "03000001", verify = false } = {}) {
  await page.fill("#full_name", "Ali Ben Salah");
  await page.fill("#phone", phone);
  await page.fill("#cin", cin);
  if (verify) {
    await page.click("#otp-send");
    await page.waitForFunction(() => !document.getElementById("otp-step").hidden);
    await page.fill("#otp_code", await lastCode(phone));
    await page.locator("#otp-ok").waitFor();
  }
  await page.fill("#plate", "123 TUN 4567");
  await page.selectOption("#governorate", "Gafsa");
  await page.fill("#station", "Gare de Redeyef");
  await page.locator("label.choice:has(input[value=regional])").click();
  await page.fill("#line_from", "Redeyef");
  await page.locator("label.consent:has(input[name=pickup_en_route])").click();
  await page.fill("#line_via", "Oum Larayes, Métlaoui");
}

async function realPng(page, dx) {
  const b64 = await page.evaluate((shift) => {
    const c = document.createElement("canvas");
    c.width = 120; c.height = 120;
    const x = c.getContext("2d");
    x.fillStyle = "#c9a97a"; x.fillRect(0, 0, 120, 120);
    x.fillStyle = "#000"; x.fillRect(30 + shift, 30, 40, 60);
    return c.toDataURL("image/png").split(",")[1];
  }, dx);
  return { name: `p${dx}.png`, mimeType: "image/png", buffer: Buffer.from(b64, "base64") };
}

async function finishForm(page) {
  for (const n of ["cin_front", "cin_back", "permis"]) await page.setInputFiles(`#${n}`, file(n));
  await page.getByRole("button", { name: F.selfie_gallery }).click();
  const inputs = page.locator(".selfie-files input[type=file]");
  await inputs.nth(0).setInputFiles(await realPng(page, 0));
  await inputs.nth(1).setInputFiles(await realPng(page, 8));
  await page.locator("label.consent:has(input[name=consent])").click();
  await page.locator("label.consent:has(input[name=consent_biometric])").click();
}

test("la saisie est gardée pendant qu'on écrit et retrouvée après un rechargement ; photos, CIN et consentements ne le sont jamais", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "fr" });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(env.base + "/register");
  assert.equal(await local(page), null, "rien n'est enregistré avant la première saisie");
  assert.ok((await page.locator(".note").first().textContent()).includes("3 jours"), "l'engagement est affiché avant la saisie");

  await fillMostOfIt(page);
  for (const n of ["cin_front", "cin_back", "permis"]) await page.setInputFiles(`#${n}`, file(n));
  await page.locator("label.consent:has(input[name=consent])").click();
  await waitSaved(page);
  await page.waitForTimeout(600); // laisse passer la dernière sauvegarde différée

  const stored = await local(page);
  for (const forbidden of ["03000001", "consent", "cin_front", "PIECE-D-IDENTITE", "selfie"]) assert.ok(!stored.includes(forbidden), `« ${forbidden} » ne doit jamais être enregistré`);

  await page.reload();
  assert.equal(await page.inputValue("#full_name"), "Ali Ben Salah");
  assert.equal(await page.inputValue("#phone"), "98300001");
  assert.equal(await page.inputValue("#plate"), "123 TUN 4567");
  assert.equal(await page.inputValue("#governorate"), "Gafsa");
  assert.equal(await page.inputValue("#station"), "Gare de Redeyef");
  assert.equal(await page.locator("input[name=line_type][value=regional]").isChecked(), true);
  assert.equal(await page.inputValue("#line_to_gov"), "Gafsa", "l'arrivée d'une ligne régionale est recalculée");
  assert.equal(await page.locator("#line_to_gov").isDisabled(), true);
  assert.equal(await page.inputValue("#line_from"), "Redeyef");
  assert.equal(await page.inputValue("#line_via"), "Oum Larayes, Métlaoui");
  assert.equal(await page.locator("input[name=pickup_en_route]").isChecked(), true);

  assert.equal(await page.inputValue("#cin"), "", "la CIN n'est pas restaurée");
  assert.equal(await page.locator("input[name=consent]").isChecked(), false, "les consentements sont à redonner");
  assert.equal(await page.locator("input[name=consent_biometric]").isChecked(), false);
  for (const n of ["cin_front", "cin_back", "permis"]) assert.equal(await page.locator(`#${n}`).evaluate((i) => i.files.length), 0, `${n} : photo à remettre`);

  const notice = page.locator("#draft-notice");
  assert.equal(await notice.isVisible(), true);
  const text = await page.locator("#draft-text").textContent();
  assert.ok(!text.includes("{date}") && /\d/.test(text), "l'avis indique quand le brouillon a été enregistré");
  assert.equal(await page.locator("#stamps .stamp.done").count(), 2, "véhicule et ligne sont complets ; identité (SMS), documents, selfies, consentements restent à faire");
  assert.deepEqual(errors, []);
  await context.close();
});

test("coupure réseau pendant l'envoi : message clair, rien n'est perdu, le brouillon reste ; l'envoi suivant réussit et efface tout", { timeout: 120_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "fr" });
  const page = await context.newPage();
  await page.goto(env.base + "/register");
  await fillMostOfIt(page, { phone: "98300002", cin: "03000002", verify: true });
  await finishForm(page);
  await waitSaved(page);

  await context.setOffline(true);
  await page.click("#submit");
  await page.locator("#banner:not([hidden])").waitFor();
  assert.equal(await page.locator("#banner").textContent(), F.e_network);
  assert.equal(await page.locator("#done-view").isHidden(), true);
  assert.equal(await page.inputValue("#full_name"), "Ali Ben Salah", "la saisie est intacte");
  assert.equal(await page.locator("input[name=consent]").isChecked(), true, "les consentements déjà donnés sur cette page le restent");
  assert.notEqual(await local(page), null, "le brouillon n'est pas effacé par un échec");
  assert.equal(await page.locator("#submit").isDisabled(), false, "le bouton redevient utilisable");

  await context.setOffline(false);
  await page.click("#submit");
  await page.locator("#done-view").waitFor();
  assert.equal(await local(page), null, "brouillon effacé après un envoi réussi");
  assert.equal(await session(page), null, "jeton de vérification effacé aussi");
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM applications WHERE phone = ?").get("98300002").n, 1, "une seule demande, pas de doublon après la reprise");
  await context.close();
});

test("téléphone déjà vérifié : un rechargement ne redemande pas de SMS ; un autre onglet, si ; changer de numéro annule", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "fr" });
  const page = await context.newPage();
  await page.goto(env.base + "/register");
  await fillMostOfIt(page, { phone: "98300003", cin: "03000003", verify: true });
  await waitSaved(page);
  await page.waitForTimeout(600);
  const sent = env.sms.sent.length;

  await page.reload();
  assert.equal(await page.locator("#otp-ok").isVisible(), true, "numéro toujours vérifié après rechargement");
  assert.equal(env.sms.sent.length, sent, "aucun nouveau SMS");
  const youStamp = page.locator('#stamps a[href="#sec-you"]');
  assert.equal(await youStamp.getAttribute("aria-label"), `${F.sec_you} — ${F.stamp_todo}`, "la CIN n'est pas gardée : « Vos informations » reste à compléter");
  await page.fill("#cin", "03000003");
  assert.equal(await youStamp.getAttribute("aria-label"), `${F.sec_you} — ${F.stamp_done}`, "dès que la CIN est retapée, le tampon est posé (le numéro est resté vérifié)");

  const other = await context.newPage(); // nouvel onglet : sessionStorage non partagé
  await other.goto(env.base + "/register");
  assert.equal(await other.inputValue("#phone"), "98300003", "le brouillon (localStorage) est partagé");
  assert.equal(await other.locator("#otp-ok").isHidden(), true, "mais la vérification ne l'est pas");

  await page.fill("#phone", "98300009");
  assert.equal(await page.locator("#otp-ok").isHidden(), true);
  assert.equal(await session(page), null, "changer de numéro efface la vérification mémorisée");
  await context.close();
});

test("brouillon périmé, corrompu ou piégé : ignoré (et effacé), jamais exécuté", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const stale = JSON.stringify({ v: 1, savedAt: Date.now() - 4 * 24 * 3600 * 1000, fields: { full_name: "Trop Ancien" } });
  const cases = [["périmé (4 jours)", stale], ["illisible", "{pas du json"], ["autre version", JSON.stringify({ v: 9, savedAt: Date.now(), fields: { full_name: "Futur" } })]];
  for (const [label, raw] of cases) {
    const context = await newContext(browser, { lang: "fr" });
    const page = await context.newPage();
    await page.addInitScript(([k, v]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, v); sessionStorage.setItem("seeded", "1"); } }, [DRAFT_KEY, raw]);
    await page.goto(env.base + "/register");
    assert.equal(await page.inputValue("#full_name"), "", label);
    assert.equal(await page.locator("#draft-notice").isHidden(), true, label);
    assert.equal(await local(page), null, `${label} : effacé du stockage`);
    await context.close();
  }

  // Contenu piégé : du texte de formulaire, jamais du HTML
  const context = await newContext(browser, { lang: "fr" });
  const page = await context.newPage();
  const errors = watchErrors(page);
  let dialog = false;
  page.on("dialog", (d) => { dialog = true; d.dismiss(); });
  const evil = JSON.stringify({ v: 1, savedAt: Date.now(), fields: { full_name: "<img src=x onerror=alert(1)>", station: "\"><script>alert(2)</script>", line_type: "<b>", governorate: "Narnia", pickup_en_route: "true" } });
  await page.addInitScript(([k, v]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, v); sessionStorage.setItem("seeded", "1"); } }, [DRAFT_KEY, evil]);
  await page.goto(env.base + "/register");
  assert.equal(await page.inputValue("#full_name"), "<img src=x onerror=alert(1)>", "affiché comme du texte");
  assert.equal(await page.locator("img[src='x']").count(), 0, "aucun élément injecté");
  assert.equal(dialog, false, "aucun script exécuté");
  assert.equal(await page.inputValue("#governorate"), "", "gouvernorat inconnu écarté");
  assert.equal(await page.locator("input[name=line_type]:checked").count(), 0, "type de ligne inconnu écarté");
  assert.equal(await page.locator("input[name=pickup_en_route]").isChecked(), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test("« Effacer et recommencer » : formulaire vide, brouillon et vérification effacés, rien de restauré au rechargement", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "fr" });
  const page = await context.newPage();
  await page.goto(env.base + "/register");
  await fillMostOfIt(page, { phone: "98300004", cin: "03000004", verify: true });
  await waitSaved(page);
  await page.waitForTimeout(600);
  await page.reload();
  await page.locator("#draft-notice").waitFor();

  await page.getByRole("button", { name: F.draft_clear }).click();
  assert.equal(await page.locator("#draft-notice").isHidden(), true);
  for (const id of ["full_name", "phone", "plate", "station", "line_from", "line_via"]) assert.equal(await page.inputValue(`#${id}`), "", id);
  assert.equal(await page.locator("input[name=line_type]:checked").count(), 0);
  assert.equal(await page.locator("#otp-ok").isHidden(), true);
  assert.equal(await page.locator("#stamps .stamp.done").count(), 0);
  assert.equal(await local(page), null);
  assert.equal(await session(page), null);

  await page.reload();
  assert.equal(await page.inputValue("#full_name"), "");
  assert.equal(await page.locator("#draft-notice").isHidden(), true);
  await context.close();
});

test("langues : brouillon écrit en français relu en arabe, date en chiffres latins ; les textes de l'avis sont traduits", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const writer = await newContext(browser, { lang: "fr" });
  const first = await writer.newPage();
  await first.goto(env.base + "/register");
  await first.fill("#full_name", "Ali Ben Salah");
  await waitSaved(first);
  await first.waitForTimeout(600);
  const raw = await local(first);
  await writer.close();

  const reader = await newContext(browser, { lang: "ar" });
  const page = await reader.newPage();
  await page.addInitScript(([k, v]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, v); sessionStorage.setItem("seeded", "1"); } }, [DRAFT_KEY, raw]);
  await page.goto(env.base + "/register");
  assert.equal(await page.getAttribute("html", "lang"), "ar");
  assert.equal(await page.inputValue("#full_name"), "Ali Ben Salah");
  const text = await page.locator("#draft-text").textContent();
  assert.ok(/[؀-ۿ]/.test(text), "avis en arabe");
  assert.ok(/[0-9]/.test(text) && !/[٠-٩]/.test(text), "date en chiffres latins (convention du site)");
  assert.equal(await page.getByRole("button", { name: T.ar.draft_clear }).isVisible(), true);

  // et le changement de langue re-traduit l'avis déjà affiché
  await page.locator("button.lang").click();
  assert.ok(/brouillon/i.test(await page.locator("#draft-text").textContent()));
  await reader.close();
});

test("stockage du navigateur bloqué (navigation privée stricte) : le formulaire fonctionne sans brouillon, sans erreur", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "fr" });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.addInitScript(() => {
    const boom = () => { throw new DOMException("bloqué", "SecurityError"); };
    Storage.prototype.setItem = boom;
    Storage.prototype.getItem = boom;
    Storage.prototype.removeItem = boom;
  });
  await page.goto(env.base + "/register");
  await fillMostOfIt(page, { phone: "98300005", cin: "03000005" });
  await page.waitForTimeout(700);
  assert.equal(await page.inputValue("#full_name"), "Ali Ben Salah");
  assert.equal(await page.locator("#stamps .stamp.done").count(), 2);
  await page.reload();
  assert.equal(await page.inputValue("#full_name"), "", "rien de restauré, mais aucune panne");
  assert.deepEqual(errors, []);
  await context.close();
});
