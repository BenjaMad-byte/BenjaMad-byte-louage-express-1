// Actions du chauffeur, rejouées par le serveur (synchronisation). Règles :
//  - IDEMPOTENT : un identifiant d'action déjà appliqué ne s'applique jamais une seconde fois (le résultat enregistré est renvoyé) ;
//  - ORDONNÉ par le numéro d'ordre de l'appareil (`seq`), pas par l'horloge du téléphone (souvent fausse) ni par l'ordre d'arrivée réseau ;
//  - le SERVEUR fait autorité : le moteur (public/engine.js) décide, jamais le téléphone ;
//  - jamais de dépassement de capacité silencieux : une action impossible est rejetée avec sa raison ;
//  - le SOS passe toujours, sans règle de conflit.
import * as E from "./public/engine.js";
import { cleanStops, createTrip, defaultStops, lineKeyFor, loadTrip, openTripOf, queuePosition, resolveStop, saveTrip } from "./trips.js";

export const MAX_BATCH = 200;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const TYPES = ["join_queue", "leave_queue", "board", "alight", "arrive", "depart", "finish", "confirm_boarding", "set_capacity", "sos", "sos_cancel"];
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// ---------------------------------------------------------------- géorepérage (arrivée détectée sans geste du chauffeur)
const ARRIVAL_RADIUS_KM = 2; // rayon autour du centre de la ville : assez large pour une gare excentrée, assez serré pour ne pas déclencher trop tôt
const MIN_ACCURACY_M = 300; // position GPS trop imprécise (> 300 m) : jamais utilisée pour déclencher une arrivée toute seule
const EARTH_RADIUS_KM = 6371;
/** Distance à vol d'oiseau entre deux points (km). */
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

const noHooks = { displaced() {}, noShow() {}, boarded() {} };

export function createActionService({ db, sos, hooks = noHooks, now = Date.now }) {
  const iso = () => new Date(now()).toISOString();

  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  /** Applique le résultat d'une opération du moteur : enregistre le voyage et prévient les réservations touchées. */
  function commit(trip, result) {
    saveTrip(db, trip);
    if (result.displaced?.length) hooks.displaced(trip, result.displaced);
    if (result.noShows?.length) hooks.noShow(trip, result.noShows);
  }

  const reject = (reason) => ({ status: "rejected", reason });
  const needTrip = (driver) => openTripOf(db, driver.id);

  /**
   * Position reçue du téléphone (toutes les ~25 s pendant un voyage, voir public/app.js) : jamais une action de la file de
   * synchronisation (pas d'historique utile, une position dépassée ne vaut rien) — enregistrée tout de suite, en direct.
   * Déclenche « arrivé » TOUT SEUL si le chauffeur entre dans le rayon du prochain arrêt, sans qu'il touche le téléphone.
   * Une position trop imprécise (> 300 m, GPS faible) ne déclenche jamais, mais reste enregistrée (pour la position affichée
   * au voyageur, où l'imprécision importe moins qu'un déclenchement intempestif).
   */
  function reportPosition(driver, { lat, lon, accuracy }) {
    const trip = needTrip(driver);
    if (!trip) return { stored: false };
    db.prepare("UPDATE trips SET last_lat = ?, last_lon = ?, last_pos_at = ? WHERE id = ?").run(lat, lon, iso(), trip.id);
    if (trip.status !== "en_route") return { stored: true, arrived: false };
    if (Number.isFinite(accuracy) && accuracy > MIN_ACCURACY_M) return { stored: true, arrived: false };
    const nextIdx = trip.currentStop + 1;
    if (nextIdx >= trip.stops.length) return { stored: true, arrived: false };
    const stop = resolveStop(trip.stops[nextIdx], [driver.governorate, driver.line_to_gov].filter(Boolean));
    if (stop.lat == null) return { stored: true, arrived: false }; // ville non reconnue : pas de coordonnée, pas de déclenchement automatique
    const distanceKm = haversineKm(lat, lon, stop.lat, stop.lon);
    if (distanceKm > ARRIVAL_RADIUS_KM) return { stored: true, arrived: false, distanceKm };
    const { trip: next, result } = E.arriveAt(trip, nextIdx);
    if (result.status !== "applied") return { stored: true, arrived: false, distanceKm };
    commit(next, result);
    // Rien à faire ici (tout le monde va plus loin) : pas la peine de déranger le chauffeur, l'arrivée se note toute seule.
    // Un passager monte ou descend ici : lui seul mérite une alerte qui se voit et se sent, pour ne pas rouler devant sans s'arrêter.
    const alighting = trip.boardings.filter((b) => b.status === "onboard" && b.to === nextIdx).length;
    const toBoard = trip.boardings.filter((b) => b.status === "reserved" && b.from === nextIdx).length;
    return { stored: true, arrived: true, stop: stop.name, distanceKm, alighting, toBoard };
  }

  const handlers = {
    join_queue(driver, action) {
      if (openTripOf(db, driver.id)) return reject("already_in_queue");
      let stops = defaultStops(driver);
      if (action.payload.stops !== undefined) {
        stops = cleanStops(action.payload.stops, [driver.governorate, driver.line_to_gov].filter(Boolean));
        if (!stops) return reject("bad_stops");
      }
      const trip = createTrip(db, driver, { stops, now: iso() });
      return { status: "applied", data: { tripId: trip.id } };
    },

    leave_queue(driver) {
      const trip = needTrip(driver);
      if (!trip) return { status: "noop" };
      if (trip.status !== "queued") return reject("trip_already_left");
      if (trip.boardings.some((b) => b.status === "onboard")) return reject("has_passengers");
      const held = trip.boardings.filter((b) => b.status === "reserved").map((b) => b.id);
      let next = trip;
      for (const id of held) next = E.release(next, id, "displaced").trip;
      saveTrip(db, { ...next, status: "cancelled", endedAt: iso() });
      if (held.length) hooks.displaced(next, held);
      return { status: "applied" };
    },

    board(driver, action) {
      const trip = needTrip(driver);
      if (!trip) return reject("no_trip");
      const p = action.payload;
      const from = p.from ?? trip.currentStop;
      const to = p.to ?? E.segmentCount(trip);
      if (!isInt(from, 0, 50) || !isInt(to, 0, 50)) return reject(E.REASONS.badSegment);
      const { trip: next, result } = E.board(trip, { id: action.id, from, to, source: "cash", createdAt: iso() });
      if (result.status === "applied") commit(next, result);
      return result.displaced ? { ...result, data: { displaced: result.displaced } } : result;
    },

    alight(driver, action) {
      const trip = needTrip(driver);
      if (!trip) return reject("no_trip");
      const { boardingId, at } = action.payload;
      if (typeof boardingId !== "string" || !isInt(at, 0, 50)) return reject(E.REASONS.badSegment);
      const { trip: next, result } = E.alight(trip, boardingId, at);
      if (result.status === "applied") commit(next, result);
      return result;
    },

    arrive(driver, action) {
      const trip = needTrip(driver);
      if (!trip) return reject("no_trip");
      if (trip.status !== "en_route") return reject("not_en_route");
      if (!isInt(action.payload.stop, 0, 50)) return reject(E.REASONS.badSegment);
      const { trip: next, result } = E.arriveAt(trip, action.payload.stop);
      if (result.status === "applied") commit(next, result);
      return result.noShows ? { ...result, data: { noShows: result.noShows } } : result;
    },

    depart(driver) {
      const trip = needTrip(driver);
      if (!trip) return reject("no_trip");
      const position = queuePosition(db, trip);
      const { trip: next, result } = E.depart(trip, iso());
      if (result.status !== "applied") return result;
      commit(next, result);
      // Partir sans être n° 1 est possible (le chauffeur reste maître de son départ) mais signalé à l'équipe.
      const data = { ...(result.noShows ? { noShows: result.noShows } : {}), ...(position && position.rank > 1 ? { outOfTurn: true, rank: position.rank } : {}) };
      return Object.keys(data).length ? { ...result, data } : result;
    },

    finish(driver) {
      const trip = needTrip(driver);
      if (!trip) return { status: "noop" };
      if (trip.status !== "en_route") return reject("not_en_route");
      const { trip: next, result } = E.finish(trip, iso());
      commit(next, result);
      return result;
    },

    confirm_boarding(driver, action) {
      const trip = needTrip(driver);
      if (!trip) return reject("no_trip");
      const { boardingId } = action.payload;
      if (typeof boardingId !== "string") return reject(E.REASONS.unknown);
      const { trip: next, result } = E.confirmOnboard(trip, boardingId);
      if (result.status === "applied") {
        saveTrip(db, next);
        hooks.boarded(boardingId);
      }
      return result;
    },

    set_capacity(driver, action) {
      const capacity = action.payload.capacity;
      if (!isInt(capacity, 1, 8)) return reject("bad_capacity"); // un louage ne dépasse jamais 8 places
      if (needTrip(driver)) return reject("trip_in_progress"); // la capacité d'un voyage commencé ne change pas
      db.prepare("UPDATE drivers SET capacity = ? WHERE id = ?").run(capacity, driver.id);
      return { status: "applied" };
    },

    sos(driver, action) {
      const trip = needTrip(driver);
      const { event } = sos.record(driver, trip?.id ?? null, action.payload, { id: action.id, createdAt: action.createdAt });
      return { status: "applied", data: { sosId: event.id } };
    },

    sos_cancel(driver, action) {
      return sos.cancel(driver, action.payload.target, action.payload.note);
    },
  };

  /** Applique UNE action d'un chauffeur. @returns {{id, status, reason?, data?}} */
  function apply(driver, raw) {
    const action = { id: raw?.id, seq: raw?.seq, type: raw?.type, payload: raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload) ? raw.payload : {}, createdAt: typeof raw?.createdAt === "string" ? raw.createdAt : null };
    if (typeof action.id !== "string" || !ID.test(action.id)) return { id: null, status: "rejected", reason: "bad_action_id" };
    if (!TYPES.includes(action.type)) return { id: action.id, status: "rejected", reason: "unknown_action" };

    return transaction(() => {
      const done = db.prepare("SELECT status, reason, result FROM sync_log WHERE client_action_id = ?").get(action.id);
      if (done) return { id: action.id, status: "noop_already_applied", previous: done.status, ...(done.reason ? { reason: done.reason } : {}), ...(done.result ? { data: JSON.parse(done.result) } : {}) };
      // Chauffeur relu à chaque action : une action précédente du même lot (changement de capacité) doit compter pour la suivante.
      const outcome = handlers[action.type](db.prepare("SELECT * FROM drivers WHERE id = ?").get(driver.id) ?? driver, action);
      const result = { id: action.id, status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}), ...(outcome.data ? { data: outcome.data } : {}) };
      db.prepare("INSERT INTO sync_log (client_action_id, driver_id, client_seq, type, status, reason, result, received_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(action.id, driver.id, Number.isInteger(action.seq) ? action.seq : null, action.type, outcome.status, outcome.reason ?? null, outcome.data ? JSON.stringify(outcome.data) : null, iso());
      return result;
    });
  }

  /** Rejoue un lot dans l'ordre de `seq` (puis de `createdAt` à numéro égal). @returns {object[]} un résultat par action, dans l'ordre d'application */
  function applyBatch(driver, actions) {
    const list = (Array.isArray(actions) ? actions : []).slice(0, MAX_BATCH);
    const ordered = [...list].sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0) || String(a?.createdAt).localeCompare(String(b?.createdAt)));
    return ordered.map((a) => apply(driver, a));
  }

  return { apply, applyBatch, reportPosition };
}

// ---------------------------------------------------------------- état envoyé à l'application
/** Instantané de ce que l'application affiche (et garde pour travailler hors ligne). Jamais de données d'un autre chauffeur. */
export function buildState(db, driver, { now = Date.now, emergency = [], codeOf = null } = {}) {
  const trip = openTripOf(db, driver.id);
  const line = lineKeyFor(driver);
  const openSos = db.prepare("SELECT COUNT(*) AS n FROM sos_events WHERE driver_id = ? AND status IN ('open','ack')").get(driver.id).n;
  return {
    serverTime: new Date(now()).toISOString(),
    driver: { name: driver.full_name, plate: driver.plate, capacity: driver.capacity, line: { from: line.from_name, toGov: line.to_gov, type: line.line_type }, pickupEnRoute: Boolean(driver.pickup_en_route) },
    defaultStops: defaultStops(driver),
    emergency,
    openSos,
    trip: trip && {
      id: trip.id,
      status: trip.status,
      capacity: trip.capacity,
      stops: trip.stops,
      currentStop: trip.currentStop,
      queueSeq: trip.queueSeq,
      // Pour une réservation en ligne, le chauffeur voit le CODE que le passager doit lui montrer (rien d'autre sur le passager).
      boardings: trip.boardings.map(({ id, from, to, source, status, createdAt }) => ({ id, from, to, source, status, createdAt, ...(source === "reservation" && codeOf ? { code: codeOf(id) } : {}) })),
      position: queuePosition(db, trip),
      summary: E.summary(trip),
    },
  };
}

export { loadTrip };
