// Logique locale de l'application : applique une action sur l'état affiché, SANS réseau, avec le même moteur de règles que le serveur.
// Module pur (testé sous Node). Le serveur reste l'autorité : à la synchronisation, l'état local est remplacé par l'état du serveur,
// puis les actions pas encore envoyées sont rejouées par-dessus (rebase).
import * as E from "./engine.js";

const clone = (o) => (o === null || o === undefined ? o : JSON.parse(JSON.stringify(o)));

/** Voyage de l'état affiché → voyage du moteur (mêmes champs) et inversement. */
const toEngine = (t) => ({ ...t, boardings: t.boardings.map((b) => ({ ...b })) });
const fromEngine = (t, prev) => ({
  id: t.id, status: t.status, capacity: t.capacity, stops: t.stops, currentStop: t.currentStop, queueSeq: t.queueSeq ?? prev?.queueSeq ?? null,
  boardings: t.boardings.map(({ id, from, to, source, status, createdAt }) => ({ id, from, to, source, status, createdAt: createdAt ?? null })),
  position: prev?.position ?? null, provisional: prev?.provisional ?? false, summary: E.summary(t),
});

/**
 * @param {object} state  état du serveur (buildState) éventuellement déjà modifié localement
 * @param {{id: string, type: string, payload?: object, createdAt?: string}} action
 * @returns {{ state: object, result: {status: string, reason?: string, displaced?: string[], noShows?: string[]} }}
 */
export function applyLocal(state, action) {
  const payload = action.payload ?? {};
  const next = clone(state);
  const trip = next.trip;
  const done = (result = { status: "applied" }) => ({ state: next, result });
  const rejected = (reason) => ({ state, result: { status: "rejected", reason } });

  const withTrip = (fn) => {
    if (!trip) return rejected("no_trip");
    const { trip: t, result } = fn(toEngine(trip));
    if (result.status === "applied") next.trip = fromEngine(t, trip);
    return { state: result.status === "applied" ? next : state, result };
  };

  switch (action.type) {
    case "join_queue": {
      if (trip) return rejected("already_in_queue");
      const stops = payload.stops ?? state.defaultStops;
      next.trip = { id: `local-${action.id}`, status: "queued", capacity: state.driver.capacity, stops, currentStop: 0, queueSeq: null, boardings: [], position: null, provisional: true, summary: E.summary({ capacity: state.driver.capacity, stops, currentStop: 0, boardings: [] }) };
      return done();
    }
    case "leave_queue": {
      if (!trip) return { state, result: { status: "noop" } };
      if (trip.status !== "queued") return rejected("trip_already_left");
      if (trip.boardings.some((b) => b.status === "onboard")) return rejected("has_passengers");
      next.trip = null;
      return done();
    }
    case "board":
      return withTrip((t) => E.board(t, { id: action.id, from: payload.from ?? t.currentStop, to: payload.to ?? E.segmentCount(t), source: "cash", createdAt: action.createdAt ?? null }));
    case "alight":
      return withTrip((t) => E.alight(t, payload.boardingId, payload.at));
    case "arrive":
      if (trip && trip.status !== "en_route") return rejected("not_en_route");
      return withTrip((t) => E.arriveAt(t, payload.stop));
    case "depart":
      return withTrip((t) => E.depart(t, action.createdAt ?? null));
    case "finish": {
      if (!trip) return { state, result: { status: "noop" } };
      if (trip.status !== "en_route") return rejected("not_en_route");
      next.trip = null;
      return done();
    }
    case "confirm_boarding":
      return withTrip((t) => E.confirmOnboard(t, payload.boardingId));
    case "set_capacity":
      if (trip) return rejected("trip_in_progress");
      if (!Number.isInteger(payload.capacity) || payload.capacity < 1 || payload.capacity > 20) return rejected("bad_capacity");
      next.driver.capacity = payload.capacity;
      return done();
    case "sos":
      next.openSos = (next.openSos ?? 0) + 1;
      return done();
    case "sos_cancel":
      next.openSos = Math.max((next.openSos ?? 1) - 1, 0);
      return done();
    default:
      return rejected("unknown_action");
  }
}

/**
 * Rejoue des actions locales sur l'état du serveur. Une action qui échoue localement est simplement ignorée à l'affichage ;
 * le serveur dira ce qu'il en pense à l'envoi.
 * @returns {{ state: object, conflicts: {id: string, reason: string}[] }}
 */
export function rebase(serverState, pending) {
  let state = serverState;
  const conflicts = [];
  for (const action of pending) {
    const { state: s, result } = applyLocal(state, action);
    if (result.status === "rejected" || result.status === "conflict_rejected") conflicts.push({ id: action.id, reason: result.reason });
    state = s;
  }
  return { state, conflicts };
}

/** Rang et nombre de louages devant, depuis l'état (le rang vient du serveur et peut être périmé hors ligne). */
export function queueInfo(state) {
  const p = state?.trip?.position;
  return p ? { rank: p.rank, ahead: p.rank - 1, size: p.size } : null;
}
