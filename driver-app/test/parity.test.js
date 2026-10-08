import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tempData, portalDriver } from "./_helpers.js";
import { applyLocal } from "../public/local.js";

const dataDir = tempData();
let db, createActionService, buildState, createDriverAuth;

before(async () => {
  ({ db } = await import("../db.js"));
  ({ createActionService, buildState } = await import("../actions.js"));
  ({ createDriverAuth } = await import("../auth.js"));
});
after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

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

const view = (trip) => trip && { status: trip.status, currentStop: trip.currentStop, capacity: trip.capacity, stops: trip.stops, boardings: trip.boardings.map(({ id, from, to, source, status }) => ({ id, from, to, source, status })) };
const category = (s) => (s === "noop" || s === "noop_already_applied" ? "noop" : s);

test("PARITÉ : le téléphone (public/local.js) et le serveur (actions.js) donnent le même résultat sur 300 suites d'actions aléatoires", () => {
  const auth = createDriverAuth({ db, portal: {}, otp: {} });
  const noSos = { record: () => ({ event: { id: "x" } }), cancel: () => ({ status: "applied" }) };
  const service = createActionService({ db, sos: noSos });
  const types = ["join_queue", "board", "board", "board", "alight", "arrive", "depart", "finish", "leave_queue", "set_capacity"];

  for (let seed = 1; seed <= 300; seed++) {
    for (const t of ["sync_log", "boardings", "trips", "lines", "drivers"]) db.exec(`DELETE FROM ${t}`);
    const driver = auth.upsertDriver(portalDriver({ line_via: seed % 2 ? ["Métlaoui"] : [] }));
    const rand = rng(seed * 104729);
    const int = (n) => Math.floor(rand() * n);
    let local = buildState(db, driver);
    let n = 0;
    for (let step = 0; step < 30; step++) {
      const type = types[int(types.length)];
      const trip = local.trip;
      let payload = {};
      if (type === "board" && int(3) === 0 && trip) { const from = trip.currentStop; payload = { from, to: from + 1 + int(Math.max(trip.stops.length - 1 - from, 1)) }; }
      if (type === "alight" && trip?.boardings.length) { const b = trip.boardings[int(trip.boardings.length)]; payload = { boardingId: b.id, at: b.from + int(b.to - b.from + 1) }; }
      if (type === "arrive" && trip) payload = { stop: Math.min(trip.currentStop + 1, trip.stops.length - 1) };
      if (type === "set_capacity") payload = { capacity: 1 + int(10) };
      if (type === "join_queue" && int(2)) payload = { stops: ["Redeyef", "Gafsa"] };
      const action = { id: `p${seed}-${String(++n).padStart(4, "0")}-${type}`, seq: n, type, payload, createdAt: "2026-10-08T10:00:00Z" };

      const localOut = applyLocal(local, action);
      const serverOut = service.apply(driver, action);
      const where = `graine ${seed}, étape ${step} (${type} ${JSON.stringify(payload)})`;
      assert.equal(category(localOut.result.status), category(serverOut.status), `${where} : statut local ${localOut.result.status} ≠ serveur ${serverOut.status}`);
      if (localOut.result.status !== "rejected" && localOut.result.status !== "conflict_rejected") local = localOut.state;
      const serverTrip = buildState(db, db.prepare("SELECT * FROM drivers WHERE id = ?").get(driver.id)).trip;
      assert.deepEqual(view(local.trip), view(serverTrip), `${where} : voyage différent`);
    }
  }
});
