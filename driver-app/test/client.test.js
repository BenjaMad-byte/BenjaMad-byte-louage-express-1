import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DICT } from "../public/i18n.js";
import { applyLocal, rebase, queueInfo } from "../public/local.js";
import { createSync } from "../public/sync.js";
import { openStore } from "../public/store.js";
import * as E from "../public/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, "..", f), "utf8");

const base = () => ({
  serverTime: "2026-10-08T10:00:00Z", driver: { name: "A", plate: "1 TUN 1", capacity: 3, line: { from: "Redeyef", toGov: "Gafsa", type: "regional" }, pickupEnRoute: true },
  defaultStops: ["Redeyef", "Metlaoui", "Gafsa"], emergency: [{ label: "Police", number: "197" }], openSos: 0, trip: null,
});
const act = (type, payload = {}, id = `a-${type}-${Math.random().toString(36).slice(2, 10)}`) => ({ id, type, payload, createdAt: "2026-10-08T10:00:00Z" });
const run = (state, ...actions) => actions.reduce((s, a) => applyLocal(s, a).state, state);

test("applyLocal : entrer dans la file, déclarer des passagers, partir, arriver, terminer : tout fonctionne SANS réseau", () => {
  let s = run(base(), act("join_queue", {}, "join-0001"));
  assert.deepEqual([s.trip.status, s.trip.provisional, s.trip.stops, s.trip.summary.freeNow], ["queued", true, ["Redeyef", "Metlaoui", "Gafsa"], 3]);
  s = run(s, act("board", {}, "board-001"), act("board", { from: 0, to: 1 }, "board-002"));
  assert.deepEqual([s.trip.summary.onboardNow, s.trip.summary.freeFrom], [2, [1, 2, 0]]);
  s = run(s, act("depart"), act("arrive", { stop: 1 }));
  assert.deepEqual([s.trip.status, s.trip.currentStop, s.trip.summary.onboardNow], ["en_route", 1, 1], "le passager de Métlaoui est descendu");
  s = run(s, act("board", { from: 1, to: 2 }, "board-003"));
  assert.equal(s.trip.summary.onboardNow, 2);
  s = run(s, act("arrive", { stop: 2 }), act("finish"));
  assert.equal(s.trip, null);
});

test("applyLocal : refus identiques à ceux du serveur (plein, déjà dans la file, a des passagers, pas de voyage)", () => {
  let s = run(base(), act("join_queue"), act("board", {}, "b-00001"), act("board", {}, "b-00002"), act("board", {}, "b-00003"));
  const full = applyLocal(s, act("board", {}, "b-00004"));
  assert.deepEqual(full.result, { status: "conflict_rejected", reason: "seat_full_conflict" });
  assert.equal(full.state, s, "état inchangé");
  assert.equal(applyLocal(s, act("join_queue")).result.reason, "already_in_queue");
  assert.equal(applyLocal(s, act("leave_queue")).result.reason, "has_passengers");
  assert.equal(applyLocal(s, act("arrive", { stop: 1 })).result.reason, "not_en_route");
  assert.equal(applyLocal(s, act("finish")).result.reason, "not_en_route");
  assert.equal(applyLocal(base(), act("board")).result.reason, "no_trip");
  assert.equal(applyLocal(s, act("teleporter")).result.reason, "unknown_action");
  assert.equal(applyLocal(base(), act("set_capacity", { capacity: 99 })).result.reason, "bad_capacity");
  assert.equal(applyLocal(s, act("set_capacity", { capacity: 5 })).result.reason, "trip_in_progress");
  assert.equal(run(base(), act("set_capacity", { capacity: 5 })).driver.capacity, 5);
});

test("applyLocal : quitter la file à vide, SOS compté, annulation du SOS", () => {
  let s = run(base(), act("join_queue"));
  assert.equal(run(s, act("leave_queue")).trip, null);
  s = run(s, act("sos"), act("sos"));
  assert.equal(s.openSos, 2);
  assert.equal(run(s, act("sos_cancel", { target: "x" })).openSos, 1);
  assert.equal(run(base(), act("sos_cancel", {})).openSos, 0, "jamais négatif");
});

test("applyLocal : ne modifie jamais l'état reçu (immuable)", () => {
  const original = run(base(), act("join_queue"));
  const frozen = JSON.stringify(original);
  applyLocal(original, act("board"));
  applyLocal(original, act("depart"));
  assert.equal(JSON.stringify(original), frozen);
});

test("rebase : les actions pas encore envoyées sont rejouées sur l'état du serveur ; les refus sont signalés", () => {
  const server = run(base(), act("join_queue"), act("board", {}, "srv-0001"), act("board", {}, "srv-0002"));
  server.driver.capacity = 3;
  const pending = [act("board", {}, "loc-0001"), act("board", {}, "loc-0002")]; // une seule place libre
  const { state, conflicts } = rebase(server, pending);
  assert.equal(state.trip.summary.onboardNow, 3);
  assert.deepEqual(conflicts, [{ id: "loc-0002", reason: "seat_full_conflict" }]);
  assert.equal(rebase(server, []).state, server);
});

test("queueInfo : rang et nombre de louages devant", () => {
  assert.equal(queueInfo(base()), null);
  const s = base();
  s.trip = { position: { rank: 3, size: 5 } };
  assert.deepEqual(queueInfo(s), { rank: 3, ahead: 2, size: 5 });
});

// ---------------------------------------------------------------- file d'actions et synchronisation
const jsonRes = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
async function setup(handler) {
  const store = await openStore(); // IndexedDB absent sous Node : repli en mémoire (même interface)
  await store.set("token", "tok");
  const calls = [];
  const events = { updates: [], rejected: [], authLost: 0, timers: [] };
  const sync = createSync({
    store,
    fetchImpl: async (url, opts = {}) => { calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers?.Authorization }); return handler(url, opts, calls); },
    onUpdate: (u) => events.updates.push(u),
    onRejected: (r) => events.rejected.push(...r),
    onAuthLost: () => { events.authLost += 1; },
    setTimer: (fn, ms) => { events.timers.push(ms); return events.timers.length; },
    clearTimer: () => {},
  });
  return { store, sync, calls, events };
}
const okSync = (url, opts) => (url.endsWith("/sync") ? jsonRes(200, { results: JSON.parse(opts.body).actions.map((a) => ({ id: a.id, status: "applied" })), state: { ok: 1 } }) : jsonRes(200, { ok: 2 }));

test("sync : chaque action est écrite sur l'appareil AVANT l'envoi, avec un numéro d'ordre qui ne fait que croître", async () => {
  const { sync, store } = await setup(okSync);
  const a = await sync.enqueue("board");
  const b = await sync.enqueue("board", { to: 1 });
  assert.deepEqual([a.seq, b.seq], [1, 2]);
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^[A-Za-z0-9_-]{8,64}$/, "format accepté par le serveur");
  assert.deepEqual((await store.outboxAll()).map((x) => x.id), [a.id, b.id]);
  assert.equal(await store.get("seq"), 2, "le compteur survit à la fermeture de l'application");
});

test("sync : enqueue avec refus du moteur local n'enregistre rien", async () => {
  const { sync, store } = await setup(okSync);
  assert.equal(await sync.enqueue("board", {}, () => false), null);
  assert.deepEqual(await store.outboxAll(), []);
  assert.equal(await store.get("seq"), 1, "le numéro d'ordre est consommé : jamais de réutilisation");
});

test("sync : envoi réussi vide la file, enregistre l'état du serveur et prévient l'interface", async () => {
  const { sync, store, calls, events } = await setup(okSync);
  await sync.enqueue("board");
  await sync.enqueue("depart");
  const r = await sync.flush();
  assert.deepEqual(r, { ok: true, sent: 2 });
  assert.deepEqual(calls.map((c) => [c.url, c.auth]), [["/api/driver/sync", "Bearer tok"]]);
  assert.deepEqual(calls[0].body.actions.map((a) => a.type), ["board", "depart"]);
  assert.deepEqual(await store.outboxAll(), []);
  assert.deepEqual(await store.get("server"), { ok: 1 });
  assert.equal(events.updates.length, 1);
});

test("sync : sans action en attente, flush rafraîchit seulement l'état (rang dans la file)", async () => {
  const { sync, calls, store } = await setup(okSync);
  assert.deepEqual(await sync.flush(), { ok: true, sent: 0 });
  assert.deepEqual(calls.map((c) => c.url), ["/api/driver/state"]);
  assert.deepEqual(await store.get("server"), { ok: 2 });
});

test("sync : coupure réseau = rien n'est perdu, nouvel essai programmé avec un délai croissant ; au retour du réseau tout part", async () => {
  let online = false;
  const { sync, store, events } = await setup((url, opts) => { if (!online) throw new TypeError("fetch failed"); return okSync(url, opts); });
  await sync.enqueue("board");
  assert.deepEqual(await sync.flush(), { ok: false, sent: 0 });
  assert.equal((await store.outboxAll()).length, 1, "l'action reste sur l'appareil");
  await sync.flush();
  await sync.flush();
  assert.deepEqual(events.timers, [3000, 6000, 12000], "délai doublé à chaque échec");
  assert.equal(sync.lastError, "network");
  online = true;
  assert.deepEqual(await sync.flush(), { ok: true, sent: 1 });
  assert.equal(sync.lastError, null);
  assert.deepEqual(await store.outboxAll(), []);
});

test("sync : erreur serveur (500) = on garde et on réessaie ; jamais de perte", async () => {
  const { sync, store, events } = await setup(() => jsonRes(500, {}));
  await sync.enqueue("sos", { trigger: "triple_tap" });
  assert.equal((await sync.flush()).ok, false);
  assert.equal((await store.outboxAll()).length, 1);
  assert.equal(sync.lastError, "http_500");
  assert.equal(events.timers.length, 1);
});

test("sync : jeton refusé (401) = compte désactivé ou session expirée : le jeton est effacé et l'interface prévenue ; les actions restent", async () => {
  const { sync, store, events } = await setup(() => jsonRes(401, { error: "unauthorized" }));
  await sync.enqueue("board");
  assert.equal((await sync.flush()).ok, false);
  assert.equal(events.authLost, 1);
  assert.equal(await store.get("token"), null);
  assert.equal((await store.outboxAll()).length, 1);
  assert.deepEqual(await sync.flush(), { ok: false, sent: 0 }, "sans jeton, rien n'est envoyé");
});

test("sync : les actions refusées par le serveur sont signalées (place refusée) mais sortent de la file", async () => {
  const { sync, store, events } = await setup((url, opts) => jsonRes(200, { results: JSON.parse(opts.body).actions.map((a, i) => ({ id: a.id, status: i ? "conflict_rejected" : "applied", ...(i ? { reason: "seat_full_conflict" } : {}) })), state: { ok: 1 } }));
  await sync.enqueue("board");
  await sync.enqueue("board");
  await sync.flush();
  assert.deepEqual(events.rejected.map((r) => r.reason), ["seat_full_conflict"]);
  assert.deepEqual(await store.outboxAll(), []);
});

test("sync : plus de 200 actions = envoi en plusieurs lots, dans l'ordre", async () => {
  const { sync, calls, store } = await setup(okSync);
  for (let i = 0; i < 450; i++) await sync.enqueue("board");
  assert.deepEqual(await sync.flush(), { ok: true, sent: 450 });
  assert.deepEqual(calls.map((c) => c.body.actions.length), [200, 200, 50]);
  const seqs = calls.flatMap((c) => c.body.actions.map((a) => a.seq));
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.deepEqual(await store.outboxAll(), []);
});

test("sync : deux flush simultanés n'envoient jamais deux fois la même action", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { sync, calls } = await setup(async (url, opts) => { await gate; return okSync(url, opts); });
  await sync.enqueue("board");
  const first = sync.flush();
  const second = await sync.flush();
  assert.deepEqual(second, { ok: true, sent: 0 }, "le second appel voit qu'un envoi est en cours");
  release();
  assert.deepEqual(await first, { ok: true, sent: 1 });
  assert.equal(calls.filter((c) => c.url.endsWith("/sync")).length, 1);
});

// ---------------------------------------------------------------- textes
test("textes : arabe et français ont exactement les mêmes clés, aucune n'est vide", () => {
  const ar = Object.keys(DICT.ar).sort();
  const fr = Object.keys(DICT.fr).sort();
  assert.deepEqual(ar, fr);
  for (const lang of ["ar", "fr"]) for (const [k, v] of Object.entries(DICT[lang])) assert.ok(String(v).trim(), `${lang}.${k} est vide`);
  assert.ok(Object.values(DICT.ar).some((v) => /[؀-ۿ]/.test(v)));
});

test("textes : chaque clé utilisée par l'application existe, et chaque code d'erreur ou de refus du serveur a son message", () => {
  const app = read("public/app.js");
  const used = new Set([...app.matchAll(/(?<![\w.$])t\(\s*["']([a-z0-9_]+)["']/g)].map((m) => m[1]));
  for (const key of used) assert.ok(DICT.ar[key] && DICT.fr[key], `clé « ${key} » utilisée mais non définie`);
  assert.ok(used.size > 40);

  // Raisons de refus : celles du moteur et des actions.
  const reasons = new Set(Object.values(E.REASONS));
  for (const m of read("actions.js").matchAll(/reject\(["']([a-z_]+)["']\)/g)) reasons.add(m[1]);
  for (const r of ["unknown_action", "bad_action_id", "unknown_sos", "not_reserved", "unknown_boarding"]) reasons.add(r);
  for (const r of reasons) assert.ok(DICT.ar[`r_${r}`] && DICT.fr[`r_${r}`], `refus « ${r} » sans message (r_${r})`);

  // Erreurs de connexion : celles de l'API d'authentification et du service SMS.
  const errors = ["invalid_phone", "invalid_credentials", "not_activated", "token_invalid", "too_short", "too_long", "too_simple", "is_plate", "not_found", "otp_invalid", "otp_expired", "otp_locked", "otp_required", "otp_cooldown", "otp_limit", "network", "server", "sms_failed", "sms_unavailable", "rate_limited"];
  for (const e of errors) assert.ok(DICT.ar[`e_${e}`] && DICT.fr[`e_${e}`], `erreur « ${e} » sans message (e_${e})`);
});

test("l'application n'insère jamais de HTML brut (innerHTML, insertAdjacentHTML, eval)", () => {
  for (const f of ["app.js", "sync.js", "store.js", "local.js"]) {
    const code = read(`public/${f}`);
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write|\beval\(|new Function/.test(code), f);
  }
});

test("render() ne passe jamais un null littéral à replaceChildren (il écrirait le texte « null » dans la page, contrairement à h() qui filtre ses enfants)", () => {
  const app = read("public/app.js");
  const call = app.slice(app.indexOf("root.replaceChildren(...["));
  const args = call.slice(0, call.indexOf(");") + 1);
  assert.match(args, /\.filter\(Boolean\)/, "sosOverlay() peut renvoyer null : les arguments doivent être filtrés avant replaceChildren");
});

test("le service worker n'intercepte jamais l'API et met en cache tous les fichiers de l'application", () => {
  const sw = read("public/sw.js");
  assert.match(sw, /startsWith\("\/api\/"\)/);
  assert.match(sw, /__BUILD__/);
  assert.match(sw, /SHELL\.includes\(url\.pathname\)/, "seuls les fichiers listés passent par le cache");
  const shell = [...sw.match(/const SHELL = \[(.*?)\];/s)[1].matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]);
  // La page de démonstration passager n'est PAS une partie de l'application chauffeur : jamais mise en cache hors ligne.
  const files = fs.readdirSync(path.join(here, "..", "public")).filter((f) => f !== "sw.js" && !f.startsWith("passager"));
  for (const f of files) assert.ok(shell.includes(`/${f}`) || (f === "index.html" && shell.includes("/")), `/${f} absent du cache hors ligne`);
  for (const p of shell) if (p !== "/") assert.ok(fs.existsSync(path.join(here, "..", "public", p)), `${p} listé mais absent`);
});
