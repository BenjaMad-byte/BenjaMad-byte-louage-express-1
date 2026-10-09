import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tempData, portalDriver, fakeSms, clock } from "./_helpers.js";

const dataDir = tempData();
const SECRET = "s".repeat(40);
const now = clock();
const sms = fakeSms();
let db, app, server, base, sva, signCallback;

before(async () => {
  ({ db } = await import("../db.js"));
  const sv = await import("../sva.js");
  signCallback = sv.signCallback;
  sva = sv.createSimulatedSva();
  const { createApp } = await import("../server.js");
  app = createApp({ portal: { async lookup() { return null; }, async approved() { return []; } }, sms, sva, svaSecret: SECRET, reservationsEnabled: true, holdMs: 3 * 60_000, otpSecret: "o".repeat(40), now, sosPhones: [], opsKey: "k".repeat(20), rateLimits: false, forceHttps: false });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const t of ["reservations", "sync_log", "boardings", "trips", "lines", "drivers", "sos_events"]) db.exec(`DELETE FROM ${t}`);
  sva.charges.clear();
  sva.refunds.length = 0;
  sms.sent.length = 0;
  sms.fail = false;
  now.advance(60 * 60_000);
});

const post = async (url, body) => { const r = await fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
let seq = 0;
const act = (type, payload = {}) => ({ id: `r-${type}-${++seq}-${Math.random().toString(36).slice(2, 7)}`, seq, type, payload, createdAt: new Date(now()).toISOString() });

/** Un chauffeur dans la file de la ligne Redeyef → Gafsa. */
function driverInQueue(over = {}, capacity = 8) {
  const d = app.locals.auth.upsertDriver(portalDriver(over));
  db.prepare("UPDATE drivers SET capacity = ? WHERE id = ?").run(capacity, d.id);
  const driver = db.prepare("SELECT * FROM drivers WHERE id = ?").get(d.id);
  const res = app.locals.actions.apply(driver, act("join_queue"));
  assert.equal(res.status, "applied");
  return driver;
}
const doAct = (driver, type, payload) => app.locals.actions.apply(db.prepare("SELECT * FROM drivers WHERE id = ?").get(driver.id), act(type, payload));
const lineId = () => db.prepare("SELECT id FROM lines").get().id;
const reserve = (phone, over = {}) => post("/api/passenger/reservations", { lineId: lineId(), from: "Redeyef", to: "Gafsa", phone, operator: "ooredoo", deposit: 1500, lang: "fr", ...over });
const settle = (reservationId) => post("/api/demo/sva/settle", { reservationId });
const reservationId = (code) => db.prepare("SELECT id FROM reservations WHERE code = ?").get(code).id;
const stateOf = (driver) => app.locals.actions && import("../actions.js").then(({ buildState }) => buildState(db, db.prepare("SELECT * FROM drivers WHERE id = ?").get(driver.id), { codeOf: app.locals.reservations.codeOfBoarding }));

test("lignes proposées aux passagers : seulement celles qui ont un louage, sans nom ni téléphone de chauffeur", async () => {
  assert.deepEqual((await (await fetch(base + "/api/passenger/lines")).json()).lines, []);
  const d = driverInQueue();
  const out = await (await fetch(base + "/api/passenger/lines")).json();
  assert.deepEqual(out.lines.map((l) => [l.from, l.toGov, l.stops, l.freeAtOrigin]), [["Redeyef", "Gafsa", ["Redeyef", "Metlaoui", "Gafsa"], 8]]);
  assert.deepEqual([out.operators, out.deposits], [["tt", "ooredoo", "orange"], [1500, 2000]]);
  const dump = JSON.stringify(out);
  assert.ok(!dump.includes(d.full_name) && !dump.includes(d.phone) && !dump.includes(d.plate));
});

test("lignes proposées aux passagers : un chauffeur qui fait le trajet retour (arrêts inversés) apparaît sur une AUTRE ligne que l'aller, jamais mélangé", async () => {
  driverInQueue(); // Redeyef → Gafsa, par défaut
  const back = app.locals.auth.upsertDriver(portalDriver());
  const backDriver = db.prepare("SELECT * FROM drivers WHERE id = ?").get(back.id);
  const res = app.locals.actions.apply(backDriver, act("join_queue", { stops: ["Gafsa", "Metlaoui", "Redeyef"] }));
  assert.equal(res.status, "applied");
  const out = await (await fetch(base + "/api/passenger/lines")).json();
  const byFrom = Object.fromEntries(out.lines.map((l) => [l.from, l]));
  assert.deepEqual(Object.keys(byFrom).sort(), ["Gafsa", "Redeyef"], "deux lignes distinctes, pas une file mélangée");
  assert.deepEqual(byFrom.Redeyef.stops, ["Redeyef", "Metlaoui", "Gafsa"]);
  assert.deepEqual(byFrom.Gafsa.stops, ["Gafsa", "Metlaoui", "Redeyef"]);
});

test("arrêt tapé par le chauffeur : une variante d'écriture reconnue (« Om Larayes ») est ramenée au nom officiel (« Oum El Araies »)", async () => {
  const d = portalDriver();
  const driver = app.locals.auth.upsertDriver(d);
  const row = db.prepare("SELECT * FROM drivers WHERE id = ?").get(driver.id);
  const res = app.locals.actions.apply(row, act("join_queue", { stops: ["Gafsa", "Om Larayes", "Redeyef"] }));
  assert.equal(res.status, "applied");
  const out = await (await fetch(base + "/api/passenger/lines")).json();
  assert.deepEqual(out.lines[0].stops, ["Gafsa", "Oum El Araies", "Redeyef"]);
});

test("réservation : la place est retenue dans le voyage du n° 1, le paiement est demandé, rien n'est confirmé avant le retour de l'opérateur", async () => {
  const a = driverInQueue();
  const r = await reserve("97111222");
  assert.equal(r.status, 201);
  assert.match(r.body.reservation.code, /^[A-HJ-KM-NP-Z2-9]{6}$/);
  assert.deepEqual([r.body.reservation.status, r.body.reservation.from, r.body.reservation.to, r.body.reservation.depositMillimes], ["pending_sva", "Redeyef", "Gafsa", 1500]);
  assert.equal(r.body.reservation.plate, undefined, "pas de plaque tant que ce n'est pas confirmé");
  assert.ok(r.body.reservation.expiresAt > now());
  assert.equal(sva.charges.size, 1);
  assert.deepEqual([...sva.charges.values()].map((c) => [c.phone, c.operator, c.amountMillimes]), [["97111222", "ooredoo", 1500]]);
  const st = await stateOf(a);
  assert.deepEqual([st.trip.summary.reservedNow, st.trip.summary.onboardNow, st.trip.summary.freeNow], [1, 0, 7]);
  assert.equal(sms.sent.length, 0, "aucun SMS de confirmation avant le paiement");
});

test("confirmation : le chauffeur voit le CODE, le passager reçoit un SMS avec le code et la plaque, puis tout se passe en une montée", async () => {
  const a = driverInQueue();
  const r = await reserve("97111222");
  const code = r.body.reservation.code;
  assert.equal((await settle(reservationId(code))).status, 200);
  await app.locals.reservations.flush();
  const sent = sms.sent.find((s) => s.phone === "97111222");
  assert.ok(sent.text.includes(code) && sent.text.includes(a.plate), sent.text);
  const st = await stateOf(a);
  const b = st.trip.boardings.find((x) => x.source === "reservation");
  assert.deepEqual([b.status, b.code], ["reserved", code], "le chauffeur voit le code à comparer avec celui du passager");
  const status = await post("/api/passenger/reservations/status", { code, phone: "97111222" });
  assert.deepEqual([status.body.reservation.status, status.body.reservation.plate], ["confirmed", a.plate]);
  assert.equal((await post("/api/passenger/reservations/status", { code, phone: "97999999" })).status, 404, "le code seul ne suffit pas : il faut aussi le téléphone");

  // Le passager monte : le chauffeur confirme (même hors ligne, l'identifiant du passager est dans son état).
  assert.equal(doAct(a, "confirm_boarding", { boardingId: b.id }).status, "applied");
  assert.equal((await post("/api/passenger/reservations/status", { code, phone: "97111222" })).body.reservation.status, "boarded");
  assert.equal((await stateOf(a)).trip.summary.onboardNow, 1);
});

test("remplissage séquentiel STRICT : le n° 1 reçoit tout jusqu'à être plein, ensuite le n° 2", async () => {
  const a = driverInQueue({}, 2);
  const b = driverInQueue({}, 2);
  const phones = ["97000001", "97000002", "97000003"];
  for (const p of phones) assert.equal((await reserve(p)).status, 201);
  const trips = db.prepare("SELECT d.id AS did, COUNT(*) AS n FROM boardings x JOIN trips t ON t.id = x.trip_id JOIN drivers d ON d.id = t.driver_id GROUP BY d.id").all();
  assert.deepEqual(Object.fromEntries(trips.map((t) => [t.did, t.n])), { [a.id]: 2, [b.id]: 1 });
  assert.equal((await reserve("97000004")).status, 201);
  const full = await reserve("97000005");
  assert.deepEqual([full.status, full.body.error], [409, "no_trip_available"], "tout est plein");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reservations").get().n, 4, "aucune réservation fantôme");
});

test("retour de l'opérateur : signature HMAC exigée (fausse, absente, corps modifié = refusé) ; un retour rejoué ne change rien", async () => {
  driverInQueue();
  const id = reservationId((await reserve("97111222")).body.reservation.code);
  const raw = JSON.stringify({ reservationId: id, status: "success", providerRef: "OP-1" });
  const send = (body, sig) => fetch(base + "/api/sva/callback", { method: "POST", headers: { "Content-Type": "application/json", ...(sig ? { "X-Signature": sig } : {}) }, body });
  assert.equal((await send(raw)).status, 401);
  assert.equal((await send(raw, "sha256=" + "0".repeat(64))).status, 401);
  assert.equal((await send(raw, signCallback(raw, "mauvais-secret"))).status, 401);
  assert.equal((await send(raw.replace("success", "failed"), signCallback(raw, SECRET))).status, 401, "corps modifié après signature");
  assert.equal(db.prepare("SELECT status FROM reservations").get().status, "pending_sva");
  assert.equal((await send(raw, signCallback(raw, SECRET))).status, 200);
  assert.deepEqual({ ...db.prepare("SELECT status, sva_ref FROM reservations").get() }, { status: "confirmed", sva_ref: "OP-1" });
  assert.equal((await send(raw, signCallback(raw, SECRET))).status, 200, "rejoué");
  assert.equal(sms.sent.filter((s) => s.phone === "97111222").length, 1, "un seul SMS de confirmation");
  const ghost = JSON.stringify({ reservationId: "inconnu", status: "success" });
  assert.equal((await send(ghost, signCallback(ghost, SECRET))).status, 404);
  const weird = JSON.stringify({ reservationId: id, status: "peut-etre" });
  assert.equal((await send(weird, signCallback(weird, SECRET))).status, 400);
});

test("paiement refusé (solde insuffisant) : la réservation est annulée et la place libérée aussitôt", async () => {
  const a = driverInQueue();
  const r = await reserve("97111200"); // « …00 » = solde insuffisant dans la simulation
  assert.equal((await stateOf(a)).trip.summary.reservedNow, 1);
  await settle(reservationId(r.body.reservation.code));
  assert.equal(db.prepare("SELECT status FROM reservations").get().status, "cancelled");
  const st = await stateOf(a);
  assert.deepEqual([st.trip.summary.reservedNow, st.trip.summary.freeNow], [0, 8]);
});

test("retenue non payée dans les 3 minutes : annulée et libérée ; un paiement qui arrive TARD est remboursé automatiquement", async () => {
  const a = driverInQueue();
  const r = await reserve("97111222");
  const id = reservationId(r.body.reservation.code);
  now.advance(2 * 60_000);
  assert.equal(app.locals.reservations.expire(), 0, "2 minutes : encore valable");
  now.advance(2 * 60_000);
  assert.equal(app.locals.reservations.expire(), 1);
  assert.equal(db.prepare("SELECT status FROM reservations").get().status, "cancelled");
  assert.equal((await stateOf(a)).trip.summary.freeNow, 8);

  const late = await post("/api/demo/sva/settle", { reservationId: id });
  assert.deepEqual([late.status, late.body.refunded], [200, true]);
  assert.deepEqual(sva.refunds.map((x) => x.amountMillimes), [1500], "l'argent est rendu");
  assert.equal(db.prepare("SELECT status FROM reservations").get().status, "refunded");
  assert.equal((await stateOf(a)).trip.summary.freeNow, 8, "la place n'est pas reprise");
  assert.equal(sms.sent.some((s) => s.phone === "97111222" && s.text.includes("confirmée")), false, "pas de fausse confirmation");
});

test("annulation par le passager : retenue libérée ; réservation confirmée = remboursée ; déjà montée = refusée", async () => {
  const a = driverInQueue();
  const first = (await reserve("97111222")).body.reservation.code;
  assert.deepEqual((await post("/api/passenger/reservations/cancel", { code: first, phone: "97111222" })).body, { ok: true });
  assert.equal((await stateOf(a)).trip.summary.freeNow, 8);

  const second = (await reserve("97111222")).body.reservation.code;
  await settle(reservationId(second));
  const c = await post("/api/passenger/reservations/cancel", { code: second, phone: "97111222" });
  assert.deepEqual(c.body, { ok: true, refunded: true });
  assert.equal(sva.refunds.length, 1);
  assert.equal(db.prepare("SELECT status FROM reservations WHERE code = ?").get(second).status, "refunded");

  const third = (await reserve("97111222")).body.reservation.code;
  await settle(reservationId(third));
  const b = (await stateOf(a)).trip.boardings.find((x) => x.code === third);
  doAct(a, "confirm_boarding", { boardingId: b.id });
  assert.equal((await post("/api/passenger/reservations/cancel", { code: third, phone: "97111222" })).status, 409);
  assert.equal((await post("/api/passenger/reservations/cancel", { code: third, phone: "97000000" })).status, 404);
});

test("LA PRÉSENCE PHYSIQUE GAGNE : un passager en espèces prend la place de la réservation la plus récente, qui est réattribuée à un autre louage et prévenue par SMS", async () => {
  const a = driverInQueue({}, 2);
  const b = driverInQueue({}, 2);
  const old = (await reserve("97000001")).body.reservation.code;
  const recent = (await reserve("97000002")).body.reservation.code;
  await settle(reservationId(old));
  await settle(reservationId(recent));
  sms.sent.length = 0;

  assert.equal(doAct(a, "board").status, "applied", "le chauffeur A fait monter un passager en espèces : le louage est plein de retenues");
  await app.locals.reservations.flush();
  const rows = Object.fromEntries(db.prepare("SELECT code, trip_id, status FROM reservations").all().map((r) => [r.code, r]));
  const aTrip = db.prepare("SELECT id FROM trips WHERE driver_id = ?").get(a.id).id;
  const bTrip = db.prepare("SELECT id FROM trips WHERE driver_id = ?").get(b.id).id;
  assert.deepEqual([rows[old].trip_id, rows[old].status], [aTrip, "confirmed"], "la plus ancienne garde sa place");
  assert.deepEqual([rows[recent].trip_id, rows[recent].status], [bTrip, "confirmed"], "la plus récente est réattribuée au n° 2");
  const msg = sms.sent.find((s) => s.phone === "97000002");
  assert.ok(msg.text.includes(b.plate) && msg.text.includes(recent), msg.text);
  assert.equal((await stateOf(a)).trip.summary.onboardNow, 1);
  assert.equal((await stateOf(b)).trip.boardings.find((x) => x.source === "reservation").code, recent);
  assert.equal(sva.refunds.length, 0, "personne n'est remboursé : tout le monde a une place");
});

test("LA PRÉSENCE PHYSIQUE GAGNE : sans autre louage disponible, la réservation déplacée est remboursée et le passager prévenu", async () => {
  const a = driverInQueue({}, 1);
  const code = (await reserve("97000002")).body.reservation.code;
  await settle(reservationId(code));
  sms.sent.length = 0;
  assert.equal(doAct(a, "board").status, "applied");
  await app.locals.reservations.flush();
  assert.equal(db.prepare("SELECT status FROM reservations").get().status, "displaced");
  assert.deepEqual(sva.refunds.map((r) => r.amountMillimes), [1500]);
  assert.ok(sms.sent.some((s) => s.phone === "97000002" && s.text.includes("remboursé")));
  const st = await stateOf(a);
  assert.deepEqual([st.trip.summary.onboardNow, st.trip.summary.reservedNow], [1, 0]);
});

test("départ : la réservation du premier arrêt non montée devient « no_show » ; celle d'un arrêt suivant reste valable", async () => {
  const a = driverInQueue();
  const atOrigin = (await reserve("97000001")).body.reservation.code;
  const atMetlaoui = (await reserve("97000002", { from: "Metlaoui" })).body.reservation.code;
  await settle(reservationId(atOrigin));
  await settle(reservationId(atMetlaoui));
  assert.equal(doAct(a, "depart").status, "applied");
  const status = (c) => db.prepare("SELECT status FROM reservations WHERE code = ?").get(c).status;
  assert.deepEqual([status(atOrigin), status(atMetlaoui)], ["no_show", "confirmed"]);
  doAct(a, "arrive", { stop: 1 });
  const bId = (await stateOf(a)).trip.boardings.find((x) => x.code === atMetlaoui).id;
  assert.equal(doAct(a, "confirm_boarding", { boardingId: bId }).status, "applied");
  assert.equal(status(atMetlaoui), "boarded");
});

test("arrêt intermédiaire : la réservation de Métlaoui va au louage déjà parti qui n'a pas dépassé Métlaoui", async () => {
  const a = driverInQueue();
  const b = driverInQueue();
  doAct(a, "depart");
  const r = await reserve("97000003", { from: "Metlaoui" });
  assert.equal(r.status, 201);
  const tripOf = (d) => db.prepare("SELECT id FROM trips WHERE driver_id = ?").get(d.id).id;
  assert.equal(db.prepare("SELECT trip_id FROM reservations").get().trip_id, tripOf(a), "le louage en route, pas celui qui attend à la gare");
  doAct(a, "arrive", { stop: 1 });
  doAct(a, "arrive", { stop: 2 });
  const r2 = await reserve("97000004", { from: "Metlaoui" });
  assert.equal(r2.status, 201);
  assert.equal(db.prepare("SELECT trip_id FROM reservations WHERE passenger_phone = '97000004'").get().trip_id, tripOf(b), "a a dépassé Métlaoui : on prend celui de la gare");
});

test("arrêt intermédiaire, cas limite : le louage vient JUSTE d'arriver à Métlaoui (pas reparti) — une réservation depuis Métlaoui va à CE louage, pas à celui qui attend à la gare", async () => {
  const a = driverInQueue(); // en route, va arriver à Métlaoui
  const b = driverInQueue(); // toujours à la gare
  doAct(a, "depart");
  doAct(a, "arrive", { stop: 1 }); // pile à Métlaoui : currentStop === l'arrêt demandé, pas encore reparti vers Gafsa
  const r = await reserve("97000005", { from: "Metlaoui" });
  assert.equal(r.status, 201);
  const tripOf = (d) => db.prepare("SELECT id FROM trips WHERE driver_id = ?").get(d.id).id;
  assert.equal(db.prepare("SELECT trip_id FROM reservations WHERE passenger_phone = '97000005'").get().trip_id, tripOf(a), "le louage présent à Métlaoui, pas celui encore à la gare de Redeyef");
});

test("garde-fous : opérateur, acompte, arrêts, ligne, téléphone, trop de réservations ouvertes ; jamais de retenue fantôme", async () => {
  driverInQueue();
  const bad = async (over, error, status = 400) => { const r = await reserve("97111222", over); assert.deepEqual([r.status, r.body.error], [status, error], JSON.stringify(over)); };
  await bad({ operator: "bitcoin" }, "invalid_operator");
  await bad({ deposit: 1 }, "invalid_deposit");
  await bad({ from: "" }, "invalid_stops");
  await bad({ to: 12 }, "invalid_stops");
  await bad({ lineId: 999 }, "unknown_line", 404);
  await bad({ from: "Gafsa", to: "Redeyef" }, "no_trip_available", 409);
  await bad({ to: "Tozeur" }, "no_trip_available", 409);
  assert.equal((await post("/api/passenger/reservations", { lineId: lineId(), from: "Redeyef", to: "Gafsa", phone: "abc", operator: "tt", deposit: 1500 })).body.error, "invalid_phone");
  assert.equal((await reserve("97111222")).status, 201);
  assert.equal((await reserve("97111222")).status, 201);
  await bad({}, "too_many_active", 429);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reservations").get().n, 2);
});

test("opérateur injoignable au moment du prélèvement : réservation annulée, place libérée, erreur claire", async () => {
  const a = driverInQueue();
  const real = sva.charge;
  sva.charge = async () => { throw new Error("opérateur en panne"); };
  try {
    const r = await reserve("97111222");
    assert.deepEqual([r.status, r.body.error], [503, "sva_unavailable"]);
  } finally {
    sva.charge = real;
  }
  assert.equal(db.prepare("SELECT status FROM reservations").get().status, "cancelled");
  assert.equal((await stateOf(a)).trip.summary.freeNow, 8);
});

test("réservations désactivées par défaut ; callbacks fermés sans secret ; démonstration indisponible avec un autre fournisseur", async () => {
  const { createApp } = await import("../server.js");
  const off = createApp({ portal: {}, sms, sva, reservationsEnabled: false, otpSecret: "o".repeat(40), now, sosPhones: [], rateLimits: false, forceHttps: false });
  const s = off.listen(0);
  try {
    const url = `http://127.0.0.1:${s.address().port}`;
    assert.equal((await fetch(url + "/api/passenger/lines")).status, 503);
    assert.equal((await fetch(url + "/api/sva/callback", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 503);
    assert.equal((await fetch(url + "/api/demo/sva/settle", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 404, "sans fournisseur simulé, la route de démonstration n'existe pas");
  } finally {
    s.close();
  }
});

test("données de passagers : supprimées 30 jours après la fin de la réservation, jamais avant", async () => {
  driverInQueue();
  const code = (await reserve("97111222")).body.reservation.code;
  await app.locals.reservations.cancel({ code, phone: "97111222" });
  assert.equal(app.locals.reservations.purgeOld(), 0);
  now.advance(29 * 86_400_000);
  assert.equal(app.locals.reservations.purgeOld(), 0);
  now.advance(2 * 86_400_000);
  assert.equal(app.locals.reservations.purgeOld(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reservations").get().n, 0);
  const active = (await reserve("97111222")).body.reservation.code;
  now.advance(90 * 86_400_000);
  assert.equal(app.locals.reservations.purgeOld(), 0, "une réservation encore ouverte n'est jamais purgée");
  assert.ok(db.prepare("SELECT 1 FROM reservations WHERE code = ?").get(active));
});
