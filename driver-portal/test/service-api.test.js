import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-service-"));
process.env.DATA_DIR = dataDir;
const KEY = "service-key-0123456789abcdef";
let db, on, off, onBase, offBase, servers = [];

before(async () => {
  const { createApp } = await import("../server.js");
  ({ db } = await import("../db.js"));
  const common = { adminToken: "service-test-admin-token-123456", rateLimits: false, forceHttps: false, dataKey: null, sms: { async send() {} } };
  on = createApp({ ...common, appServiceKey: KEY });
  off = createApp({ ...common, appServiceKey: "" });
  servers = [on.listen(0), off.listen(0)];
  onBase = `http://127.0.0.1:${servers[0].address().port}`;
  offBase = `http://127.0.0.1:${servers[1].address().port}`;
});
after(() => {
  servers.forEach((s) => s.close());
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => db.exec("DELETE FROM applications"));

let n = 0;
function addDriver({ phone, status = "approved", ended = null, role = "driver", via = '["Metlaoui"]', decided = "2026-10-01T10:00:00.000Z" } = {}) {
  n += 1;
  const p = phone ?? `9${String(n).padStart(7, "0")}`;
  db.prepare(`INSERT INTO applications (ref, full_name, phone, cin, role, plate, governorate, station, route, consent_at, status, decided_at, ended_at, line_type, line_from, line_to_gov, line_via, pickup_en_route, leaves_partial)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`LX-S${n}`, `Chauffeur ${n}`, p, `0${String(n).padStart(7, "0")}`, role, "123 TUN 4567", "Gafsa", "Gare de Redeyef", "x", new Date().toISOString(), status, decided, ended, "regional", "Redeyef", "Gafsa", via, 1, 0);
  return p;
}
const post = (base, url, body, key = KEY) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json", ...(key === null ? {} : { "X-Service-Key": key }) }, body: JSON.stringify(body ?? {}) });

test("recherche par téléphone : seul un chauffeur ACCEPTÉ et toujours actif est renvoyé, avec des champs minimaux", async () => {
  const phone = addDriver();
  const res = await post(onBase, "/api/service/drivers/lookup", { phone: phone.replace(/(\d{2})(\d{3})(\d{3})/, "$1 $2 $3") });
  assert.equal(res.status, 200);
  const { driver } = await res.json();
  assert.deepEqual(Object.keys(driver).sort(), ["approved_at", "full_name", "governorate", "lang", "leaves_partial", "line_from", "line_to_gov", "line_type", "line_via", "phone", "pickup_en_route", "plate", "ref", "station"]);
  assert.deepEqual([driver.phone, driver.line_via, driver.pickup_en_route, driver.leaves_partial, driver.approved_at], [phone, ["Metlaoui"], true, false, "2026-10-01T10:00:00.000Z"]);
  const dump = JSON.stringify(driver);
  assert.ok(!dump.includes("0000000") && !/cin|consent|selfie|photo/i.test(dump), "jamais de CIN, de consentement ni de photo");
});

test("refus : demande en attente, refusée, collaboration terminée, numéro inconnu ou invalide", async () => {
  const pending = addDriver({ status: "pending" });
  const rejected = addDriver({ status: "rejected" });
  const ended = addDriver({ ended: "2026-10-05T00:00:00.000Z" });
  for (const phone of [pending, rejected, ended, "98000000", "abc", "", undefined]) {
    assert.equal((await post(onBase, "/api/service/drivers/lookup", { phone })).status, 404, String(phone));
  }
});

test("liste des chauffeurs acceptés : exclut les autres statuts et les collaborations terminées", async () => {
  const a = addDriver();
  const b = addDriver();
  addDriver({ status: "pending" });
  addDriver({ ended: "2026-10-05T00:00:00.000Z" });
  addDriver({ via: "pas du json" });
  const { drivers } = await (await post(onBase, "/api/service/drivers/approved")).json();
  assert.equal(drivers.length, 3);
  assert.deepEqual(drivers.slice(0, 2).map((d) => d.phone), [a, b]);
  assert.deepEqual(drivers[2].line_via, [], "ancien circuit illisible : liste vide, pas d'erreur");
});

test("clé de service : absente, fausse ou trop courte refusées ; sans clé configurée, le service est désactivé", async () => {
  const phone = addDriver();
  assert.equal((await post(onBase, "/api/service/drivers/lookup", { phone }, null)).status, 401);
  assert.equal((await post(onBase, "/api/service/drivers/lookup", { phone }, "mauvaise-cle-0123456789")).status, 401);
  assert.equal((await post(onBase, "/api/service/drivers/approved", {}, "")).status, 401);
  assert.equal((await post(offBase, "/api/service/drivers/lookup", { phone }, KEY)).status, 503);
  assert.equal((await post(offBase, "/api/service/drivers/approved", {}, "")).status, 503);
  const short = (await import("../server.js")).createApp({ adminToken: "service-test-admin-token-123456", rateLimits: false, forceHttps: false, dataKey: null, sms: { async send() {} }, appServiceKey: "court" });
  const server = short.listen(0);
  try {
    assert.equal((await post(`http://127.0.0.1:${server.address().port}`, "/api/service/drivers/lookup", { phone }, "court")).status, 503, "une clé de moins de 16 caractères n'active rien");
  } finally {
    server.close();
  }
});

test("réponses jamais mises en cache, et GET refusé (le téléphone ne passe jamais par l'URL)", async () => {
  addDriver();
  const res = await post(onBase, "/api/service/drivers/approved");
  assert.match(res.headers.get("cache-control"), /no-store/);
  assert.equal((await fetch(`${onBase}/api/service/drivers/lookup?phone=98123456`, { headers: { "X-Service-Key": KEY } })).status, 404);
});
