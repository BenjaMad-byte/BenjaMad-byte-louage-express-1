import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, launchBrowser, newContext, watchErrors, axeViolations, registerViaApi, ADMIN_TOKEN } from "./_harness.js";

let env, browser, skip, docsRef;
const GOVS = ["Gafsa", "Sousse", "Médenine", "Tunis", "Sfax"];
const TYPES = ["regional", "interregional", "rural", "national"];
const STATUSES = ["pending", "pending", "pending", "interview", "approved", "rejected"];
const KYC = ["review", "verified", "review", null, "error", "queued"];

before(async () => {
  env = await startApp();
  ({ browser, skip } = await launchBrowser());
  docsRef = await registerViaApi(env, { phone: "98800000", cin: "08000000", name: "Zied Avec Documents", governorate: "Gafsa", line: { type: "regional", from: "Redeyef", to: "Gafsa" } });
  // 60 dossiers répartis entre 5 gouvernorats, 4 types de ligne, statuts et états d'identité variés
  const insApp = env.db.prepare(
    `INSERT INTO applications (ref, full_name, phone, cin, role, plate, governorate, station, route, line_type, line_from, line_to_gov, consent_at, status, created_at)
     VALUES (?,?,?,?, 'driver', '111 TUN 1', ?, 'Gare', ?, ?, 'Ville', ?, ?, ?, ?)`
  );
  const insKyc = env.db.prepare("INSERT INTO kyc_checks (application_id, status) VALUES (?, ?)");
  for (let i = 0; i < 60; i++) {
    const gov = GOVS[i % GOVS.length];
    const type = TYPES[i % TYPES.length];
    const at = new Date(Date.UTC(2026, 9, 1, 8) + i * 5 * 3600e3).toISOString();
    const info = insApp.run(`LX-ADM${String(i).padStart(3, "0")}X`, `Chauffeur ${String(i).padStart(2, "0")}`, `2${1000000 + i}`, `9${1000000 + i}`, gov, `Ville → ${gov}`, type, type === "national" ? null : gov, at, STATUSES[i % 6], at);
    if (KYC[i % 6]) insKyc.run(Number(info.lastInsertRowid), KYC[i % 6]);
  }
});
after(async () => {
  await browser?.close();
  env.stop();
});

async function login(page, token = ADMIN_TOKEN) {
  await page.goto(env.base + "/admin");
  await page.fill("#token", token);
  await page.getByRole("button", { name: "Se connecter" }).click();
}
const rows = (page) => page.locator("#apps tbody tr");
const summary = (page) => page.locator("#apps-summary");
const chip = (page, label) => page.locator("#status-chips .chip", { hasText: label });
/** Exécute une action et attend la réponse de la liste des dossiers qu'elle déclenche (pas d'attente aveugle). */
const afterList = (page, action) =>
  Promise.all([page.waitForResponse((r) => r.url().includes("/api/admin/applications") && r.request().method() === "GET"), action()]);

test("connexion : un mauvais jeton est refusé, le bon ouvre la console, la déconnexion la referme", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await login(page, "pas-le-bon-jeton");
  await page.locator("#gate-err:not(:empty)").waitFor();
  assert.equal(await page.locator("#gate-err").textContent(), "Jeton invalide.");
  assert.equal(await page.locator("#app").isHidden(), true);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("admin_token")), null, "un mauvais jeton n'est jamais mémorisé");

  await login(page);
  await page.locator("#app").waitFor();
  assert.ok((await rows(page).count()) > 0);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("admin_token")), ADMIN_TOKEN);

  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await page.locator("#gate").waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem("admin_token")), null);
  assert.equal(await page.locator("#app").isHidden(), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("trop d'essais ratés : message clair, et même le bon jeton est refusé quelques minutes", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const limited = await startApp({ rateLimits: true });
  try {
    const context = await newContext(browser, { viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    for (let i = 0; i < 10; i++) assert.equal((await page.request.get(`${limited.base}/api/admin/applications`, { headers: { Authorization: `Bearer faux-${i}` } })).status(), 401);
    await page.goto(limited.base + "/admin");
    await page.fill("#token", ADMIN_TOKEN);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.locator("#gate-err:not(:empty)").waitFor();
    assert.equal(await page.locator("#gate-err").textContent(), "Trop d'essais. Réessayez dans 15 minutes.");
    await context.close();
  } finally {
    limited.stop();
  }
});

test("filtres, compteurs, recherche, tri et pagination de la liste des dossiers", { timeout: 120_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await login(page);
  await page.locator("#apps tbody tr").first().waitFor();
  const total = 61; // 60 dossiers préparés + 1 avec documents

  assert.match(await summary(page).textContent(), new RegExp(`^${total} dossiers`));
  assert.equal(await rows(page).count(), 50, "50 dossiers par page");
  assert.equal(await page.locator("#pg-info").textContent(), "Page 1 sur 2");
  assert.equal(await page.locator("#f-reset").isHidden(), true, "rien à réinitialiser sans filtre");

  await page.locator("#pg-next").click();
  await page.waitForFunction(() => document.getElementById("pg-info").textContent === "Page 2 sur 2");
  assert.equal(await rows(page).count(), 11);
  await page.locator("#pg-prev").click();
  await page.waitForFunction(() => document.getElementById("pg-info").textContent === "Page 1 sur 2");

  // Pastille « En attente » : la liste ne montre que ces dossiers et les compteurs restent justes
  await chip(page, "En attente").click();
  await page.waitForFunction(() => document.querySelectorAll("#apps tbody tr").length < 50);
  const pending = await rows(page).count();
  assert.equal(await chip(page, "En attente").getAttribute("aria-pressed"), "true");
  assert.ok(pending > 25);
  assert.equal(await rows(page).locator("td:nth-child(6) .badge.pending").count(), pending, "tous les dossiers listés sont « en attente »");

  // + gouvernorat + identité : filtres cumulés
  await afterList(page, () => page.selectOption("#f-gov", "Gafsa"));
  const gafsaPending = await rows(page).count();
  assert.ok(gafsaPending > 0 && gafsaPending < pending);
  const govs = await rows(page).locator("td:nth-child(4)").allTextContents();
  assert.ok(govs.every((g) => g === "Gafsa"));
  await afterList(page, () => page.selectOption("#f-kyc", "review"));
  const kycBadges = await rows(page).locator("td:nth-child(7) .badge").allTextContents();
  assert.ok(kycBadges.length > 0 && kycBadges.every((b) => b === "À examiner"));
  assert.match(await summary(page).textContent(), /avec 3 filtres/);

  // Réinitialiser
  await page.locator("#f-reset").click();
  await page.waitForFunction(() => /^61 dossiers$/.test(document.getElementById("apps-summary").textContent));
  assert.equal(await page.locator("#f-gov").inputValue(), "");

  // Recherche par CIN, puis tri par nom
  await page.fill("#f-q", "91000007");
  await page.waitForFunction(() => document.querySelectorAll("#apps tbody tr").length === 1);
  assert.equal((await rows(page).first().locator("td").nth(1).textContent()).trim(), "Chauffeur 07");
  await page.fill("#f-q", "");
  await afterList(page, () => page.selectOption("#f-sort", "name"));
  const names = await rows(page).locator("td:nth-child(2)").allTextContents();
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" })));

  // Une combinaison sans résultat annonce clairement qu'il n'y a rien
  await afterList(page, () => page.selectOption("#f-gov", "Sfax"));
  await afterList(page, () => page.selectOption("#f-line", "national"));
  await afterList(page, () => chip(page, "Accepté").click());
  if ((await rows(page).count()) === 0) assert.equal(await page.locator("#apps-empty").isVisible(), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("traiter les dossiers : naviguer, « enregistrer et passer au suivant », le dossier traité quitte la liste", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await login(page);
  await chip(page, "En attente").click();
  await page.waitForFunction(() => document.querySelectorAll("#apps tbody tr").length < 50);
  const pendingBefore = Number((await chip(page, "En attente").locator(".chip-n").textContent()).trim());

  const firstRef = await rows(page).nth(0).getAttribute("data-ref");
  const secondRef = await rows(page).nth(1).getAttribute("data-ref");
  const secondName = (await rows(page).nth(1).locator("td").nth(1).textContent()).trim();
  await rows(page).nth(0).click();
  await page.locator("#detail h2").waitFor();
  assert.match(await page.locator(".detail-nav .note").textContent(), new RegExp(`^Dossier 1 sur ${pendingBefore}`));
  assert.equal(await page.getByRole("button", { name: "← Précédent" }).last().isDisabled(), true, "pas de dossier avant le premier");

  await page.getByRole("button", { name: "Suivant →" }).last().click();
  await page.waitForFunction((n) => document.querySelector("#detail h2")?.textContent === n, secondName);
  await page.getByRole("button", { name: "← Précédent" }).last().click();
  await page.waitForFunction((n) => document.querySelector(".detail-nav .note")?.textContent.startsWith("Dossier 1 sur"), null);

  await page.selectOption("#d-status", "interview");
  await page.fill("#d-public", "Merci de réserver un entretien.");
  await page.getByRole("button", { name: "Enregistrer et passer au suivant" }).click();
  await page.waitForFunction((n) => document.querySelector("#detail h2")?.textContent === n, secondName);

  const saved = env.db.prepare("SELECT status, public_note FROM applications WHERE ref = ?").get(firstRef);
  assert.deepEqual({ ...saved }, { status: "interview", public_note: "Merci de réserver un entretien." });
  assert.equal(await rows(page).locator(`xpath=self::*[@data-ref="${firstRef}"]`).count(), 0, "le dossier traité n'est plus dans la liste « en attente »");
  assert.equal(await rows(page).locator(`xpath=self::*[@data-ref="${secondRef}"]`).count(), 1);
  assert.equal(Number((await chip(page, "En attente").locator(".chip-n").textContent()).trim()), pendingBefore - 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test("pièces d'un dossier : ouvertes en clair dans le navigateur alors qu'elles sont chiffrées sur le disque ; leur consultation est tracée", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await login(page);
  await page.fill("#f-q", "98800000");
  await page.waitForFunction(() => document.querySelectorAll("#apps tbody tr").length === 1);
  await rows(page).first().click();
  await page.locator("#detail h2").waitFor();
  const dossier = await page.locator("#detail").innerText();
  assert.ok(dossier.includes("Redeyef → Gafsa") && dossier.includes("Zied Avec Documents"));
  for (const label of ["CIN recto", "CIN verso", "Permis", "Selfie 1", "Selfie 2"]) assert.equal(await page.getByRole("button", { name: label }).count(), 1, label);

  const [popup] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "CIN recto" }).click()]);
  await popup.waitForLoadState();
  assert.match(popup.url(), /^blob:/);
  assert.equal(await popup.evaluate(() => document.contentType), "image/png", "le fichier déchiffré s'affiche comme une image");
  await popup.close();

  const audit = await (await fetch(`${env.base}/api/admin/audit?limit=30`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).json();
  assert.ok(audit.entries.some((e) => e.action === "file_view" && e.ref === docsRef), "consultation de la pièce journalisée");
  assert.ok(audit.entries.some((e) => e.action === "application_view" && e.ref === docsRef));
  await context.close();
});

test("onglet « Réseau par gouvernorat » : les 24 gouvernorats, les lignes déclarées par type", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await login(page);
  await page.getByRole("tab", { name: "Réseau par gouvernorat" }).click();
  await page.locator("#net tbody tr").first().waitFor();
  assert.equal(await page.locator("#net tbody tr").count(), 24);
  const gafsa = page.locator("#net tbody tr", { has: page.locator("td:first-child", { hasText: /^Gafsa$/ }) });
  assert.ok((await gafsa.innerText()).includes("Redeyef (الرديف) → Gafsa"), "la ligne déclarée par le chauffeur apparaît, avec son nom officiel en arabe");
  assert.equal(await page.locator("#net thead th").allTextContents().then((h) => h.join("|")), "Gouvernorat de départ|Chauffeurs|Lignes régionales|Lignes interrégionales|Louages nationaux|Lignes rurales");
  await context.close();
});

test("console : accessibilité (axe) sans faille sérieuse, et utilisable sur un écran de téléphone", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const problems = [];
  for (const [colorScheme, viewport] of [["light", { width: 1280, height: 900 }], ["dark", { width: 375, height: 812 }]]) {
    const context = await newContext(browser, { colorScheme, viewport });
    const page = await context.newPage();
    await login(page);
    await page.locator("#apps tbody tr").first().waitFor();
    await rows(page).first().click();
    await page.locator("#detail h2").waitFor();
    for (const v of await axeViolations(page)) problems.push(`${colorScheme} @${viewport.width} : ${v.impact} « ${v.id} » (${v.nodes.join(", ")})`);
    if (viewport.width < 600) {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      assert.equal(overflow, false, "la console ne déborde pas sur téléphone (le tableau défile dans son cadre)");
    }
    await context.close();
  }
  assert.deepEqual(problems, []);
});

test("fin de collaboration : la case enregistre la date, se décoche, et ne s'applique qu'à un chauffeur accepté", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await login(page);
  await page.fill("#f-q", "98800000");
  await page.waitForFunction(() => document.querySelectorAll("#apps tbody tr").length === 1);
  await rows(page).first().click();
  await page.locator("#detail h2").waitFor();
  const ended = () => env.db.prepare("SELECT status, ended_at, decided_at FROM applications WHERE ref = ?").get(docsRef);
  const save = () => page.getByRole("button", { name: "Enregistrer", exact: true }).click();

  await page.selectOption("#d-status", "approved");
  await page.locator("#d-ended").check();
  await save();
  await page.locator("#detail .note", { hasText: "Enregistré." }).waitFor();
  assert.ok(ended().ended_at && ended().decided_at && ended().status === "approved");

  await page.locator("#d-ended").uncheck();
  await save();
  await page.waitForTimeout(300);
  assert.equal(ended().ended_at, null);

  await page.locator("#d-ended").check();
  await page.selectOption("#d-status", "rejected");
  await save();
  await page.waitForTimeout(300);
  assert.equal(ended().ended_at, null, "refusé : jamais « collaboration terminée »");
  assert.deepEqual(errors, []);
  await context.close();
});
