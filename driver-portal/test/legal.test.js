import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DOCS, DOC_KEYS, UPDATED } from "../public/legal-text.js";
import { segments, visibleBlocks, hasMissingValues, REQUIRED_VALUES } from "../public/legal-render.js";
import { legalProblems, legalValues, LEGAL_REQUIRED } from "../legal.js";
import { assertProductionConfig } from "../security.js";
import { LEGAL_ENV } from "./legal-fixture.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-legal-"));
process.env.DATA_DIR = dataDir;
let server, db, base;
before(async () => {
  const { createApp } = await import("../server.js");
  ({ db } = await import("../db.js"));
  server = createApp({ adminToken: "legal-test-token-1234", rateLimits: false, forceHttps: false, dataKey: null, sms: { name: "stub", send: async () => {} }, legalEnv: { ...LEGAL_ENV, LEGAL_PHONE: "+216 70 000 000", SMS_PROVIDER: "twilio" } }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const textsOf = (content) => content.sections.flatMap((s) => s.blocks.flatMap((b) => (b.ul ? b.ul : [b.p])));
const markersOf = (content) => [...new Set(textsOf(content).flatMap((x) => [...x.matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort();
const shape = (content) => content.sections.map((s) => s.blocks.map((b) => (b.ul ? `ul${b.ul.length}` : `p${b.if ? `:${b.if}` : ""}`)).join(","));
const fullText = (content) => content.sections.map((s) => `${s.h} ${textsOf({ sections: [s] }).join(" ")}`).join(" ");

test("textes légaux : trois documents, en arabe et en français, avec la même structure", () => {
  assert.deepEqual(DOC_KEYS, ["privacy", "terms", "legal"]);
  assert.match(UPDATED, /^\d{4}-\d{2}-\d{2}$/);
  for (const key of DOC_KEYS) {
    const { fr, ar } = DOCS[key];
    assert.ok(fr.title && ar.title && fr.intro && ar.intro, key);
    assert.deepEqual(shape(ar), shape(fr), `${key} : sections et listes parallèles entre l'arabe et le français`);
    assert.deepEqual(markersOf(ar), markersOf(fr), `${key} : mêmes marqueurs dans les deux langues`);
    assert.ok(ar.sections.every((s) => /[؀-ۿ]/.test(s.h)), `${key} : titres arabes en arabe`);
  }
});

test("textes légaux : chaque marqueur est une valeur fournie par /api/legal", () => {
  const known = new Set(Object.keys(legalValues({})));
  for (const key of DOC_KEYS) {
    for (const lang of ["fr", "ar"]) {
      for (const marker of markersOf(DOCS[key][lang])) assert.ok(known.has(marker), `${key}/${lang} : {${marker}} inconnu`);
    }
  }
  for (const k of REQUIRED_VALUES) assert.ok(known.has(k), k);
});

test("la politique de confidentialité couvre l'essentiel : données, durées, droits, SMS, visage, INPDP", () => {
  const fr = fullText(DOCS.privacy.fr);
  const ar = fullText(DOCS.privacy.ar);
  for (const word of ["CIN", "SMS", "visage", "INPDP", "2004-63", "{retention_rejected}", "{retention_approved}", "{email}", "{sms}", "{host}", "3 jours"]) assert.ok(fr.includes(word), `fr : ${word}`);
  for (const word of ["الرسائل القصيرة", "الهيئة الوطنية لحماية المعطيات الشخصية", "2004", "{retention_rejected}", "{retention_approved}", "{email}", "{sms}", "{host}", "3 أيام"]) assert.ok(ar.includes(word), `ar : ${word}`);
});

test("segments : valeurs remplacées, valeur absente = « à compléter », jamais de {marqueur} brut", () => {
  assert.deepEqual(segments("Écrire à {email}.", { email: "a@b.tn" }), [{ text: "Écrire à " }, { text: "a@b.tn", value: true }, { text: "." }]);
  assert.deepEqual(segments("{retention_rejected} mois", { retention_rejected: null }), [{ todo: "retention_rejected" }, { text: " mois" }]);
  assert.deepEqual(segments("{inconnu}", {}), [{ todo: "inconnu" }]);
  assert.deepEqual(segments("{n} mois", { n: 6 }), [{ text: "6", value: true }, { text: " mois" }], "un nombre est affiché tel quel");
  assert.deepEqual(segments("sans marqueur", {}), [{ text: "sans marqueur" }]);
});

test("blocs facultatifs et avertissement de texte provisoire", () => {
  const blocks = DOCS.legal.fr.sections[0].blocks;
  assert.ok(visibleBlocks(blocks, {}).length < blocks.length, "téléphone, identifiant et responsable masqués s'ils manquent");
  assert.equal(visibleBlocks(blocks, { phone: "1", registration: "2", publisher: "3" }).length, blocks.length);
  assert.equal(hasMissingValues({}), true);
  assert.equal(hasMissingValues(legalValues({ ...LEGAL_ENV })), false);
  assert.equal(hasMissingValues({ ...legalValues({ ...LEGAL_ENV }), email: null }), true);
});

test("legalProblems : variables obligatoires, durées en mois entiers, e-mail valide", () => {
  assert.deepEqual(legalProblems(LEGAL_ENV), []);
  assert.equal(legalProblems({}).length, LEGAL_REQUIRED.length);
  assert.match(legalProblems({ ...LEGAL_ENV, LEGAL_RETENTION_REJECTED_MONTHS: "0" }).join(), /LEGAL_RETENTION_REJECTED_MONTHS/);
  assert.match(legalProblems({ ...LEGAL_ENV, LEGAL_RETENTION_APPROVED_MONTHS: "six" }).join(), /LEGAL_RETENTION_APPROVED_MONTHS/);
  assert.match(legalProblems({ ...LEGAL_ENV, LEGAL_EMAIL: "pas un email" }).join(), /LEGAL_EMAIL/);
  assert.match(legalProblems({ ...LEGAL_ENV, LEGAL_ENTITY: "   " }).join(), /LEGAL_ENTITY/, "une valeur vide ou d'espaces compte comme absente");
});

test("legalValues : prestataire SMS déduit de SMS_PROVIDER, durées numériques, rien de secret", () => {
  const v = legalValues({ ...LEGAL_ENV, SMS_PROVIDER: "Twilio", ADMIN_TOKEN: "secret", DATA_KEY: "secret" });
  assert.equal(v.sms, "Twilio (États-Unis)");
  assert.equal(v.retention_rejected, 6);
  assert.equal(v.retention_approved, 12);
  assert.equal(legalValues({ ...LEGAL_ENV, SMS_PROVIDER: "console" }).sms, null);
  assert.ok(!JSON.stringify(v).includes("secret"));
  assert.equal(legalValues({ LEGAL_RETENTION_REJECTED_MONTHS: "abc" }).retention_rejected, null);
});

test("production : le démarrage est refusé sans les informations légales", () => {
  const prod = {
    NODE_ENV: "production", ADMIN_TOKEN: "a".repeat(32), DATA_KEY: "ab".repeat(32), OTP_SECRET: "o".repeat(32), KYC_SERVICE_KEY: "k".repeat(24),
    KYC_BACKEND_URL: "https://kyc.example.tn", SMS_PROVIDER: "twilio", TRUST_PROXY: "1", PUBLIC_URL: "https://inscription.exemple.tn",
  };
  assert.throws(() => assertProductionConfig(prod), /LEGAL_ENTITY[\s\S]*LEGAL_RETENTION_APPROVED_MONTHS/);
  assert.doesNotThrow(() => assertProductionConfig({ ...prod, ...LEGAL_ENV }));
});

test("API et pages : /api/legal public, pages 200 sans marqueur brut, dans le plan du site", async () => {
  const res = await fetch(`${base}/api/legal`);
  assert.equal(res.status, 200);
  const v = await res.json();
  assert.equal(v.entity, LEGAL_ENV.LEGAL_ENTITY);
  assert.equal(v.phone, "+216 70 000 000");
  assert.equal(v.sms, "Twilio (États-Unis)");
  assert.equal(v.registration, null);
  for (const p of ["/privacy", "/terms", "/legal", "/privacy.html"]) {
    const page = await fetch(base + p);
    const html = await page.text();
    assert.equal(page.status, 200, p);
    assert.ok(html.includes('id="legal-body"') && !html.includes("%PUBLIC_URL%"), p);
  }
  const map = await (await fetch(`${base}/sitemap.xml`)).text();
  for (const p of ["/privacy", "/terms", "/legal"]) assert.ok(map.includes(`${p}</loc>`), p);
});
