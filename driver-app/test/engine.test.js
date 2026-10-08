import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../public/engine.js";

const trip = (over = {}) => ({ id: "t1", capacity: 4, stops: ["Redeyef", "Métlaoui", "Gafsa"], currentStop: 0, status: "queued", queueSeq: 1, boardings: [], ...over });
const b = (id, from, to, status = "onboard", extra = {}) => ({ id, from, to, source: status === "reserved" ? "reservation" : "cash", status, createdAt: `2026-10-08T10:0${id.length}:00Z`, ...extra });
const apply = (t, ...steps) => steps.reduce((acc, fn) => fn(acc).trip, t);

test("tronçons : un passager Redeyef→Gafsa occupe les deux tronçons, un Métlaoui→Gafsa seulement le second", () => {
  const t = trip({ boardings: [b("a", 0, 2), b("bb", 1, 2), b("c", 0, 1)] });
  assert.deepEqual(E.loads(t), [2, 2]);
  assert.equal(E.segmentCount(t), 2);
  assert.equal(E.freeOnSegments(t, 0, 2), 2);
  assert.equal(E.freeOnSegments(t, 0, 1), 2);
  assert.equal(E.freeOnSegments(t, 1, 2), 2);
});

test("places libres par arrêt : un passager qui descend à Métlaoui libère sa place pour la suite du trajet", () => {
  const t = trip({ boardings: [b("a", 0, 1), b("bb", 0, 2), b("c", 0, 2), b("d", 0, 2)] });
  assert.deepEqual(E.loads(t), [4, 3]);
  assert.deepEqual(E.freeFrom(t), [0, 1, 0], "à Métlaoui une place pour Gafsa ; à Redeyef plus rien ; à l'arrivée 0 par construction");
  assert.equal(E.canBoard(t, 0, 2).ok, false);
  assert.equal(E.canBoard(t, 1, 2).ok, true, "un passager de Métlaoui à Gafsa peut monter");
  assert.equal(E.canBoard(t, 0, 1).reason, "seat_full_conflict");
});

test("canBoard : arrêts incohérents, voyage fermé, arrêt déjà dépassé", () => {
  const t = trip();
  for (const [from, to] of [[1, 1], [2, 1], [-1, 1], [0, 3], [0.5, 1], ["0", 1], [0, undefined]]) assert.equal(E.canBoard(t, from, to).reason, "bad_segment", `${from}→${to}`);
  assert.equal(E.canBoard(trip({ status: "done" }), 0, 1).reason, "trip_closed");
  assert.equal(E.canBoard(trip({ status: "cancelled" }), 0, 1).reason, "trip_closed");
  assert.equal(E.canBoard(trip({ status: "en_route", currentStop: 1 }), 0, 2).reason, "stop_already_passed");
  assert.equal(E.canBoard(trip({ status: "en_route", currentStop: 1 }), 1, 2).ok, true);
  assert.equal(E.canBoard(trip({ stops: ["Seul"] }), 0, 0).reason, "bad_segment");
});

test("board : remplit jusqu'à la capacité puis refuse, jamais de dépassement", () => {
  let t = trip();
  for (const id of ["a", "bb", "c", "d"]) {
    const r = E.board(t, { id, from: 0, to: 2 });
    assert.equal(r.result.status, "applied");
    t = r.trip;
  }
  const over = E.board(t, { id: "e", from: 0, to: 2 });
  assert.deepEqual(over.result, { status: "conflict_rejected", reason: "seat_full_conflict" });
  assert.equal(over.trip, t, "voyage inchangé");
  assert.equal(E.summary(t).full, true);
});

test("board : idempotent (même identifiant = aucun effet), immuable (l'original n'est jamais modifié)", () => {
  const t = trip();
  const first = E.board(t, { id: "a", from: 0, to: 2 });
  assert.equal(t.boardings.length, 0, "l'original est intact");
  assert.equal(Object.isFrozen(first.trip), false);
  const again = E.board(first.trip, { id: "a", from: 0, to: 2 });
  assert.deepEqual(again.result, { status: "noop" });
  assert.equal(again.trip, first.trip);
  assert.equal(again.trip.boardings.length, 1);
});

test("passager monté en route : à Métlaoui, sur le second tronçon seulement, la capacité se vérifie tronçon par tronçon", () => {
  let t = trip({ status: "en_route", currentStop: 1, boardings: [b("a", 0, 2), b("bb", 0, 2), b("c", 0, 2), b("d", 0, 1)] });
  assert.equal(E.summary(t).onboardNow, 3, "à Métlaoui, d est descendu (il allait à Métlaoui)");
  const r = E.board(t, { id: "e", from: 1, to: 2 });
  assert.equal(r.result.status, "applied");
  assert.equal(E.summary(r.trip).full, true);
  assert.equal(E.board(r.trip, { id: "f", from: 1, to: 2 }).result.reason, "seat_full_conflict");
  assert.equal(E.board(t, { id: "g", from: 0, to: 2 }).result.reason, "stop_already_passed");
});

test("la présence physique gagne : un passager en espèces déplace la réservation LA PLUS RÉCENTE, jamais un passager déjà monté", () => {
  const t = trip({
    capacity: 3,
    boardings: [
      b("a", 0, 2, "onboard"),
      b("r1", 0, 2, "reserved", { createdAt: "2026-10-08T09:00:00Z" }),
      b("r2", 0, 2, "reserved", { createdAt: "2026-10-08T09:30:00Z" }),
    ],
  });
  const r = E.board(t, { id: "cash1", from: 0, to: 2, source: "cash", createdAt: "2026-10-08T10:00:00Z" });
  assert.deepEqual(r.result, { status: "applied", displaced: ["r2"] });
  const byId = Object.fromEntries(r.trip.boardings.map((x) => [x.id, x.status]));
  assert.deepEqual(byId, { a: "onboard", r1: "reserved", r2: "displaced", cash1: "onboard" });
  assert.deepEqual(E.loads(r.trip), [3, 3]);
});

test("la présence physique gagne : plusieurs retenues déplacées si nécessaire, dans l'ordre inverse de leur ancienneté", () => {
  const t = trip({
    capacity: 2,
    boardings: [
      b("r1", 0, 2, "reserved", { createdAt: "2026-10-08T09:00:00Z" }),
      b("r2", 0, 2, "reserved", { createdAt: "2026-10-08T09:10:00Z" }),
    ],
  });
  const one = E.board(t, { id: "c1", from: 0, to: 2 });
  assert.deepEqual(one.result.displaced, ["r2"]);
  const two = E.board(one.trip, { id: "c2", from: 0, to: 2 });
  assert.deepEqual(two.result.displaced, ["r1"]);
  assert.deepEqual(E.loads(two.trip), [2, 2]);
  const three = E.board(two.trip, { id: "c3", from: 0, to: 2 });
  assert.equal(three.result.status, "conflict_rejected", "plein de passagers montés : impossible de dépasser la capacité réelle");
  assert.equal(three.trip, two.trip);
});

test("déplacement ciblé : on ne déplace pas une réservation qui n'occupe pas le tronçon saturé", () => {
  const t = trip({
    capacity: 2,
    boardings: [b("a", 1, 2, "onboard"), b("bb", 1, 2, "reserved", { createdAt: "2026-10-08T09:00:00Z" }), b("early", 0, 1, "reserved", { createdAt: "2026-10-08T09:30:00Z" })],
  });
  const r = E.board(t, { id: "c", from: 1, to: 2 });
  assert.deepEqual(r.result.displaced, ["bb"], "« early » n'occupe que le premier tronçon : elle n'est pas touchée même si elle est plus récente");
  assert.equal(r.trip.boardings.find((x) => x.id === "early").status, "reserved");
});

test("une réservation ne déplace jamais personne : plein = refusée", () => {
  const t = trip({ capacity: 1, boardings: [b("r1", 0, 2, "reserved")] });
  const r = E.board(t, { id: "r2", from: 0, to: 2, source: "reservation" });
  assert.equal(r.result.status, "conflict_rejected");
  assert.equal(E.board(t, { id: "r3", from: 0, to: 2, source: "reservation" }).trip, t);
});

test("alight : descendre plus tôt libère les tronçons suivants ; à l'arrêt de montée, annule", () => {
  const t = trip({ capacity: 1, boardings: [b("a", 0, 2)] });
  assert.equal(E.canBoard(t, 1, 2).ok, false);
  const r = E.alight(t, "a", 1);
  assert.deepEqual(r.result, { status: "applied" });
  assert.deepEqual(E.loads(r.trip), [1, 0]);
  assert.equal(E.canBoard(r.trip, 1, 2).ok, true, "la place est libre dès Métlaoui");
  assert.equal(E.alight(t, "a", 0).trip.boardings[0].status, "cancelled");
  assert.equal(E.alight(t, "a", 2).result.status, "noop");
  assert.equal(E.alight(t, "a", 3).result.reason, "bad_segment");
  assert.equal(E.alight(t, "zz", 1).result.reason, "unknown_boarding");
  assert.equal(E.alight(E.release(t, "a").trip, "a", 1).result.status, "noop", "déjà parti");
});

test("réservation → montée : « reserved » devient « onboard » ; refus propres", () => {
  const t = trip({ boardings: [b("r1", 0, 2, "reserved"), b("a", 0, 2)] });
  assert.equal(E.confirmOnboard(t, "r1").trip.boardings[0].status, "onboard");
  assert.equal(E.confirmOnboard(t, "a").result.status, "noop");
  assert.equal(E.confirmOnboard(t, "zz").result.reason, "unknown_boarding");
  const released = E.release(t, "r1", "cancelled").trip;
  assert.equal(E.confirmOnboard(released, "r1").result.reason, "not_reserved");
  assert.deepEqual(E.loads(released), [1, 1], "la retenue annulée libère la place");
});

test("départ : les réservations non montées au premier arrêt deviennent no_show ; un voyage parti ne repart pas", () => {
  const t = trip({ boardings: [b("r1", 0, 2, "reserved"), b("r2", 1, 2, "reserved"), b("a", 0, 2)] });
  const r = E.depart(t, "2026-10-08T11:00:00Z");
  assert.deepEqual(r.result, { status: "applied", noShows: ["r1"] });
  assert.equal(r.trip.status, "en_route");
  assert.equal(r.trip.boardings.find((x) => x.id === "r2").status, "reserved", "la réservation de Métlaoui reste valable");
  assert.equal(E.depart(r.trip).result.status, "noop");
  assert.equal(E.depart(trip({ status: "done" })).result.status, "rejected");
});

test("arrivée à un arrêt : descente automatique à destination, no_show des réservations dépassées, retour en arrière refusé", () => {
  let t = E.depart(trip({ boardings: [b("a", 0, 1), b("bb", 0, 2), b("r", 1, 2, "reserved")] })).trip;
  const r = E.arriveAt(t, 1);
  assert.equal(r.trip.currentStop, 1);
  assert.equal(r.trip.boardings.find((x) => x.id === "a").status, "alighted");
  assert.equal(r.trip.boardings.find((x) => x.id === "bb").status, "onboard");
  assert.equal(r.trip.boardings.find((x) => x.id === "r").status, "reserved", "elle monte justement à cet arrêt");
  const last = E.arriveAt(r.trip, 2);
  assert.deepEqual(last.result.noShows, ["r"]);
  assert.equal(E.arriveAt(last.trip, 1).result.reason, "bad_segment");
  assert.equal(E.arriveAt(last.trip, 2).result.status, "noop");
  assert.equal(E.arriveAt(t, 9).result.reason, "bad_segment");
});

test("finish : ferme le voyage et solde tout le monde", () => {
  const t = trip({ status: "en_route", boardings: [b("a", 0, 2), b("r", 1, 2, "reserved")] });
  const r = E.finish(t, "2026-10-08T14:00:00Z");
  assert.equal(r.trip.status, "done");
  assert.deepEqual(r.trip.boardings.map((x) => x.status), ["alighted", "no_show"]);
  assert.deepEqual(E.loads(r.trip), [0, 0]);
  assert.equal(E.finish(r.trip).result.status, "noop");
});

test("summary : places occupées, retenues et libres au point où se trouve le louage", () => {
  const t = trip({ boardings: [b("a", 0, 2), b("r", 0, 2, "reserved")] });
  assert.deepEqual(E.summary(t), { capacity: 4, stops: t.stops, currentStop: 0, onboardNow: 1, reservedNow: 1, freeNow: 2, freeFrom: [2, 2, 0], full: false });
  assert.equal(E.summary(trip({ stops: ["Seul"] })).freeNow, 0);
});

test("file d'attente : ordre d'arrivée, rang, voyages partis exclus", () => {
  const ts = [trip({ id: "c", queueSeq: 3 }), trip({ id: "a", queueSeq: 1 }), trip({ id: "bb", queueSeq: 2, status: "filling" }), trip({ id: "gone", queueSeq: 0, status: "en_route" })];
  assert.deepEqual(E.orderQueue(ts).map((x) => x.id), ["a", "bb", "c"]);
  assert.equal(E.rankOf(ts, "a"), 1);
  assert.equal(E.rankOf(ts, "c"), 3);
  assert.equal(E.rankOf(ts, "gone"), null);
  assert.equal(E.rankOf(ts, "nope"), null);
});

test("attribution d'une réservation à la gare : remplissage séquentiel STRICT, le n° 1 d'abord, le n° 2 seulement quand le n° 1 est plein", () => {
  const first = trip({ id: "n1", queueSeq: 1, capacity: 2, boardings: [b("a", 0, 2)] });
  const second = trip({ id: "n2", queueSeq: 2, capacity: 2 });
  assert.equal(E.chooseTripForReservation([second, first], 0, 2).id, "n1");
  const full = E.board(first, { id: "bb", from: 0, to: 2 }).trip;
  assert.equal(E.chooseTripForReservation([full, second], 0, 2).id, "n2", "le n° 1 est plein : on passe au n° 2");
  const both = E.board(second, { id: "c1", from: 0, to: 2 }).trip;
  assert.equal(E.chooseTripForReservation([full, E.board(both, { id: "c2", from: 0, to: 2 }).trip], 0, 2), null, "tout est plein");
  assert.equal(E.chooseTripForReservation([], 0, 2), null);
});

test("attribution à un arrêt intermédiaire : le voyage parti le plus proche qui n'a pas dépassé l'arrêt, sinon la file", () => {
  const stops = ["A", "B", "C", "D"];
  const near = trip({ id: "near", stops, status: "en_route", currentStop: 1, departedAt: "2026-10-08T09:00:00Z" });
  const far = trip({ id: "far", stops, status: "en_route", currentStop: 0, departedAt: "2026-10-08T08:00:00Z" });
  const passed = trip({ id: "passed", stops, status: "en_route", currentStop: 3 });
  const queued = trip({ id: "q", stops, queueSeq: 1 });
  assert.equal(E.chooseTripForReservation([far, near, passed, queued], 2, 3).id, "near", "le plus avancé qui n'a pas dépassé C");
  assert.equal(E.chooseTripForReservation([far, passed], 2, 3).id, "far");
  assert.equal(E.chooseTripForReservation([passed, queued], 2, 3).id, "q", "aucun voyage parti disponible : la file");
  const nearFull = E.board(trip({ id: "near", stops, capacity: 1, status: "en_route", currentStop: 1 }), { id: "x", from: 1, to: 3 }).trip;
  assert.equal(E.chooseTripForReservation([nearFull, far], 2, 3).id, "far", "le plus proche n'a plus de place sur ce tronçon");
  assert.equal(E.chooseTripForReservation([passed], 1, 3), null);
  assert.equal(E.chooseTripForReservation([trip({ id: "z", stops, status: "done" })], 0, 1), null, "un voyage terminé n'est jamais choisi");
});

// ---------------------------------------------------------------- test de propriété
/** Générateur pseudo-aléatoire reproductible (mulberry32) : un échec se rejoue avec la même graine. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("PROPRIÉTÉ : quelle que soit la suite d'actions (5 000 séquences), aucun tronçon ne dépasse jamais la capacité, et rejouer deux fois change tout autant rien", () => {
  for (let seed = 1; seed <= 5000; seed++) {
    const rand = rng(seed);
    const int = (n) => Math.floor(rand() * n);
    const stopsN = 2 + int(4);
    let t = trip({ capacity: 1 + int(8), stops: Array.from({ length: stopsN }, (_, i) => `S${i}`), status: rand() < 0.5 ? "queued" : "en_route", currentStop: 0 });
    const log = [];
    for (let step = 0; step < 40; step++) {
      const k = int(100);
      const from = int(stopsN - 1);
      const to = from + 1 + int(stopsN - 1 - from);
      const id = `b${step}`;
      let r;
      if (k < 40) r = E.board(t, { id, from, to, source: "cash", createdAt: `2026-10-08T10:${String(step).padStart(2, "0")}:00Z` });
      else if (k < 65) r = E.board(t, { id, from, to, source: "reservation", createdAt: `2026-10-08T09:${String(step).padStart(2, "0")}:00Z` });
      else if (k < 75 && t.boardings.length) r = E.confirmOnboard(t, t.boardings[int(t.boardings.length)].id);
      else if (k < 83 && t.boardings.length) r = E.release(t, t.boardings[int(t.boardings.length)].id, "cancelled");
      else if (k < 91 && t.boardings.length) { const x = t.boardings[int(t.boardings.length)]; r = E.alight(t, x.id, x.from + int(x.to - x.from + 1)); }
      else if (k < 96) r = E.arriveAt(t, Math.min(t.currentStop + 1, stopsN - 1));
      else r = E.depart(t, "2026-10-08T11:00:00Z");
      log.push(k);
      t = r.trip;
      const l = E.loads(t);
      assert.ok(l.every((x) => x <= t.capacity), `graine ${seed}, étape ${step} : tronçon au-dessus de la capacité (${l} > ${t.capacity})`);
      assert.ok(E.loads(t, { includeReserved: false }).every((x, i) => x <= l[i]));
      // Rejouer la même action ne change rien (idempotence) pour tout ajout.
      if (r.result.status === "applied" && (k < 65)) assert.equal(E.board(t, { id, from, to }).result.status, "noop");
    }
    // Aucun passager monté n'a jamais été déplacé : « displaced » ne concerne que des réservations.
    assert.ok(t.boardings.filter((x) => x.status === "displaced").every((x) => x.source === "reservation"), `graine ${seed} : un passager physique a été déplacé`);
  }
});

test("PROPRIÉTÉ : l'ordre d'arrivée des passagers en espèces ne change pas le nombre de passagers montés tant que rien n'est réservé", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rand = rng(seed * 7919);
    const int = (n) => Math.floor(rand() * n);
    const cap = 1 + int(5);
    const requests = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, from: 0, to: 2 }));
    const run = (list) => list.reduce((t, r) => E.board(t, { ...r, source: "cash" }).trip, trip({ capacity: cap }));
    const shuffled = [...requests].sort(() => rand() - 0.5);
    assert.equal(run(requests).boardings.length, Math.min(cap, 12));
    assert.equal(run(shuffled).boardings.length, Math.min(cap, 12));
  }
});

test("réservations à la même milliseconde : la dernière ajoutée est déplacée la première (jamais un ordre arbitraire)", () => {
  const same = "2026-10-08T09:00:00.000Z";
  const t = trip({ capacity: 2, boardings: [b("first", 0, 2, "reserved", { createdAt: same }), b("later", 0, 2, "reserved", { createdAt: same })] });
  const r = E.board(t, { id: "cash", from: 0, to: 2 });
  assert.deepEqual(r.result.displaced, ["later"]);
  assert.equal(r.trip.boardings.find((x) => x.id === "first").status, "reserved");
});

test("chooseTripForReservation avec arrêts propres à chaque voyage : une fonction (voyage → arrêts) ; null = ce voyage ne dessert pas la demande", () => {
  const a = trip({ id: "a", queueSeq: 1, stops: ["X", "Y", "Z"] });
  const bb = trip({ id: "bb", queueSeq: 2, stops: ["X", "Z"] });
  const by = (names) => (t) => { const from = t.stops.indexOf(names[0]); const to = t.stops.indexOf(names[1]); return from >= 0 && to > from ? { from, to } : null; };
  assert.equal(E.chooseTripForReservation([a, bb], by(["X", "Z"])).id, "a");
  assert.equal(E.chooseTripForReservation([a, bb], by(["Y", "Z"])).id, "a", "arrêt intermédiaire, seul « a » dessert Y");
  assert.equal(E.chooseTripForReservation([bb], by(["Y", "Z"])), null);
  assert.equal(E.chooseTripForReservation([E.board(a, { id: "p", from: 0, to: 2 }).trip, bb], by(["X", "Z"]), undefined).id, "a");
});

test("chooseTripForReservation : un voyage EN ROUTE arrivé pile à l'arrêt demandé (currentStop === from, pas reparti) reste choisissable, cohérent avec canBoard", () => {
  const here = trip({ id: "here", stops: ["X", "Y", "Z"], status: "en_route", currentStop: 1 }); // vient d'arriver à Y
  const queued = trip({ id: "queued", stops: ["X", "Y", "Z"], queueSeq: 1 }); // encore à la gare
  const by = (names) => (t) => { const from = t.stops.indexOf(names[0]); const to = t.stops.indexOf(names[1]); return from >= 0 && to > from ? { from, to } : null; };
  assert.equal(E.canBoard(here, 1, 2).ok, true, "canBoard autorise déjà from === currentStop");
  assert.equal(E.chooseTripForReservation([here, queued], by(["Y", "Z"])).id, "here", "doit rester cohérent avec canBoard, pas rejeter sur une égalité stricte");
  const justLeft = trip({ id: "justLeft", stops: ["X", "Y", "Z"], status: "en_route", currentStop: 2 }); // a dépassé Y
  assert.equal(E.chooseTripForReservation([justLeft, queued], by(["Y", "Z"])).id, "queued", "dépassé : on retombe sur la gare");
});
