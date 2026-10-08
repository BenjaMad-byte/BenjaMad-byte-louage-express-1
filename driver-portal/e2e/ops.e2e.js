import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startApp, launchBrowser, newContext, watchErrors, axeViolations, ADMIN_TOKEN } from "./_harness.js";

const KEY = "e2e-ops-key-0123456789";
let env, browser, skip, fake, calls;
const sos = [{ id: "sos-1", status: "open", full_name: "Salah Test", phone: "98123456", plate: "123 TUN 4567", lat: 34.3731, lon: 8.1553, position_age_s: 4, trigger: "triple_tap", received_at: "2026-10-08T10:00:00.000Z", alerts_sent: 2, ack_by: null, ack_at: null, note: null }];

before(async () => {
  calls = [];
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, key: req.headers["x-service-key"], body: body ? JSON.parse(body) : null });
      res.setHeader("Content-Type", "application/json");
      if (req.headers["x-service-key"] !== KEY) { res.statusCode = 401; return res.end("{}"); }
      if (req.url === "/api/ops/overview") {
        return res.end(JSON.stringify({ now: "2026-10-08T10:01:00.000Z", drivers: { total: 3, active: 2 }, reservations: { confirmed: 1 },
          lines: [{ id: 1, from: "Redeyef", toGov: "Gafsa", queue: [{ rank: 1, plate: "123 TUN 4567", driver: "Salah Test", status: "queued", currentStop: 0, stops: ["Redeyef", "Metlaoui", "Gafsa"], capacity: 8, onboardNow: 3, reservedNow: 1 }], enRoute: [] }], sos }));
      }
      const m = req.url.match(/^\/api\/ops\/sos\/([^/]+)\/(ack|resolve)$/);
      if (m) { const s = sos.find((x) => x.id === m[1]); s.status = m[2] === "ack" ? "ack" : "resolved"; s.ack_by = JSON.parse(body).by; s.note = JSON.parse(body).note ?? null; return res.end('{"ok":true}'); }
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  env = await startApp({ appOps: { url: `http://127.0.0.1:${fake.address().port}`, key: KEY, fetchImpl: fetch } });
  ({ browser, skip } = await launchBrowser());
});
after(async () => {
  await browser?.close();
  env.stop();
  fake.close();
});

test("exploitation : bannière rouge sur tous les onglets, tableau des SOS avec position, prise en charge au nom du compte, clôture avec note", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { lang: "fr", viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(env.base + "/admin");
  await page.fill("#token", ADMIN_TOKEN);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.locator("#app").waitFor();

  // Bannière visible dès la connexion, sur l'onglet « Demandes ».
  await page.locator("#sos-banner:not([hidden])").waitFor();
  assert.ok((await page.locator("#sos-banner").innerText()).includes("1 alerte SOS à prendre en charge"));
  assert.ok((await page.title()).includes("🆘"));

  await page.getByRole("button", { name: "Voir" }).click();
  await page.locator("#sos-table").waitFor();
  const row = await page.locator("#sos-table tbody tr").first().innerText();
  assert.ok(row.includes("Salah Test") && row.includes("98123456") && row.includes("123 TUN 4567") && row.includes("lue il y a 4 s"), row);
  assert.equal(await page.locator("#sos-table a[href^='https://www.google.com/maps?q=34.3731,8.1553']").getAttribute("rel"), "noopener noreferrer");
  const lines = await page.locator("#view-ops .line-block").innerText();
  assert.ok(lines.includes("Redeyef → Gafsa") && lines.includes("4 / 8") && lines.includes("dont 1 réservée"), lines);
  assert.deepEqual((await axeViolations(page)).map((v) => `${v.id}: ${v.nodes.join(",")}`), []);

  await page.getByRole("button", { name: "Prendre en charge" }).click();
  await page.waitForFunction(() => document.querySelector("#sos-table")?.innerText.includes("jeton-admin"));
  assert.deepEqual(calls.filter((c) => c.url.endsWith("/ack")).map((c) => c.body), [{ by: "jeton-admin" }], "le nom vient du compte connecté");
  await page.locator("#sos-banner[hidden]").waitFor({ state: "attached", timeout: 30_000 });

  page.once("dialog", (d) => d.accept("Chauffeur joint, fausse manœuvre"));
  await page.getByRole("button", { name: "Clôturer" }).click();
  await page.waitForFunction(() => document.querySelector("#sos-table")?.innerText.includes("Chauffeur joint, fausse manœuvre"));
  assert.deepEqual(errors, []);
  await context.close();
});

test("exploitation : application chauffeur injoignable = message clair, la console reste utilisable", { timeout: 90_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const down = await startApp({ appOps: { url: "http://127.0.0.1:1", key: KEY, fetchImpl: fetch } });
  const context = await newContext(browser, { lang: "fr", viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(down.base + "/admin");
  await page.fill("#token", ADMIN_TOKEN);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.locator("#app").waitFor();
  await page.locator("#tab-ops").click();
  await page.locator("#view-ops .banner.error").waitFor();
  assert.ok((await page.locator("#view-ops .banner.error").innerText()).includes("pas joignable"));
  assert.equal(await page.locator("#sos-banner").isHidden(), true);
  await page.locator("#tab-apps").click();
  await page.locator("#apps").waitFor();
  await context.close();
  down.stop();
});
