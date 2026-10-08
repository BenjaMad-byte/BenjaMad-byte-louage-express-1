import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, launchBrowser, newContext, watchErrors, registerViaApi, ADMIN_TOKEN, T } from "./_harness.js";

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
const adminPatch = (ref, body) =>
  fetch(`${env.base}/api/admin/applications/${ref}`, { method: "PATCH", headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function checkStatus(page, ref, phone) {
  await page.fill("#ref", ref);
  await page.fill("#phone", phone);
  await page.getByRole("button", { name: F.st_check }).click();
}

test("suivi : « en cours d'étude », puis « accepté » avec le message de l'équipe", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const ref = await registerViaApi(env, { phone: "98700001", cin: "07000001" });
  const context = await newContext(browser, { lang: "fr" });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(env.base + "/status");
  await checkStatus(page, ref.toLowerCase(), "98 700 001"); // minuscules et espaces tolérés
  await page.locator("#result").waitFor();
  assert.equal(await page.locator("#badge").textContent(), F.st_pending);
  assert.equal(await page.locator("#detail").textContent(), F.st_pending_d);
  assert.equal(await page.locator("#note-box").isHidden(), true);

  assert.equal((await adminPatch(ref, { status: "approved", public_note: "Bienvenue chez Louage Express" })).status, 200);
  await page.getByRole("button", { name: F.st_check }).click();
  await page.waitForFunction((txt) => document.getElementById("badge").textContent === txt, F.st_approved);
  assert.equal(await page.locator("#note").textContent(), "Bienvenue chez Louage Express");
  assert.equal(await page.locator("#book").isHidden(), true);

  // La décision finale supprime les selfies (données biométriques) : vérifié côté serveur
  const kinds = env.db.prepare("SELECT f.kind FROM files f JOIN applications a ON a.id = f.application_id WHERE a.ref = ?").all(ref).map((r) => r.kind).sort();
  assert.deepEqual(kinds, ["cin_back", "cin_front", "permis"]);

  // Le changement de langue re-traduit le résultat affiché
  await page.locator("button.lang").click();
  await page.waitForFunction((txt) => document.getElementById("badge").textContent === txt, T.ar.st_approved);
  assert.deepEqual(errors, []);
  await context.close();
});

test("suivi : mauvais téléphone ou référence inconnue → même message « introuvable » (aucune fuite)", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const ref = await registerViaApi(env, { phone: "98700002", cin: "07000002" });
  const context = await newContext(browser, { lang: "fr" });
  const page = await context.newPage();
  await page.goto(env.base + "/status");
  const messages = [];
  for (const [r, p] of [[ref, "55000000"], ["LX-ZZZZZZZZ", "98700002"]]) {
    await checkStatus(page, r, p);
    await page.locator("#banner:not([hidden])").waitFor();
    messages.push(await page.locator("#banner").textContent());
    assert.equal(await page.locator("#result").isHidden(), true);
  }
  assert.equal(messages[0], F.e_not_found);
  assert.equal(messages[0], messages[1], "le message ne révèle pas si c'est la référence ou le téléphone qui est faux");
  await context.close();
});

test("confidentialité : ni le téléphone ni la référence n'apparaissent dans une URL (adresse de la page ou requêtes)", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const ref = await registerViaApi(env, { phone: "98700003", cin: "07000003" });
  const context = await newContext(browser, { lang: "fr" });
  const page = await context.newPage();
  const urls = [];
  page.on("request", (r) => urls.push(r.url()));
  await page.goto(env.base + "/status");
  await checkStatus(page, ref, "98700003");
  await page.locator("#result").waitFor();
  assert.ok(urls.some((u) => u.endsWith("/api/status")), "la requête de suivi a bien eu lieu");
  for (const u of [page.url(), ...urls]) {
    assert.ok(!u.includes(ref) && !u.includes("98700003") && !u.includes("?"), `donnée personnelle dans l'URL : ${u}`);
  }
  await context.close();
});

test("entretien : réserver un créneau, le retrouver dans le suivi, et le créneau n'est plus proposé", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const ref = await registerViaApi(env, { phone: "98700004", cin: "07000004" });
  await adminPatch(ref, { status: "interview" });
  const context = await newContext(browser, { lang: "fr" });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(env.base + "/interview");
  await page.locator(".slot").first().waitFor();

  // Sans créneau choisi : message clair
  await page.getByRole("button", { name: F.iv_book }).click();
  assert.equal(await page.locator('[data-err="slot"]').textContent(), F.iv_pick_first);

  const first = page.locator(".slot").first();
  const day = await page.locator(".day").first().locator("h3").textContent();
  const time = (await first.textContent()).trim();
  await first.click();
  assert.equal(await first.getAttribute("aria-pressed"), "true");
  await page.fill("#name", "Chauffeur Test");
  await page.fill("#phone", "98700004");
  await page.fill("#ref", ref);
  await page.fill("#question", "Quels documents apporter ?");
  await page.getByRole("button", { name: F.iv_book }).click();
  await page.locator("#done-view").waitFor();
  const link = await page.locator("#done-link").getAttribute("href");
  assert.match(link, /^https:\/\/meet\.jit\.si\/LouageExpress-[0-9a-f]{18}$/, "salon de visio unique et non devinable");
  assert.ok((await page.locator("#done-when").textContent()).includes(time));

  const booked = env.db.prepare("SELECT * FROM interviews WHERE phone = ?").get("98700004");
  assert.equal(booked.question, "Quels documents apporter ?");
  assert.equal(booked.room_url, link);

  // Le créneau pris n'est plus proposé à quelqu'un d'autre
  await page.goto(env.base + "/interview");
  await page.locator(".slot").first().waitFor();
  const stillThere = await page.locator(".day").first().locator(".slot", { hasText: time }).count();
  const sameDay = (await page.locator(".day").first().locator("h3").textContent()) === day;
  assert.ok(!(sameDay && stillThere), "le créneau réservé a disparu de la liste");

  // Le chauffeur le retrouve dans la page de suivi
  await page.goto(env.base + "/status");
  await checkStatus(page, ref, "98700004");
  await page.locator("#iv-box:not([hidden])").waitFor();
  assert.equal(await page.locator("#iv-link").getAttribute("href"), link);
  assert.deepEqual(errors, []);
  await context.close();
});
