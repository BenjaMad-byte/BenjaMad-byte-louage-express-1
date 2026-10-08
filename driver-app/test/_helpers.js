// Aides communes aux tests du service d'application chauffeur.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Dossier de données temporaire, à poser AVANT d'importer db.js. */
export function tempData(prefix = "driver-app-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DATA_DIR = dir;
  return dir;
}

/** Faux site d'inscription : des chauffeurs acceptés en mémoire. */
export function fakePortal(initial = []) {
  const drivers = new Map(initial.map((d) => [d.ref, d]));
  let down = false;
  const portal = {
    drivers,
    set down(v) { down = v; },
    async lookup(phone) {
      if (down) { const e = new Error("injoignable"); e.code = "portal_unreachable"; throw e; }
      return [...drivers.values()].find((d) => d.phone === phone) ?? null;
    },
    async approved() {
      if (down) { const e = new Error("injoignable"); e.code = "portal_unreachable"; throw e; }
      return [...drivers.values()];
    },
  };
  return portal;
}

let counter = 0;
export function portalDriver(over = {}) {
  counter += 1;
  return {
    ref: `LX-D${counter}`, full_name: `Chauffeur ${counter}`, phone: `9${String(counter).padStart(7, "0")}`, plate: `${100 + counter} TUN ${4000 + counter}`,
    governorate: "Gafsa", station: "Gare de Redeyef", line_type: "regional", line_from: "Redeyef", line_to_gov: "Gafsa", line_via: ["Métlaoui"],
    pickup_en_route: true, leaves_partial: false, approved_at: "2026-10-01T10:00:00.000Z", ...over,
  };
}

/** Faux fournisseur SMS : mémorise tout ; les codes de vérification sont retrouvés avec lastCode(phone). */
export function fakeSms() {
  return {
    name: "stub", sent: [], fail: false,
    async send(phone, text) {
      if (this.fail) throw new Error("twilio HTTP 500");
      this.sent.push({ phone, text });
    },
    lastCode(phone) {
      return this.sent.findLast((s) => s.phone === phone && /\d{6}/.test(s.text))?.text.match(/\d{6}/)[0];
    },
    /** Lien d'activation envoyé à ce numéro : voir auth.js → sendActivationSms. Absolu (PUBLIC_URL configuré) ou relatif (tests sans PUBLIC_URL). */
    lastLink(phone) {
      return this.sent.findLast((s) => s.phone === phone && /\/activer\?jeton=/.test(s.text))?.text.match(/(https?:\/\/\S+|\/activer\?jeton=\S+)/)?.[0];
    },
  };
}

/** Le jeton « ?jeton=... » d'un lien d'activation. */
export const tokenOf = (link) => (link ? new URL(link).searchParams.get("jeton") : null);

/** Horloge contrôlable. */
export function clock(start = "2026-10-08T10:00:00Z") {
  let t = Date.parse(start);
  const fn = () => t;
  fn.advance = (ms) => { t += ms; };
  return fn;
}
