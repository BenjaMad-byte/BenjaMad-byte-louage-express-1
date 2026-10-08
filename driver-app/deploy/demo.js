// Démo locale de l'application chauffeur, pour la voir dans le navigateur de cette session.
// PAS une configuration de production : un chauffeur « accepté » est déjà présent (pas besoin du site d'inscription),
// les codes SMS s'affichent dans ce journal au lieu d'être envoyés, et les données sont jetables (driver-app/data-demo/).
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DATA_DIR = process.env.DATA_DIR || path.join(here, "..", "data-demo");

const { createApp } = await import("../server.js");

const DRIVER = {
  ref: "LX-DEMO0001", full_name: "Chauffeur Démo", phone: "98700001", plate: "123 TUN 4567",
  governorate: "Gafsa", station: "Gare de Redeyef", line_type: "regional", line_from: "Redeyef", line_to_gov: "Gafsa",
  line_via: ["Métlaoui"], pickup_en_route: true, leaves_partial: false, approved_at: new Date().toISOString(),
};
const portal = {
  async lookup(phone) { return phone === DRIVER.phone ? DRIVER : null; },
  async approved() { return [DRIVER]; },
};
const sms = { name: "demo", async send(phone, text) { console.log(`[SMS démo] vers ${phone} : ${text}`); } };

const app = createApp({
  portal, sms, otpSecret: "demo-otp-secret-0123456789abcdef0123456789",
  sosPhones: ["97000111"], opsKey: "demo-ops-key-0123456789abcdef",
  reservationsEnabled: true, // démo seulement : fournisseur SVA simulé, aucun opérateur réel
  rateLimits: false, forceHttps: false,
});
app.locals.start();

const port = Number(process.env.PORT || 4200);
app.listen(port, () => {
  console.log(`Démo application chauffeur — http://localhost:${port}`);
  console.log(`Chauffeur de démonstration : ${DRIVER.phone} (le code SMS s'affiche ici, ligne « [SMS démo] »)`);
});
