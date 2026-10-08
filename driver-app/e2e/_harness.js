// Socle des tests de navigateur de l'application chauffeur : serveur isolé (base temporaire, site d'inscription et SMS simulés) + vrai Chrome/Edge.
// Aucune donnée réelle, aucun appel sortant. Lancement : npm run test:e2e
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import axe from "axe-core";
import { chromium } from "playwright-core";
import { DICT } from "../public/i18n.js";
import { fakePortal, fakeSms, portalDriver } from "../test/_helpers.js";

export const T = DICT;
export { portalDriver };
export const OPS_KEY = "e2e-ops-key-0123456789";
export const DEMO_PASSWORD = "chauffeur-demo-2026"; // mot de passe de test : assez varié, pas le matricule

let tempDir;

/** Démarre l'application sur un port libre. Retourne { base, db, portal, sms, app, stop, advance }. */
export async function startApp({ sosPhones = ["97000111"], reservations = false } = {}) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "driver-app-e2e-"));
  process.env.DATA_DIR = tempDir;
  const { createApp } = await import("../server.js");
  const { db } = await import("../db.js");
  const portal = fakePortal();
  const sms = fakeSms();
  let skew = 0;
  const { createSimulatedSva } = await import("../sva.js");
  const sva = createSimulatedSva();
  const app = createApp({ portal, sms, sva, svaSecret: "s".repeat(40), reservationsEnabled: reservations, otpSecret: "o".repeat(40), now: () => Date.now() + skew, sosPhones, opsKey: OPS_KEY, rateLimits: false, forceHttps: false });
  const server = app.listen(0);
  return {
    base: `http://127.0.0.1:${server.address().port}`, db, portal, sms, sva, app,
    advance(ms) { skew += ms; },
    stop() {
      server.close();
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/** Lance Chrome (ou Edge) installé. Retourne { browser } ou { skip } ; avec E2E_REQUIRE_BROWSER=1 l'absence de navigateur est une ERREUR (CI). */
export async function launchBrowser({ launcher = chromium, env = process.env } = {}) {
  const channels = [env.E2E_CHANNEL, "chrome", "msedge"].filter(Boolean);
  for (const channel of channels) {
    try {
      return { browser: await launcher.launch({ channel, headless: true }) };
    } catch { /* canal suivant */ }
  }
  const reason = `aucun navigateur Chrome/Edge trouvé (essayé : ${channels.join(", ")}) : définir E2E_CHANNEL ou installer Chrome`;
  if (env.E2E_REQUIRE_BROWSER === "1") throw new Error(reason);
  return { skip: reason };
}

/** Contexte « téléphone » : petit écran, langue, thème, position simulée (Redeyef) accordée. */
export async function newContext(browser, { lang = "fr", viewport = { width: 390, height: 780 }, colorScheme = "light", geolocation = { latitude: 34.3731, longitude: 8.1553 } } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, locale: lang === "ar" ? "ar-TN" : "fr-FR", isMobile: true, hasTouch: true, permissions: ["geolocation"], geolocation });
  return context;
}

export function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(`exception : ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/Failed to load resource|net::ERR/i.test(text)) return; // coupures réseau volontaires
    errors.push(`console : ${text}`);
  });
  return errors;
}

export async function axeViolations(page) {
  await page.evaluate(axe.source);
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { resultTypes: ["violations"] });
    return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
  });
}

export const hasHorizontalOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

/**
 * Acceptation + activation (lien reçu par SMS) + connexion, comme le ferait un chauffeur à l'installation.
 * La langue de l'écran d'activation suit celle déjà choisie sur l'appareil (stockage partagé du navigateur), pas forcément l'arabe
 * par défaut : un appareil déjà utilisé par un premier chauffeur peut être resté en français avant que le second n'active son compte.
 */
export async function loginViaUi(page, env, driver, lang = "fr", password = DEMO_PASSWORD) {
  env.portal.drivers.set(driver.ref, driver);
  await env.app.locals.auth.syncApproved();
  const link = env.sms.lastLink(driver.phone);
  await page.goto(link.startsWith("http") ? link : env.base + link);
  await page.locator("#newpw").waitFor();
  await page.fill("#newpw", password);
  await page.getByRole("button", { name: new RegExp(`^(${T.ar.activation_go}|${T.fr.activation_go})$`) }).click();
  await page.locator("[data-screen]").waitFor();
  const current = await page.evaluate(() => document.documentElement.lang);
  if (current !== lang) {
    await page.getByRole("button", { name: T[current].lang_other }).click();
    await page.waitForFunction((l) => document.documentElement.lang === l, lang);
  }
}

/** Reconnexion sur un appareil déjà activé (matricule + mot de passe), sans repasser par le lien SMS. */
export async function reloginViaUi(page, env, driver, lang = "fr", password = DEMO_PASSWORD) {
  await page.goto(env.base + "/");
  await page.locator("#plate").waitFor();
  const toFrench = page.getByRole("button", { name: T.ar.lang_other });
  if (lang === "fr" && (await toFrench.count())) await toFrench.click();
  await page.fill("#plate", driver.plate);
  await page.fill("#password", password);
  await page.getByRole("button", { name: T[lang].login_go }).click();
  await page.locator("[data-screen]").waitFor();
}
