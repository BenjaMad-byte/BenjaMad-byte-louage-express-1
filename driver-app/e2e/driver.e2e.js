import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, launchBrowser, newContext, watchErrors, axeViolations, hasHorizontalOverflow, loginViaUi, portalDriver, T } from "./_harness.js";

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
const seatsText = (page) => page.locator("#seats").innerText();
const netText = (page) => page.locator("#net").innerText();
const dbBoardings = () => env.db.prepare("SELECT status FROM boardings WHERE status = 'onboard'").all().length;
/** Le service worker doit être actif avant de couper le réseau, sinon l'ouverture hors ligne est impossible. */
const swReady = (page) => page.evaluate(() => navigator.serviceWorker.ready.then(() => true));

test("connexion : lien d'activation reçu par SMS, mot de passe choisi, puis l'écran d'accueil du chauffeur avec son nom, sa plaque et sa ligne", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const d = portalDriver();
  const context = await newContext(browser);
  const page = await context.newPage();
  const errors = watchErrors(page);
  await loginViaUi(page, env, d);
  const text = await page.locator("main").innerText();
  assert.ok(text.includes(d.full_name) && text.includes(d.plate) && text.includes("Redeyef → Gafsa"), text);
  assert.equal(await page.locator("[data-screen]").getAttribute("data-screen"), "home");
  assert.ok((await page.locator("#join").innerText()).toLowerCase().includes("entrer dans la file"));
  assert.deepEqual(errors, []);
  await context.close();
});

test("connexion refusée : mauvais mot de passe, matricule inconnu, chauffeur pas encore activé — messages clairs, pas d'accès", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const d = portalDriver();
  env.portal.drivers.set(d.ref, d);
  await env.app.locals.auth.syncApproved();
  const link = env.sms.lastLink(d.phone);
  const context = await newContext(browser);
  const page = await context.newPage();
  // Le chauffeur active son compte une première fois (écran d'activation : toujours en arabe, pas de bascule de langue ici)...
  await page.goto(link.startsWith("http") ? link : env.base + link);
  await page.fill("#newpw", "chauffeur-demo-2026");
  await page.getByRole("button", { name: T.ar.activation_go }).click();
  await page.locator("[data-screen]").waitFor();
  await page.getByRole("button", { name: T.ar.lang_other }).click(); // passe en français pour la suite du test
  await page.waitForFunction((dir) => document.documentElement.dir === dir, "ltr");
  await page.getByRole("button", { name: F.logout }).click();

  // ... puis se trompe de mot de passe.
  await page.locator("#plate").waitFor();
  await page.fill("#plate", d.plate);
  await page.fill("#password", "mot-de-passe-faux");
  await page.getByRole("button", { name: F.login_go }).click();
  await page.locator(".err").waitFor();
  assert.equal(await page.locator(".err").innerText(), F.e_invalid_credentials);

  // Matricule inconnu : même message (le matricule n'est pas secret, inutile de distinguer).
  await page.fill("#plate", "000 TUN 0000");
  await page.fill("#password", "n'importe quoi ici");
  await page.getByRole("button", { name: F.login_go }).click();
  await page.locator(".err").waitFor();
  assert.equal(await page.locator(".err").innerText(), F.e_invalid_credentials);

  // Chauffeur accepté mais pas encore activé : message distinct, qui renvoie au SMS.
  const notYet = portalDriver();
  env.portal.drivers.set(notYet.ref, notYet);
  await env.app.locals.auth.syncApproved();
  await page.fill("#plate", notYet.plate);
  await page.fill("#password", "n'importe quoi ici");
  await page.getByRole("button", { name: F.login_go }).click();
  await page.locator(".err").waitFor();
  assert.equal(await page.locator(".err").innerText(), F.e_not_activated);
  assert.equal(await page.locator("[data-screen]").count(), 0);
  await context.close();
});

test("HORS LIGNE : on entre dans la file, on déclare des passagers sans réseau, on recharge l'application sans réseau, puis tout se synchronise", { timeout: 120_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const d = portalDriver();
  const context = await newContext(browser);
  const page = await context.newPage();
  const errors = watchErrors(page);
  await loginViaUi(page, env, d);
  await swReady(page);
  await page.locator("#join").click();
  await page.locator("#rank").waitFor();
  await page.waitForFunction(() => document.querySelector("#rank")?.innerText.includes("#1"));
  assert.ok((await netText(page)).includes(F.net_online));

  // Coupure réseau : l'application continue de fonctionner.
  await context.setOffline(true);
  await page.waitForFunction((txt) => document.querySelector("#net")?.innerText.includes(txt), F.net_offline);
  for (let i = 1; i <= 3; i++) {
    await page.locator("#board").click();
    await page.waitForFunction((n) => document.querySelector("#seats")?.innerText.startsWith(`${n} /`), i);
  }
  assert.equal(await seatsText(page), "3 / 8");
  assert.ok((await netText(page)).includes(F.net_pending.replace("{n}", "3")), await netText(page));
  assert.equal(dbBoardings(), 0, "le serveur ne sait encore rien");

  // Rechargement SANS réseau (service worker + IndexedDB) : l'application s'ouvre et les 3 passagers sont toujours là.
  await page.reload();
  await page.locator("#seats").waitFor();
  assert.equal(await seatsText(page), "3 / 8");
  assert.ok((await netText(page)).includes(F.net_offline));

  // Retour du réseau : synchronisation automatique.
  await context.setOffline(false);
  await page.waitForFunction(() => window.__lx.pending === 0, null, { timeout: 30_000 });
  assert.equal(dbBoardings(), 3);
  assert.equal(await seatsText(page), "3 / 8");
  assert.ok((await netText(page)).includes(F.net_online));
  assert.deepEqual(errors, []);
  await context.close();
});

test("le téléphone refuse tout de suite le passager en trop (louage plein) et n'envoie rien", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser);
  const page = await context.newPage();
  await loginViaUi(page, env, portalDriver());
  await page.locator("#cap").selectOption("2");
  await page.waitForFunction(() => window.__lx.view.driver.capacity === 2);
  await page.locator("#join").click();
  await page.locator("#board").waitFor();
  await page.locator("#board").click();
  await page.locator("#board").click();
  await page.waitForFunction(() => document.querySelector("#seats")?.innerText.startsWith("2 /"));
  await page.locator("#board").click();
  await page.locator("#toast:not([hidden])").waitFor();
  assert.equal(await page.locator("#toast").innerText(), F.r_seat_full_conflict);
  assert.equal(await seatsText(page), "2 / 2");
  assert.ok((await page.locator(".badge.full").innerText()).length > 0);
  await page.waitForFunction(() => window.__lx.pending === 0);
  await context.close();
});

test("départ et arrivée : confirmation par double appui, descente automatique au terminus, retour à l'accueil", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser);
  const page = await context.newPage();
  await loginViaUi(page, env, portalDriver());
  await page.locator("#join").click();
  await page.locator("#board").click();
  await page.waitForFunction(() => document.querySelector("#seats")?.innerText.startsWith("1 /"));
  const depart = page.getByRole("button", { name: F.depart });
  await depart.click();
  assert.equal(await page.locator("[data-screen]").getAttribute("data-screen"), "queue", "un seul appui ne suffit pas");
  await page.getByRole("button", { name: F.press_again }).first().click();
  await page.waitForFunction(() => document.querySelector("[data-screen]")?.dataset.screen === "route");
  await page.getByRole("button", { name: F.arrived_at.replace("{stop}", "Metlaoui") }).click();
  await page.getByRole("button", { name: F.arrived_at.replace("{stop}", "Gafsa") }).click();
  await page.waitForFunction(() => document.querySelector("#seats")?.innerText.startsWith("0 /"));
  await page.getByRole("button", { name: F.finish_trip }).click();
  await page.getByRole("button", { name: F.press_again }).click();
  await page.waitForFunction(() => document.querySelector("[data-screen]")?.dataset.screen === "home");
  await page.waitForFunction(() => window.__lx.pending === 0);
  await context.close();
});

test("SOS : 3 appuis rapides = alerte enregistrée avec la position, SMS à la permanence ; annulation possible", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  env.db.exec("DELETE FROM sos_events");
  env.sms.sent.length = 0;
  const context = await newContext(browser);
  const page = await context.newPage();
  await loginViaUi(page, env, portalDriver());
  await page.locator("#sos").click();
  await page.locator("#sos").click();
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM sos_events").get().n, 0, "deux appuis ne déclenchent rien");
  await page.locator("#sos").click();
  await page.locator(".sos-overlay").waitFor();
  await page.waitForFunction((txt) => document.querySelector(".sos-overlay h2")?.innerText === txt, F.sos_sent, { timeout: 15_000 });
  await env.app.locals.sos.flush();
  const ev = env.db.prepare("SELECT * FROM sos_events").get();
  assert.deepEqual([ev.trigger, ev.status, Math.round(ev.lat * 100) / 100, Math.round(ev.lon * 100) / 100], ["triple_tap", "open", 34.37, 8.16]);
  assert.ok(env.sms.sent.some((s) => s.phone === "97000111" && s.text.startsWith("SOS LOUAGE")));
  const calls = await page.locator(".sos-overlay a.btn.call").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  assert.deepEqual(calls, ["tel:197", "tel:198", "tel:190"]);

  await page.getByRole("button", { name: F.sos_cancel }).click();
  await page.waitForFunction(() => !document.querySelector(".sos-overlay"));
  await page.waitForFunction(() => window.__lx.pending === 0);
  assert.equal(env.db.prepare("SELECT status FROM sos_events").get().status, "cancelled");
  await context.close();
});

test("SOS HORS LIGNE : enregistré sur l'appareil, numéros d'appel affichés, envoyé tout seul au retour du réseau", { timeout: 120_000 }, async (t) => {
  if (skip) return t.skip(skip);
  env.db.exec("DELETE FROM sos_events");
  const context = await newContext(browser);
  const page = await context.newPage();
  await loginViaUi(page, env, portalDriver());
  await swReady(page);
  await context.setOffline(true);
  for (let i = 0; i < 3; i++) await page.locator("#sos").click();
  await page.locator(".sos-overlay").waitFor();
  await page.waitForFunction((txt) => document.querySelector(".sos-overlay h2")?.innerText === txt, F.sos_queued, { timeout: 15_000 });
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM sos_events").get().n, 0);
  assert.equal(await page.locator(".sos-overlay a.btn.call").count(), 3, "le chauffeur peut appeler même sans application réseau");
  await context.setOffline(false);
  await page.waitForFunction((txt) => document.querySelector(".sos-overlay h2")?.innerText === txt, F.sos_sent, { timeout: 30_000 });
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM sos_events").get().n, 1);
  await context.close();
});

test("compte retiré par le site d'inscription : au prochain envoi l'application revient à la connexion, sans rien perdre sur l'appareil", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const d = portalDriver();
  const context = await newContext(browser);
  const page = await context.newPage();
  await loginViaUi(page, env, d);
  await page.locator("#join").click();
  await page.locator("#board").waitFor();
  env.portal.drivers.delete(d.ref);
  await env.app.locals.auth.syncApproved();
  // La révocation du côté serveur et le réaffichage local (optimiste, puis « session fermée ») peuvent retomber au même instant :
  // l'écran se redessine sous ce clic. Un clic forcé évite d'attendre une cible « stable » qui, ici, ne l'est jamais vraiment.
  await page.locator("#board").click({ force: true });
  await page.locator("#plate").waitFor({ timeout: 20_000 });
  assert.ok((await page.locator("#toast").innerText()).includes(F.session_lost));
  assert.equal(await page.evaluate(async () => (await new Promise((res) => { const r = indexedDB.open("lx-driver"); r.onsuccess = () => { const q = r.result.transaction("outbox").objectStore("outbox").count(); q.onsuccess = () => res(q.result); }; })) > 0), true, "l'action reste sur l'appareil");
  await context.close();
});

test("autre chauffeur sur le même appareil : les actions en attente de l'ancien ne partent jamais sous le nouveau compte", { timeout: 120_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const first = portalDriver();
  const second = portalDriver();
  const context = await newContext(browser);
  const page = await context.newPage();
  await loginViaUi(page, env, first);
  await swReady(page);
  await page.locator("#join").click();
  await page.locator("#board").waitFor();
  await context.setOffline(true);
  await page.locator("#board").click();
  await page.waitForFunction(() => window.__lx.pending === 1);
  await page.evaluate(() => { window.confirm = () => true; });
  await page.getByRole("button", { name: F.logout }).click();
  await context.setOffline(false);
  await page.locator("#plate").waitFor();
  await loginViaUi(page, env, second);
  assert.equal(await page.locator("[data-screen]").getAttribute("data-screen"), "home", "le second chauffeur n'hérite ni du voyage ni des passagers");
  const secondId = env.db.prepare("SELECT id FROM drivers WHERE phone = ?").get(second.phone).id;
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM boardings b JOIN trips t ON t.id = b.trip_id WHERE t.driver_id = ?").get(secondId).n, 0);
  await context.close();
});

for (const [lang, scheme] of [["fr", "light"], ["ar", "dark"]]) {
  test(`écrans en ${lang === "fr" ? "français" : "arabe (RTL)"}, thème ${scheme === "light" ? "clair" : "sombre"} : pas de débordement, accessibilité (axe) sans faille sérieuse, boutons assez grands`, { timeout: 120_000 }, async (t) => {
    if (skip) return t.skip(skip);
    const context = await newContext(browser, { lang, colorScheme: scheme, viewport: { width: 360, height: 740 } });
    const page = await context.newPage();
    const errors = watchErrors(page);
    const problems = [];
    await page.goto(env.base + "/");
    await page.locator("#plate").waitFor();
    if (lang === "fr") await page.getByRole("button", { name: T.ar.lang_other }).click();
    await page.waitForFunction((dir) => document.documentElement.dir === dir, lang === "fr" ? "ltr" : "rtl");
    for (const v of await axeViolations(page)) problems.push(`connexion : ${v.id} (${v.nodes.join(", ")})`);
    await page.close();

    const p2 = await context.newPage();
    await loginViaUi(p2, env, portalDriver(), lang);
    for (const screen of ["home", "queue", "route"]) {
      if (screen === "queue") { await p2.locator("#join").click(); await p2.locator("#board").waitFor(); await p2.locator("#board").click(); await p2.waitForFunction(() => document.querySelector("#seats")?.innerText.startsWith("1 /")); }
      if (screen === "route") { await p2.evaluate(() => window.__lx.act("depart")); await p2.locator("#arrive").waitFor(); }
      assert.equal(await p2.locator("[data-screen]").getAttribute("data-screen"), screen);
      if (await hasHorizontalOverflow(p2)) problems.push(`${screen} : défilement horizontal`);
      for (const v of await axeViolations(p2)) problems.push(`${screen} : ${v.id} (${v.nodes.join(", ")})`);
      const small = await p2.locator("button.btn, button.sos, a.btn").evaluateAll((els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.height < 44 || r.width < 44); }).map((e) => e.textContent.trim().slice(0, 20)));
      if (small.length) problems.push(`${screen} : cibles tactiles trop petites ${small.join(", ")}`);
    }
    assert.deepEqual(problems, []);
    assert.deepEqual(errors, []);
    await context.close();
  });
}
