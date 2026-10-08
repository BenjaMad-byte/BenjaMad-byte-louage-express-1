import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-list-"));
process.env.DATA_DIR = dataDir;
const TOKEN = "list-test-token-1234567890";

let server, base, db;

/** Jeu de dossiers : (gouvernorat, type de ligne, statut, identité, date). Téléphones et CIN uniques. */
const ROWS = [
  { name: "Ali Ben Salah", gov: "Gafsa", type: "regional", status: "pending", kyc: "review", at: "2026-10-01T08:00:00.000Z" },
  { name: "Brahim Trabelsi", gov: "Gafsa", type: "interregional", status: "pending", kyc: "verified", at: "2026-10-02T08:00:00.000Z" },
  { name: "Chokri Jlassi", gov: "Sousse", type: "interregional", status: "interview", kyc: "review", at: "2026-10-03T08:00:00.000Z" },
  { name: "Dhaker Mejri", gov: "Médenine", type: "rural", status: "approved", kyc: "verified", at: "2026-10-04T08:00:00.000Z" },
  { name: "Elyes Haddad", gov: "Médenine", type: "national", status: "rejected", kyc: "error", at: "2026-10-05T08:00:00.000Z" },
  { name: "Fathi Gharbi", gov: "Tunis", type: "interregional", status: "pending", kyc: null, at: "2026-10-06T08:00:00.000Z" },
];

before(async () => {
  const { createApp } = await import("../server.js");
  ({ db } = await import("../db.js"));
  server = createApp({ adminToken: TOKEN, rateLimits: false, dataKey: null, sms: { name: "stub", send: async () => {} } }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  const insApp = db.prepare(
    `INSERT INTO applications (ref, full_name, phone, cin, role, plate, governorate, station, route, line_type, line_from, line_to_gov, consent_at, status, created_at)
     VALUES (?,?,?,?, 'driver', '111 TUN 1', ?, 'Gare', 'x', ?, 'Ville', ?, ?, ?, ?)`
  );
  const insKyc = db.prepare("INSERT INTO kyc_checks (application_id, status) VALUES (?, ?)");
  ROWS.forEach((r, i) => {
    const info = insApp.run(`LX-LIST${i}AAA`, r.name, `2000000${i}`, `9000000${i}`, r.gov, r.type, r.type === "national" ? null : r.gov, r.at, r.status, r.at);
    if (r.kyc) insKyc.run(Number(info.lastInsertRowid), r.kyc);
  });
});
after(() => {
  server.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const list = async (query = "") => {
  const res = await fetch(`${base}/api/admin/applications${query ? `?${query}` : ""}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: await res.json() };
};
const names = (body) => body.applications.map((a) => a.full_name);

test("sans filtre : tout, le plus récent d'abord, avec total, page et compteurs", async () => {
  const { status, body } = await list();
  assert.equal(status, 200);
  assert.equal(body.total, 6);
  assert.equal(body.page, 1);
  assert.equal(body.pages, 1);
  assert.deepEqual(names(body), ["Fathi Gharbi", "Elyes Haddad", "Dhaker Mejri", "Chokri Jlassi", "Brahim Trabelsi", "Ali Ben Salah"]);
  const first = body.applications[0];
  assert.ok(first.governorate && first.line_type && "kyc_status" in first && first.ref && first.created_at);
  assert.ok(!("cin" in first), "le numéro de CIN n'est jamais renvoyé dans la liste");
});

test("chaque filtre isolé", async () => {
  assert.deepEqual(names((await list("governorate=Gafsa")).body).sort(), ["Ali Ben Salah", "Brahim Trabelsi"]);
  assert.deepEqual(names((await list("line_type=interregional")).body).sort(), ["Brahim Trabelsi", "Chokri Jlassi", "Fathi Gharbi"]);
  assert.deepEqual(names((await list("kyc=review")).body).sort(), ["Ali Ben Salah", "Chokri Jlassi"]);
  assert.deepEqual(names((await list("status=pending")).body).sort(), ["Ali Ben Salah", "Brahim Trabelsi", "Fathi Gharbi"]);
  assert.deepEqual(names((await list("line_type=rural")).body), ["Dhaker Mejri"]);
  assert.deepEqual(names((await list("line_type=national")).body), ["Elyes Haddad"]);
});

test("filtres combinés : tous doivent s'appliquer (ET)", async () => {
  assert.deepEqual(names((await list("governorate=Gafsa&kyc=review")).body), ["Ali Ben Salah"]);
  assert.deepEqual(names((await list("status=pending&line_type=interregional")).body).sort(), ["Brahim Trabelsi", "Fathi Gharbi"]);
  assert.deepEqual(names((await list("governorate=Gafsa&status=pending&line_type=interregional&kyc=verified")).body), ["Brahim Trabelsi"]);
  assert.deepEqual((await list("governorate=Tunis&kyc=review")).body.applications, []);
});

test("filtre d'identité « kyc=none » : dossiers sans vérification enregistrée", async () => {
  assert.deepEqual(names((await list("kyc=none")).body), ["Fathi Gharbi"]);
});

test("compteurs : par statut, en tenant compte des AUTRES filtres mais pas du filtre de statut lui-même", async () => {
  const all = (await list()).body.counts;
  assert.deepEqual(all.status, { pending: 3, interview: 1, approved: 1, rejected: 1 });
  assert.deepEqual(all.kyc, { review: 2, verified: 2, error: 1, none: 1 });

  const gafsa = (await list("governorate=Gafsa&status=approved")).body;
  assert.equal(gafsa.total, 0, "le filtre de statut s'applique à la liste");
  assert.deepEqual(gafsa.counts.status, { pending: 2 }, "mais les compteurs de statut ignorent ce filtre-là, pas le gouvernorat");
  assert.deepEqual(gafsa.counts.kyc, {}, "les compteurs d'identité respectent le statut et le gouvernorat choisis (aucun dossier accepté à Gafsa)");
  const gafsaPending = (await list("governorate=Gafsa&status=pending")).body.counts.kyc;
  assert.deepEqual(gafsaPending, { review: 1, verified: 1 });
});

test("tri : plus ancien, nom, gouvernorat ; valeur inconnue refusée", async () => {
  assert.equal(names((await list("sort=created_asc")).body)[0], "Ali Ben Salah");
  assert.deepEqual(names((await list("sort=name")).body), ["Ali Ben Salah", "Brahim Trabelsi", "Chokri Jlassi", "Dhaker Mejri", "Elyes Haddad", "Fathi Gharbi"]);
  const byGov = (await list("sort=governorate")).body.applications.map((a) => a.governorate);
  assert.deepEqual(byGov, [...byGov].sort((a, b) => a.localeCompare(b)));
  const bad = await list("sort=nimporte_quoi");
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: "invalid_filter", field: "sort" });
});

test("pagination : taille de page, total, nombre de pages, page hors limites vide", async () => {
  const p1 = (await list("page_size=4")).body;
  assert.equal(p1.applications.length, 4);
  assert.deepEqual([p1.total, p1.page, p1.pages], [6, 1, 2]);
  const p2 = (await list("page_size=4&page=2")).body;
  assert.equal(p2.applications.length, 2);
  assert.deepEqual(names(p1).concat(names(p2)).sort(), ROWS.map((r) => r.name).sort(), "aucun doublon ni oubli entre les pages");
  const beyond = (await list("page_size=4&page=9")).body;
  assert.deepEqual([beyond.applications.length, beyond.total, beyond.pages], [0, 6, 2]);
  assert.equal((await list("page_size=500")).body.applications.length, 6, "taille plafonnée à 100, sans erreur");
  assert.equal((await list("page=abc")).status, 400);
  assert.equal((await list("page=0")).status, 400);
});

test("valeurs invalides : 400 avec le nom du champ, jamais d'erreur SQL ni d'injection", async () => {
  for (const [qs, field] of [["governorate=Paris", "governorate"], ["line_type=cargo", "line_type"], ["kyc=ok", "kyc"], ["status=hacked", "status"], ["governorate=Gafsa'%20OR%201=1--", "governorate"]]) {
    const r = await list(qs);
    assert.equal(r.status, 400, qs);
    assert.deepEqual(r.body, { error: "invalid_filter", field });
  }
  assert.equal((await list("governorate=Gafsa&governorate=Tunis")).status, 400, "paramètre répété refusé");
});

test("recherche : nom, téléphone, référence ou CIN ; caractères génériques traités comme du texte", async () => {
  assert.deepEqual(names((await list("q=trabel")).body), ["Brahim Trabelsi"]);
  assert.deepEqual(names((await list("q=20000003")).body), ["Dhaker Mejri"]);
  assert.deepEqual(names((await list("q=LX-LIST4")).body), ["Elyes Haddad"]);
  assert.deepEqual(names((await list("q=90000002")).body), ["Chokri Jlassi"], "recherche par CIN");
  assert.equal((await list("q=%25")).body.total, 0, "« % » n'est pas un joker");
  assert.deepEqual(names((await list("q=ali&governorate=Gafsa")).body), ["Ali Ben Salah"], "recherche + filtre");
});

test("journal d'accès : la consultation de la liste est tracée sans le texte recherché", async () => {
  await list("q=SECRET-RECHERCHE-12345&governorate=Gafsa");
  const res = await fetch(`${base}/api/admin/audit?limit=20`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const { entries } = await res.json();
  assert.ok(entries.some((e) => e.action === "applications_list"));
  assert.ok(!JSON.stringify(entries).includes("SECRET-RECHERCHE-12345"));
});
