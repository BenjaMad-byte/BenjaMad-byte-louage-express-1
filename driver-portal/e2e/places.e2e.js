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

const options = (page) => page.locator("#line-from-list option").evaluateAll((os) => os.map((o) => o.value));

test("suggestions de villes : celles du gouvernorat de la station, dans la langue de l'interface, chef-lieu en premier", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "fr" });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(env.base + "/register");
  assert.deepEqual(await options(page), [], "pas de gouvernorat choisi : pas de suggestion");

  await page.selectOption("#governorate", "Gafsa");
  const gafsa = await options(page);
  assert.equal(gafsa.length, 12, "11 délégations + le chef-lieu");
  assert.equal(gafsa[0], "Gafsa");
  for (const city of ["Redeyef", "Metlaoui", "Oum El Araies", "Belkhir"]) assert.ok(gafsa.includes(city), city);
  assert.ok(!gafsa.includes("Nefta"), "Nefta est à Tozeur");

  await page.selectOption("#governorate", "Tozeur");
  const tozeur = await options(page);
  assert.ok(tozeur.includes("Nefta") && !tozeur.includes("Redeyef"));
  assert.equal(await page.locator("#line_from").getAttribute("list"), "line-from-list");

  // le changement de langue traduit les suggestions sans perdre le gouvernorat
  await page.locator("button.lang").click();
  const arabic = await options(page);
  assert.ok(arabic.includes("نفطة") && arabic[0] === "توزر", "chef-lieu arabe en premier");
  assert.ok(arabic.every((n) => /[؀-ۿ]/.test(n)), "toutes en arabe");
  assert.equal(await page.inputValue("#governorate"), "Tozeur");
  assert.deepEqual(errors, []);
  await context.close();
});

test("version arabe : les suggestions sont en arabe et le texte d'aide est traduit", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "ar" });
  const page = await context.newPage();
  await page.goto(env.base + "/register");
  await page.selectOption("#governorate", "Gafsa");
  const list = await options(page);
  assert.ok(list.includes("الرديف") && list.includes("المتلوي") && list.includes("أم العرائس"));
  assert.equal(list[0], "قفصة");
  assert.equal(await page.locator('#line_from ~ .hint, label[for=line_from] ~ .hint').first().textContent(), T.ar.f_line_from_hint);
  await context.close();
});

test("les suggestions reviennent avec le brouillon restauré", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "fr" });
  const page = await context.newPage();
  await page.goto(env.base + "/register");
  await page.selectOption("#governorate", "Gafsa");
  await page.fill("#full_name", "Ali");
  await page.waitForFunction(() => localStorage.getItem("lx_draft_v1") !== null);
  await page.waitForTimeout(600);
  await page.reload();
  assert.equal((await options(page))[0], "Gafsa");
  await context.close();
});

test("réseau : « الرديف », « Redeyef » et « redeyef » forment une seule ligne, affichée avec les deux noms ; une ville inconnue est signalée", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const line = (from) => ({ type: "regional", from, to: "Gafsa" });
  await registerViaApi(env, { phone: "98500001", cin: "05000001", governorate: "Gafsa", line: line("الرديف") });
  await registerViaApi(env, { phone: "98500002", cin: "05000002", governorate: "Gafsa", line: line("redeyef") });
  await registerViaApi(env, { phone: "98500003", cin: "05000003", governorate: "Gafsa", line: line("Redeyef") });
  await registerViaApi(env, { phone: "98500004", cin: "05000004", governorate: "Gafsa", line: line("Rdayef") });
  await registerViaApi(env, { phone: "98500005", cin: "05000005", governorate: "Gafsa", line: line("Quartier Zéro") });

  const api = await (await fetch(`${env.base}/api/admin/network`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).json();
  const regional = api.governorates.find((g) => g.governorate === "Gafsa").regional;
  assert.equal(regional.length, 2);
  assert.deepEqual([regional[0].from, regional[0].from_ar, regional[0].recognized, regional[0].drivers], ["Redeyef", "الرديف", true, 4]);
  assert.deepEqual([regional[1].from, regional[1].recognized, regional[1].drivers], ["Quartier Zéro", false, 1]);

  // et dans la console
  const context = await newContext(browser, { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(env.base + "/admin");
  await page.fill("#token", ADMIN_TOKEN);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.getByRole("tab", { name: "Réseau par gouvernorat" }).click();
  const row = page.locator("#net tbody tr", { has: page.locator("td:first-child", { hasText: /^Gafsa$/ }) });
  await row.waitFor();
  const text = await row.innerText();
  assert.ok(text.includes("Redeyef (الرديف) → Gafsa"), text);
  assert.ok(text.includes("4 chauffeurs"));
  assert.equal(await row.locator(".tag.warn").count(), 1, "seule la ville inconnue porte le repère");
  assert.match(await page.locator("#net-note").textContent(), /1 ville de départ non reconnue/);
  const csv = await (await fetch(`${env.base}/api/admin/network.csv`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).text();
  assert.ok(csv.includes("Gafsa,regional,Redeyef,Gafsa,4,0,,0,0,الرديف,oui"));
  await context.close();
});

test("dossier : la ligne affichée utilise le nom officiel, la saisie du chauffeur est conservée", { timeout: 60_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const ref = await registerViaApi(env, { phone: "98500006", cin: "05000006", governorate: "Gafsa", line: { type: "regional", from: "المتلوي", to: "Gafsa" } });
  const row = env.db.prepare("SELECT route, line_from FROM applications WHERE ref = ?").get(ref);
  assert.equal(row.route, "Metlaoui → Gafsa");
  assert.equal(row.line_from, "المتلوي");
});
