// Démo locale du site d'inscription avec l'onglet « Exploitation » branché sur l'application chauffeur de démo (port 4200).
// PAS une configuration de production : données jetables (driver-portal/data-demo/), jeton admin fixe affiché ci-dessous.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DATA_DIR = process.env.DATA_DIR || path.join(here, "..", "data-demo");

const { createApp } = await import("../server.js");

const DEMO_ADMIN_TOKEN = "demo-admin-token-0123456789abcdef";
const app = createApp({
  adminToken: DEMO_ADMIN_TOKEN,
  sms: { name: "demo", async send(phone, text) { console.log(`[SMS démo] vers ${phone} : ${text}`); } },
  // Même paire de clés que driver-app/deploy/demo.js : OPS_SERVICE_KEY de ce côté-là = opsKey ici.
  appOps: { url: "http://127.0.0.1:4200", key: "demo-ops-key-0123456789abcdef", fetchImpl: fetch },
  rateLimits: false, forceHttps: false,
});
app.locals.kyc.start();
app.locals.retention.start();
app.locals.notifier.start();

const port = Number(process.env.PORT || 4100);
app.listen(port, () => {
  console.log(`Démo site d'inscription — http://localhost:${port}/admin`);
  console.log(`Jeton admin de démonstration : ${DEMO_ADMIN_TOKEN}`);
});
