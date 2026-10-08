// Socle des tests de navigateur : un serveur isolé (base temporaire, SMS et KYC simulés) et un vrai navigateur Chrome/Edge.
// Aucune donnée réelle, aucun appel réseau sortant. Lancement : npm run test:e2e
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import axe from "axe-core";
import { chromium } from "playwright-core";
import { DICT } from "../public/i18n.js";

export const T = DICT; // T.fr.xxx / T.ar.xxx : les textes attendus viennent du dictionnaire, jamais copiés en dur
export const ADMIN_TOKEN = "e2e-admin-token-0123456789";

/** Un PNG minimal valide (en-tête + contenu) : suffit pour le contrôle des octets magiques du serveur. */
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("PIECE-D-IDENTITE-DE-TEST"), Buffer.alloc(64, 7)]);
export const file = (name) => ({ name: `${name}.png`, mimeType: "image/png", buffer: PNG });

// Le module de base de données est unique par processus : plusieurs serveurs d'un même fichier de test la partagent.
// Elle ne se ferme (et les dossiers temporaires ne s'effacent) qu'à l'arrêt du dernier.
let active = 0;
const tempDirs = [];

/** Démarre l'application sur un port libre. Retourne { base, db, sms, kycCalls, app, stop }. */
export async function startApp({ dataKey = crypto.randomBytes(32).toString("hex"), rateLimits = false, legalEnv, notifications, appOps } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-e2e-"));
  tempDirs.push(dataDir);
  if (active === 0) process.env.DATA_DIR = dataDir; // la base n'est ouverte qu'une fois : au premier import
  active += 1;
  const { createApp } = await import("../server.js");
  const { db } = await import("../db.js");

  const sms = { name: "stub", sent: [], async send(phone, text) { this.sent.push({ phone, text, code: text.match(/\d{6}/)?.[0] ?? null }); } };
  const kycCalls = [];
  const kycFetch = async (_url, opts) => {
    if (opts.method === "POST") kycCalls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ status: "review", faceMatch: { score: 0.5, provider: "e2e", isRealBiometric: false }, liveness: { passed: true }, ocrCin: { rawText: "", confidence: 0 }, reasons: [] }) };
  };
  let skew = 0; // horloge du serveur avancée à volonté : codes TOTP, expiration des sessions
  const app = createApp({ adminToken: ADMIN_TOKEN, rateLimits, forceHttps: false, dataKey, sms, kycFetch, now: () => Date.now() + skew, publicUrl: "https://inscription.exemple.tn", ...(legalEnv ? { legalEnv } : {}), ...(notifications ? { notifications } : {}), ...(appOps ? { appOps } : {}) });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, db, sms, kycCalls, app,
    now: () => Date.now() + skew,
    advance(ms) { skew += ms; },
    stop() {
      server.close();
      active -= 1;
      if (active > 0) return;
      db.close();
      for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

/**
 * Lance Chrome (ou Edge) installé sur la machine, avec une caméra simulée qui produit une image animée.
 * Retourne { browser } ou { skip: "raison" } si aucun navigateur n'est disponible (les tests sont alors ignorés, pas faussement verts).
 */
export async function launchBrowser({ launcher = chromium, env = process.env } = {}) {
  const args = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
  const channels = [env.E2E_CHANNEL, "chrome", "msedge"].filter(Boolean);
  for (const channel of channels) {
    try {
      return { browser: await launcher.launch({ channel, headless: true, args }) };
    } catch { /* canal suivant */ }
  }
  const reason = `aucun navigateur Chrome/Edge trouvé (essayé : ${channels.join(", ")}) : définir E2E_CHANNEL ou installer Chrome`;
  // En intégration continue, « ignoré » ne doit jamais passer pour « réussi » : E2E_REQUIRE_BROWSER=1 transforme l'absence de navigateur en échec.
  if (env.E2E_REQUIRE_BROWSER === "1") throw new Error(reason);
  return { skip: reason };
}

/** Contexte de navigateur : taille d'écran, langue du site, thème, caméra autorisée. */
export async function newContext(browser, { lang = "fr", viewport = { width: 375, height: 812 }, colorScheme = "light" } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, locale: lang === "ar" ? "ar-TN" : "fr-FR", permissions: ["camera"], isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  await context.addInitScript((l) => { try { localStorage.setItem("lang", l); } catch { /* stockage indisponible */ } }, lang);
  return context;
}

/** Collecte les erreurs qui comptent : exceptions non attrapées et violations de la politique de sécurité (CSP). */
export function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(`exception : ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/Failed to load resource/i.test(text)) return; // 400/401/404 volontaires dans les tests de validation
    errors.push(`console : ${text}`);
  });
  return errors;
}

/** Violations d'accessibilité de gravité sérieuse ou critique (axe-core), la CSP restant active. */
export async function axeViolations(page) {
  await page.evaluate(axe.source);
  const results = await page.evaluate(async () => {
    const r = await window.axe.run(document, { resultTypes: ["violations"] });
    return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
  });
  return results;
}

/** Vrai si la page déborde horizontalement (défilement horizontal indésirable). */
export const hasHorizontalOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

/** Inscription complète par l'API (rapide), pour préparer un dossier sans passer par l'interface. Retourne la référence. */
export async function registerViaApi(env, { phone, cin, name = "Chauffeur Test", governorate = "Tunis", line = { type: "interregional", from: "Tunis", to: "Sousse" } }) {
  const post = (url, body) => fetch(env.base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await post("/api/otp/send", { phone, lang: "fr" });
  const code = env.sms.sent.findLast((s) => s.phone === phone).code;
  const { token } = await (await post("/api/otp/verify", { phone, code })).json();
  const fd = new FormData();
  const fields = { full_name: name, phone, cin, plate: "123 TUN 4567", governorate, station: "Gare", line_type: line.type, line_from: line.from, line_to_gov: line.to, consent: "true", consent_biometric: "true", lang: "fr", otp_token: token };
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const n of ["cin_front", "cin_back", "permis", "selfie_1", "selfie_2"]) fd.append(n, new Blob([PNG], { type: "image/png" }), `${n}.png`);
  const res = await fetch(`${env.base}/api/applications`, { method: "POST", body: fd });
  if (res.status !== 201) throw new Error(`inscription de préparation refusée : ${res.status} ${await res.text()}`);
  return (await res.json()).ref;
}
