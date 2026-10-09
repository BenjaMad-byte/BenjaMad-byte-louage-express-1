import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tempData, fakePortal, portalDriver, fakeSms, clock, tokenOf } from "./_helpers.js";

const PW = "chauffeur2026"; // mot de passe de test : 13 caractères, variété suffisante, ne contient pas le matricule

const dataDir = tempData();
const OPS = "ops-service-key-0123456789";
const APP_URL = "https://app.louage-express.test"; // config fixe (PUBLIC_URL), indépendante du port éphémère du test
const now = clock();
const portal = fakePortal();
const sms = fakeSms();
let db, server, base, app;

before(async () => {
  ({ db } = await import("../db.js"));
  const { createApp } = await import("../server.js");
  app = createApp({ portal, sms, otpSecret: "o".repeat(40), now, sosPhones: ["97000111", "97000222"], opsKey: OPS, rateLimits: false, forceHttps: false, appUrl: APP_URL });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const t of ["sync_log", "sos_events", "boardings", "trips", "sessions", "drivers", "lines", "otp_codes", "otp_sends", "phone_verifications"]) db.exec(`DELETE FROM ${t}`);
  portal.drivers.clear();
  portal.down = false;
  sms.sent.length = 0;
  sms.fail = false;
  now.advance(10 * 60_000); // dépasse les délais d'attente entre deux codes
});

const call = (method, url, { token, body, key, headers = {} } = {}) =>
  fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { "X-Service-Key": key } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
const json = async (res) => ({ status: res.status, body: await res.json() });

/** Simule l'acceptation d'un dossier (envoie le lien d'activation) puis l'activation par le chauffeur. @returns {Promise<string>} le jeton de session. */
async function activate(d, password = PW) {
  portal.drivers.set(d.ref, d);
  await app.locals.auth.syncApproved();
  const token = tokenOf(sms.lastLink(d.phone));
  assert.ok(token, "lien d'activation attendu par SMS");
  const r = await json(await call("POST", "/api/auth/activation/finish", { body: { token, password } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return token; // jeton d'ACTIVATION, pour les tests qui veulent vérifier qu'il ne ressert pas
}
async function loginAs(d, device = "Téléphone de test", password = PW) {
  await activate(d, password);
  const r = await json(await call("POST", "/api/auth/login", { body: { plate: d.plate, password, device } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}
let seq = 0;
const act = (type, payload = {}, id) => ({ id: id ?? `act-${type}-${++seq}-${Math.random().toString(36).slice(2, 8)}`, seq, type, payload, createdAt: new Date(now()).toISOString() });
const sync = async (token, actions) => json(await call("POST", "/api/driver/sync", { token, body: { actions } }));
const stateOf = async (token) => (await json(await call("GET", "/api/driver/state", { token }))).body;

test("acceptation : la synchronisation envoie un lien d'activation personnel, jamais pour un chauffeur déjà connu", async () => {
  const d = portalDriver();
  portal.drivers.set(d.ref, d);
  const r1 = await app.locals.auth.syncApproved();
  assert.deepEqual([r1.updated, r1.activationsSent, r1.deactivated], [1, 1, 0]);
  const link = sms.lastLink(d.phone);
  assert.match(link, new RegExp(`^${APP_URL}/activer\\?jeton=`));
  assert.ok(sms.sent.at(-1).text.includes("تم قبولك") && sms.sent.at(-1).text.includes("vous êtes accepté"), "message bilingue");

  const r2 = await app.locals.auth.syncApproved(); // ressynchronisation : même chauffeur, aucun nouveau lien
  assert.deepEqual([r2.updated, r2.activationsSent], [1, 0]);
  assert.equal(sms.sent.filter((s) => s.phone === d.phone).length, 1);
});

test("activation : le jeton affiche le matricule, le chauffeur choisit son mot de passe et est connecté tout de suite", async () => {
  const d = portalDriver();
  portal.drivers.set(d.ref, d);
  await app.locals.auth.syncApproved();
  const token = tokenOf(sms.lastLink(d.phone));

  const info = await json(await call("POST", "/api/auth/activation", { body: { token } }));
  assert.deepEqual([info.status, info.body.plate, info.body.name], [200, d.plate, d.full_name]);
  assert.ok(!JSON.stringify(info.body).match(/hash|CHAUFFEUR2026/i));

  const weak = await json(await call("POST", "/api/auth/activation/finish", { body: { token, password: "123" } }));
  assert.deepEqual([weak.status, weak.body.reason], [400, "too_short"]);
  const samePlate = await json(await call("POST", "/api/auth/activation/finish", { body: { token, password: d.plate } }));
  assert.equal(samePlate.body.reason, "is_plate");

  const r = await json(await call("POST", "/api/auth/activation/finish", { body: { token, password: PW, device: "Premier téléphone" } }));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.name, r.body.plate], [d.full_name, d.plate]);
  assert.equal((await call("GET", "/api/driver/state", { token: r.body.token })).status, 200, "connecté tout de suite, sans connexion séparée");
});

test("activation : jeton inconnu, expiré ou déjà utilisé = refusé ; un second envoi invalide le premier lien", async () => {
  const d = portalDriver();
  portal.drivers.set(d.ref, d);
  await app.locals.auth.syncApproved();
  const first = tokenOf(sms.lastLink(d.phone));

  assert.equal((await call("POST", "/api/auth/activation", { body: { token: "nimporte-quoi" } })).status, 410);
  now.advance(8 * 24 * 3_600_000); // plus de 7 jours
  assert.equal((await call("POST", "/api/auth/activation", { body: { token: first } })).status, 410);
  now.advance(-8 * 24 * 3_600_000);

  const id = db.prepare("SELECT id FROM drivers WHERE portal_ref = ?").get(d.ref).id;
  const resend = await json(await call("POST", `/api/ops/drivers/${id}/resend-activation`, { key: OPS }));
  assert.equal(resend.status, 200);
  assert.equal((await call("POST", "/api/auth/activation", { body: { token: first } })).status, 410, "l'ancien lien ne vaut plus rien");
  const second = tokenOf(sms.lastLink(d.phone));
  assert.notEqual(first, second);
  assert.equal((await call("POST", "/api/auth/activation/finish", { body: { token: second, password: PW } })).status, 200);
  assert.equal((await call("POST", "/api/auth/activation/finish", { body: { token: second, password: PW } })).status, 410, "un lien déjà utilisé ne ressert pas");
});

test("connexion : matricule + mot de passe ; réponse unique si mauvais matricule ou mauvais mot de passe, réponse distincte si pas encore activé", async () => {
  const d = portalDriver();
  await activate(d);
  assert.equal((await json(await call("POST", "/api/auth/login", { body: { plate: d.plate, password: PW } }))).status, 200);
  assert.equal((await call("POST", "/api/auth/login", { body: { plate: d.plate, password: "mauvais mot de passe" } })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { body: { plate: "999 TUN 9999", password: PW } })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { body: { plate: "  " + d.plate.toLowerCase() + "  ", password: PW } })).status, 200, "insensible à la casse et aux espaces");

  const notYet = portalDriver();
  portal.drivers.set(notYet.ref, notYet);
  await app.locals.auth.syncApproved();
  const refused = await json(await call("POST", "/api/auth/login", { body: { plate: notYet.plate, password: "n'importe quoi" } }));
  assert.deepEqual([refused.status, refused.body.error], [409, "not_activated"], "le matricule n'est pas secret : le dire n'aide pas à deviner un mot de passe");
});

test("blocage : 5 mauvais mots de passe verrouillent le compte 15 minutes, même avec le bon mot de passe ensuite", async () => {
  const d = portalDriver();
  await activate(d);
  for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/auth/login", { body: { plate: d.plate, password: "faux" } })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { body: { plate: d.plate, password: PW } })).status, 401, "verrouillé : même le bon mot de passe est refusé");
  now.advance(16 * 60_000);
  assert.equal((await call("POST", "/api/auth/login", { body: { plate: d.plate, password: PW } })).status, 200, "déblocage automatique après 15 min");
});

test("mot de passe oublié : code reçu par téléphone puis nouveau mot de passe ; les autres appareils sont déconnectés", async () => {
  const d = portalDriver();
  const first = await loginAs(d); // un appareil déjà connecté
  assert.equal((await call("GET", "/api/driver/state", { token: first })).status, 200);

  assert.equal((await call("POST", "/api/auth/recover/send-code", { body: { phone: d.phone } })).status, 200);
  const code = sms.lastCode(d.phone);
  const NEW_PW = "autre-mot-2passe";
  const wrong = await json(await call("POST", "/api/auth/recover/reset", { body: { phone: d.phone, code: "000000", password: NEW_PW } }));
  assert.equal(wrong.body.error, "otp_invalid");
  assert.equal((await call("POST", "/api/auth/recover/send-code", { body: { phone: "98999999" } })).status, 200);
  const unknown = await json(await call("POST", "/api/auth/recover/reset", { body: { phone: "98999999", code: sms.lastCode("98999999"), password: NEW_PW } }));
  assert.equal(unknown.status, 404, "code valide mais aucun compte chauffeur pour ce numéro");

  const r = await json(await call("POST", "/api/auth/recover/reset", { body: { phone: d.phone, code, password: NEW_PW, device: "Nouveau téléphone" } }));
  assert.equal(r.status, 200);
  assert.equal((await call("GET", "/api/driver/state", { token: first })).status, 401, "l'ancien appareil est déconnecté");
  assert.equal((await call("POST", "/api/auth/login", { body: { plate: d.plate, password: PW } })).status, 401, "l'ancien mot de passe ne marche plus");
  assert.equal((await call("POST", "/api/auth/login", { body: { plate: d.plate, password: NEW_PW } })).status, 200);
});

test("accès : sans jeton, avec un faux jeton, après déconnexion, ou chauffeur retiré par le site d'inscription = refusé", async () => {
  const d = portalDriver();
  const token = await loginAs(d);
  assert.equal((await call("GET", "/api/driver/state")).status, 401);
  assert.equal((await call("GET", "/api/driver/state", { token: "faux" })).status, 401);
  assert.equal((await call("POST", "/api/driver/sync", { body: { actions: [] } })).status, 401);
  assert.equal((await call("GET", "/api/driver/state", { token })).status, 200);

  // Le chauffeur supprime sa demande (ou n'est plus accepté) : la synchronisation périodique ferme son accès.
  portal.drivers.delete(d.ref);
  assert.deepEqual(await app.locals.auth.syncApproved(), { updated: 0, activationsSent: 0, deactivated: 1 });
  assert.equal((await call("GET", "/api/driver/state", { token })).status, 401);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);

  const other = portalDriver();
  const t2 = await loginAs(other);
  assert.equal((await call("POST", "/api/auth/logout", { token: t2 })).status, 200);
  assert.equal((await call("GET", "/api/driver/state", { token: t2 })).status, 401);
});

test("session : 30 jours glissants, puis expirée", async () => {
  const token = await loginAs(portalDriver());
  now.advance(20 * 24 * 3_600_000);
  assert.equal((await call("GET", "/api/driver/state", { token })).status, 200, "20 jours : valide, et prolongée");
  now.advance(20 * 24 * 3_600_000);
  assert.equal((await call("GET", "/api/driver/state", { token })).status, 200, "encore 20 jours plus tard : prolongée par l'usage");
  now.advance(31 * 24 * 3_600_000);
  assert.equal((await call("GET", "/api/driver/state", { token })).status, 401);
});

test("entrer dans la file, déclarer des passagers, partir : le serveur applique le moteur de règles", async () => {
  const token = await loginAs(portalDriver());
  let r = await sync(token, [act("join_queue")]);
  assert.equal(r.body.results[0].status, "applied");
  assert.deepEqual([r.body.state.trip.status, r.body.state.trip.position, r.body.state.trip.stops], ["queued", { rank: 1, size: 1 }, ["Redeyef", "Metlaoui", "Gafsa"]]);
  assert.equal((await sync(token, [act("join_queue")])).body.results[0].reason, "already_in_queue");

  r = await sync(token, [act("board"), act("board"), act("board", { from: 0, to: 1 })]);
  assert.deepEqual(r.body.results.map((x) => x.status), ["applied", "applied", "applied"]);
  assert.deepEqual([r.body.state.trip.summary.onboardNow, r.body.state.trip.summary.freeNow, r.body.state.trip.summary.freeFrom], [3, 5, [5, 6, 0]]);

  r = await sync(token, [act("depart")]);
  assert.equal(r.body.state.trip.status, "en_route");
  r = await sync(token, [act("arrive", { stop: 1 })]);
  assert.deepEqual([r.body.state.trip.currentStop, r.body.state.trip.summary.onboardNow], [1, 2], "le passager de Métlaoui est descendu");
  r = await sync(token, [act("board", { from: 1, to: 2 })]);
  assert.equal(r.body.state.trip.summary.onboardNow, 3, "passager monté en route");
  r = await sync(token, [act("arrive", { stop: 2 }), act("finish")]);
  assert.equal(r.body.state.trip, null, "voyage terminé : le chauffeur peut se remettre dans la file");
  assert.equal((await sync(token, [act("join_queue")])).body.results[0].status, "applied");
});

test("jamais plus de passagers que de places : l'action en trop est rejetée avec sa raison", async () => {
  const token = await loginAs(portalDriver());
  await sync(token, [act("set_capacity", { capacity: 3 }), act("join_queue")]);
  const r = await sync(token, [act("board"), act("board"), act("board"), act("board"), act("board")]);
  assert.deepEqual(r.body.results.map((x) => x.status), ["applied", "applied", "applied", "conflict_rejected", "conflict_rejected"]);
  assert.equal(r.body.results[3].reason, "seat_full_conflict");
  assert.equal(r.body.state.trip.summary.onboardNow, 3);
  assert.equal((await sync(token, [act("set_capacity", { capacity: 5 })])).body.results[0].reason, "trip_in_progress");
});

test("hors ligne : un lot est rejoué dans l'ordre du numéro d'ordre de l'appareil (pas l'ordre d'arrivée, pas l'horloge), une seule fois chaque", async () => {
  const token = await loginAs(portalDriver());
  const join = act("join_queue");
  const b1 = act("board");
  const b2 = act("board");
  // Arrivés dans le désordre, avec une horloge de téléphone fausse : le numéro d'ordre décide.
  const shuffled = [{ ...b2, createdAt: "2001-01-01T00:00:00Z" }, { ...join, createdAt: "2030-01-01T00:00:00Z" }, b1];
  const r = await sync(token, shuffled);
  assert.deepEqual(r.body.results.map((x) => x.id), [join.id, b1.id, b2.id]);
  assert.deepEqual(r.body.results.map((x) => x.status), ["applied", "applied", "applied"]);

  const replay = await sync(token, [join, b1, b2]);
  assert.deepEqual(replay.body.results.map((x) => x.status), ["noop_already_applied", "noop_already_applied", "noop_already_applied"]);
  assert.equal(replay.body.state.trip.summary.onboardNow, 2, "rejouer ne double rien (réseau coupé au milieu d'une synchronisation)");
});

test("lot invalide : identifiant manquant, type inconnu, taille, charge utile absurde", async () => {
  const token = await loginAs(portalDriver());
  const r = await sync(token, [{ type: "board", payload: {} }, { id: "court", type: "board" }, act("teleporter"), { ...act("alight"), payload: { boardingId: 42, at: "x" } }, { ...act("board"), payload: "pas un objet" }]);
  assert.deepEqual(r.body.results.map((x) => x.reason), ["bad_action_id", "bad_action_id", "unknown_action", "no_trip", "no_trip"]);
  assert.equal((await call("POST", "/api/driver/sync", { token, body: {} })).status, 400);
  assert.equal((await call("POST", "/api/driver/sync", { token, body: { actions: Array.from({ length: 201 }, () => act("board")) } })).status, 413);
  const none = await sync(token, []);
  assert.deepEqual(none.body.results, []);
});

test("passager monté en route avec descente anticipée, arrêts personnalisés, départ hors tour signalé", async () => {
  const a = await loginAs(portalDriver());
  const b = await loginAs(portalDriver());
  const joinA = act("join_queue", { stops: ["Redeyef", "Gafsa"] });
  assert.equal((await sync(a, [joinA])).body.state.trip.stops.length, 2);
  assert.equal((await sync(a, [act("leave_queue")])).body.results[0].status, "applied");
  assert.equal((await sync(a, [act("join_queue", { stops: ["seul"] })])).body.results[0].reason, "bad_stops");
  assert.equal((await sync(a, [act("join_queue", { stops: ["A", " "] })])).body.results[0].reason, "bad_stops");
  assert.equal((await sync(a, [act("join_queue")])).body.state.trip.position.rank, 1);
  assert.equal((await sync(b, [act("join_queue")])).body.state.trip.position.rank, 2, "même ligne : b est derrière a");
  const out = await sync(b, [act("depart")]);
  assert.deepEqual(out.body.results[0].data, { outOfTurn: true, rank: 2 }, "b part avant a : permis mais signalé");
  assert.equal(out.body.state.trip.status, "en_route");
  assert.equal((await stateOf(a)).trip.position.rank, 1);
});

test("un chauffeur ne voit et ne modifie que son propre voyage", async () => {
  const a = await loginAs(portalDriver());
  const b = await loginAs(portalDriver());
  await sync(a, [act("join_queue"), act("board")]);
  assert.equal((await stateOf(b)).trip, null);
  const intrus = await sync(b, [act("alight", { boardingId: "act-board-1", at: 1 })]);
  assert.equal(intrus.body.results[0].reason, "no_trip");
  assert.equal((await stateOf(a)).trip.summary.onboardNow, 1);
  const dump = JSON.stringify(await stateOf(b));
  assert.ok(!dump.includes(a.slice(0, 10)), "le jeton d'un autre n'apparaît jamais");
});

test("SOS : toujours enregistré, SMS immédiat à la permanence, relances jusqu'à l'accusé de réception, jamais bloqué par un conflit", async () => {
  const d = portalDriver();
  const token = await loginAs(d);
  sms.sent.length = 0;
  const alarm = act("sos", { lat: 34.4205, lon: 8.1342, accuracy: 25, ageS: 4, trigger: "triple_tap" });
  const r = await sync(token, [alarm]);
  assert.equal(r.body.results[0].status, "applied", "même sans voyage en cours");
  await app.locals.sos.flush();
  const alerts = sms.sent.filter((s) => s.text.startsWith("SOS LOUAGE"));
  assert.deepEqual(alerts.map((s) => s.phone).sort(), ["97000111", "97000222"]);
  assert.ok(alerts[0].text.includes(d.full_name) && alerts[0].text.includes(d.plate) && alerts[0].text.includes("maps?q=34.42050,8.13420"), alerts[0].text);

  assert.equal((await sync(token, [alarm])).body.results[0].status, "noop_already_applied");
  await app.locals.sos.flush();
  assert.equal(sms.sent.filter((s) => s.text.startsWith("SOS LOUAGE")).length, 2, "rejouer ne renvoie pas d'alerte");

  now.advance(60_000);
  assert.equal(await app.locals.sos.tick(), 0, "trop tôt pour une relance");
  now.advance(70_000);
  assert.equal(await app.locals.sos.tick(), 1);
  assert.ok(sms.sent.at(-1).text.includes("rappel 2"));
  assert.equal((await call("GET", "/api/ops/sos", { key: OPS })).status, 200);
  const sosId = (await json(await call("GET", "/api/ops/sos", { key: OPS }))).body.sos[0].id;
  assert.equal((await call("POST", `/api/ops/sos/${sosId}/ack`, { key: OPS, body: { by: "permanence" } })).status, 200);
  now.advance(10 * 60_000);
  const before = sms.sent.length;
  assert.equal(await app.locals.sos.tick(), 0, "accusé de réception : plus de relance");
  assert.equal(sms.sent.length, before);
});

test("SOS : SMS en échec = alerte conservée et relancée ; position absente ou invalide acceptée ; faux déclenchement annulé", async () => {
  const token = await loginAs(portalDriver());
  sms.fail = true;
  const bad = act("sos", { lat: "n'importe quoi", lon: 999, trigger: "inconnu" });
  const r = await sync(token, [bad]);
  assert.equal(r.body.results[0].status, "applied");
  await app.locals.sos.flush();
  const ev = db.prepare("SELECT * FROM sos_events").get();
  assert.deepEqual([ev.lat, ev.lon, ev.trigger, ev.status, ev.alerts_sent], [null, null, "button", "open", 1]);
  sms.fail = false;
  now.advance(130_000);
  await app.locals.sos.tick();
  assert.ok(sms.sent.some((s) => s.text.includes("position inconnue")));

  const cancel = await sync(token, [act("sos_cancel", { target: bad.id, note: "doigt malheureux" })]);
  assert.equal(cancel.body.results[0].status, "applied");
  await app.locals.sos.flush();
  assert.equal(db.prepare("SELECT status FROM sos_events").get().status, "cancelled");
  assert.ok(sms.sent.at(-1).text.startsWith("SOS ANNULÉ"));
  assert.equal((await sync(token, [act("sos_cancel", { target: "inconnu" })])).body.results[0].reason, "unknown_sos");
});

test("exploitation : clé requise, vue d'ensemble des files, synchronisation, révocation", async () => {
  assert.equal((await call("GET", "/api/ops/overview")).status, 401);
  assert.equal((await call("GET", "/api/ops/overview", { key: "mauvaise-cle-0123456789" })).status, 401);
  const a = await loginAs(portalDriver());
  const b = await loginAs(portalDriver());
  await sync(a, [act("join_queue"), act("board")]);
  await sync(b, [act("join_queue")]);
  const ov = await json(await call("GET", "/api/ops/overview", { key: OPS }));
  assert.equal(ov.status, 200);
  assert.deepEqual([ov.body.lines.length, ov.body.lines[0].queue.map((q) => q.rank), ov.body.lines[0].queue[0].onboardNow, ov.body.drivers], [1, [1, 2], 1, { total: 2, active: 2 }]);
  const id = db.prepare("SELECT id FROM drivers LIMIT 1").get().id;
  assert.equal((await call("POST", `/api/ops/drivers/${id}/revoke`, { key: OPS })).status, 200);
  assert.equal((await call("POST", "/api/ops/drivers/999/revoke", { key: OPS })).status, 404);
  assert.equal((await call("GET", "/api/driver/state", { token: a })).status, 401);
  const synced = await json(await call("POST", "/api/ops/drivers/sync", { key: OPS }));
  assert.equal(synced.status, 200);
  portal.down = true;
  assert.equal((await call("POST", "/api/ops/drivers/sync", { key: OPS })).status, 503);
});

test("villes proposées pour « passe par » : toutes les délégations du pays, avec leur gouvernorat, sans authentification", async () => {
  const r = await json(await call("GET", "/api/places"));
  assert.equal(r.status, 200);
  assert.ok(r.body.places.length > 250, "les 264 délégations du pays");
  assert.deepEqual(r.body.places.find((p) => p.fr === "Oum El Araies"), { fr: "Oum El Araies", ar: "أم العرائس", governorate: "Gafsa" });
  assert.ok(r.body.places.some((p) => p.fr === "Om Larayes" && p.governorate === "Gafsa"), "variante d'écriture proposée aussi, pas seulement l'orthographe officielle");
});

test("sécurité : écriture depuis un autre site refusée, jamais de cache sur l'API, en-têtes stricts, API inconnue en JSON", async () => {
  const res = await call("POST", "/api/auth/login", { body: { plate: "000 TUN 0000", password: "n'importe quoi" }, headers: { Origin: "https://evil.example" } });
  assert.equal(res.status, 403);
  const state = await call("GET", "/api/driver/state");
  assert.match(state.headers.get("cache-control"), /no-store/);
  const csp = state.headers.get("content-security-policy");
  assert.ok(csp.includes("script-src 'self'") && !csp.includes("unsafe-inline") && csp.includes("worker-src 'self'"));
  assert.match(state.headers.get("permissions-policy"), /geolocation=\(self\)/);
  assert.equal(state.headers.get("x-powered-by"), null);
  assert.equal((await call("GET", "/api/rien")).status, 404);
  assert.equal((await call("GET", "/healthz")).status, 200);
});
