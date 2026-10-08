// Moteur de règles : places par tronçon, remplissage séquentiel de la file, attribution des réservations.
//
// Module PUR (aucun accès réseau, disque ni horloge) utilisé à deux endroits avec LE MÊME CODE :
//   - le serveur, qui fait autorité ;
//   - le téléphone, qui l'applique tout de suite pour afficher le résultat hors ligne (le serveur confirmera ou corrigera à la synchronisation).
// Toutes les fonctions retournent de nouveaux objets : jamais de modification en place.
//
// Un voyage (trip) : { id, capacity, stops: ["Redeyef", "Métlaoui", "Gafsa"], currentStop, status, queueSeq, boardings: [...] }
// Un tronçon i va de l'arrêt i à l'arrêt i+1. Un passager monte à l'arrêt `from` et descend à l'arrêt `to` (from < to) : il occupe les tronçons from … to-1.
// Un passager (boarding) : { id, from, to, source: "cash" | "reservation", status, createdAt }

/** Statuts qui occupent une place : « reserved » (retenue d'une réservation, pas encore montée) et « onboard » (physiquement dans le louage). */
export const COUNTED = Object.freeze(["reserved", "onboard"]);
const isCounted = (b) => COUNTED.includes(b.status);

export const OPEN_QUEUE = Object.freeze(["queued", "filling"]);
export const CLOSED = Object.freeze(["done", "cancelled"]);

export const REASONS = Object.freeze({
  full: "seat_full_conflict", // plus de place sur un des tronçons demandés
  badSegment: "bad_segment", // arrêts incohérents
  closed: "trip_closed", // voyage terminé ou annulé
  passed: "stop_already_passed", // monter à un arrêt déjà dépassé
  unknown: "unknown_boarding",
});

export const segmentCount = (trip) => Math.max(trip.stops.length - 1, 0);

/** Nombre de passagers qui occupent chaque tronçon. `includeReserved: false` = seulement ceux qui sont réellement montés. */
export function loads(trip, { includeReserved = true } = {}) {
  const out = Array(segmentCount(trip)).fill(0);
  for (const b of trip.boardings) {
    if (!(b.status === "onboard" || (includeReserved && b.status === "reserved"))) continue;
    for (let s = b.from; s < b.to; s++) out[s] += 1;
  }
  return out;
}

const validSegment = (trip, from, to) => Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to <= segmentCount(trip) && from < to;

/** Places libres pour un passager qui irait de `from` à `to` : le minimum sur tous ses tronçons. */
export function freeOnSegments(trip, from, to, opts) {
  if (!validSegment(trip, from, to)) return 0;
  const l = loads(trip, opts);
  let min = trip.capacity;
  for (let s = from; s < to; s++) min = Math.min(min, trip.capacity - l[s]);
  return Math.max(min, 0);
}

/** Pour chaque arrêt i : places libres pour aller de i jusqu'au bout. C'est ce que le chauffeur peut proposer à cet arrêt. */
export function freeFrom(trip) {
  const n = segmentCount(trip);
  return trip.stops.map((_, i) => (i >= n ? 0 : freeOnSegments(trip, i, n)));
}

/** Peut-on ajouter un passager de `from` à `to` ? (aucune modification) */
export function canBoard(trip, from, to) {
  if (CLOSED.includes(trip.status)) return { ok: false, reason: REASONS.closed };
  if (!validSegment(trip, from, to)) return { ok: false, reason: REASONS.badSegment };
  if (trip.status === "en_route" && from < trip.currentStop) return { ok: false, reason: REASONS.passed };
  if (freeOnSegments(trip, from, to) < 1) return { ok: false, reason: REASONS.full };
  return { ok: true };
}

const withBoardings = (trip, boardings) => ({ ...trip, boardings });
const setStatus = (trip, id, status, extra = {}) => withBoardings(trip, trip.boardings.map((b) => (b.id === id ? { ...b, ...extra, status } : b)));

/**
 * Ajoute un passager.
 *  - « reservation » : retient une place (statut « reserved ») ; refusée s'il n'y a pas de place.
 *  - « cash » (passager physiquement monté) : **la présence physique gagne toujours**. Si le voyage est plein seulement à cause de
 *    retenues de réservation (personne n'est encore monté), la ou les réservations les plus RÉCENTES sont déplacées (`displaced`)
 *    jusqu'à libérer la place ; le serveur les attribue à un autre voyage ou les rembourse.
 *    Si le voyage est plein de passagers réellement montés, c'est refusé : un louage ne peut pas dépasser sa capacité.
 * Idempotent : un identifiant déjà présent ne s'ajoute pas deux fois.
 * @returns {{ trip: object, result: { status: "applied"|"noop"|"conflict_rejected"|"rejected", reason?: string, displaced?: string[] } }}
 */
export function board(trip, { id, from, to, source = "cash", createdAt = null }) {
  if (trip.boardings.some((b) => b.id === id)) return { trip, result: { status: "noop" } };
  const check = canBoard(trip, from, to);
  const physical = source === "cash";
  let current = trip;
  const displaced = [];

  if (!check.ok && check.reason === REASONS.full && physical && validSegment(trip, from, to) && freeOnSegments(trip, from, to, { includeReserved: false }) >= 1) {
    // Plein uniquement à cause de retenues : on déplace la plus récente qui occupe un tronçon saturé, jusqu'à ce que la place existe.
    while (freeOnSegments(current, from, to) < 1) {
      const l = loads(current);
      const blocksIt = (b) => {
        for (let s = Math.max(b.from, from); s < Math.min(b.to, to); s++) if (l[s] >= current.capacity) return true;
        return false;
      };
      // La plus récente d'abord ; à date égale (même milliseconde), la dernière ajoutée.
      const hold = current.boardings.map((b, index) => ({ b, index })).filter(({ b }) => b.status === "reserved" && blocksIt(b))
        .sort((x, y) => String(y.b.createdAt).localeCompare(String(x.b.createdAt)) || y.index - x.index)[0]?.b;
      if (!hold) break;
      current = setStatus(current, hold.id, "displaced");
      displaced.push(hold.id);
    }
  } else if (!check.ok) {
    const status = check.reason === REASONS.full ? "conflict_rejected" : "rejected";
    return { trip, result: { status, reason: check.reason } };
  }
  if (freeOnSegments(current, from, to) < 1) return { trip, result: { status: "conflict_rejected", reason: REASONS.full } };

  const entry = { id, from, to, source, status: physical ? "onboard" : "reserved", createdAt };
  return { trip: withBoardings(current, [...current.boardings, entry]), result: { status: "applied", ...(displaced.length ? { displaced } : {}) } };
}

/** Le passager qui avait une réservation est arrivé et monte : « reserved » → « onboard ». */
export function confirmOnboard(trip, id) {
  const b = trip.boardings.find((x) => x.id === id);
  if (!b) return { trip, result: { status: "rejected", reason: REASONS.unknown } };
  if (b.status === "onboard") return { trip, result: { status: "noop" } };
  if (b.status !== "reserved") return { trip, result: { status: "rejected", reason: "not_reserved" } };
  return { trip: setStatus(trip, id, "onboard"), result: { status: "applied" } };
}

/** Annule un passager (réservation expirée, absent, annulée, déplacée). Libère ses tronçons. */
export function release(trip, id, status = "cancelled") {
  const b = trip.boardings.find((x) => x.id === id);
  if (!b) return { trip, result: { status: "rejected", reason: REASONS.unknown } };
  if (!isCounted(b)) return { trip, result: { status: "noop" } };
  return { trip: setStatus(trip, id, status), result: { status: "applied" } };
}

/** Le passager descend plus tôt que prévu, à l'arrêt `atStop` : ses tronçons suivants se libèrent. Descendre à son arrêt de montée annule sa place. */
export function alight(trip, id, atStop) {
  const b = trip.boardings.find((x) => x.id === id);
  if (!b) return { trip, result: { status: "rejected", reason: REASONS.unknown } };
  if (b.status !== "onboard") return { trip, result: { status: "noop" } };
  if (!Number.isInteger(atStop) || atStop < b.from || atStop > b.to) return { trip, result: { status: "rejected", reason: REASONS.badSegment } };
  if (atStop === b.to) return { trip, result: { status: "noop" } };
  if (atStop === b.from) return { trip: setStatus(trip, id, "cancelled"), result: { status: "applied" } };
  return { trip: withBoardings(trip, trip.boardings.map((x) => (x.id === id ? { ...x, to: atStop } : x))), result: { status: "applied" } };
}

/**
 * Le louage arrive à l'arrêt `stop`. Les passagers dont c'est l'arrêt de descente sont descendus ; les réservations qui devaient monter
 * à un arrêt déjà dépassé sont marquées « no_show » (le passager n'est pas venu).
 */
export function arriveAt(trip, stop) {
  if (!Number.isInteger(stop) || stop < trip.currentStop || stop > segmentCount(trip)) return { trip, result: { status: "rejected", reason: REASONS.badSegment } };
  if (stop === trip.currentStop) return { trip, result: { status: "noop" } };
  const noShows = [];
  const boardings = trip.boardings.map((b) => {
    if (b.status === "onboard" && b.to <= stop) return { ...b, status: "alighted" };
    if (b.status === "reserved" && b.from < stop) { noShows.push(b.id); return { ...b, status: "no_show" }; }
    return b;
  });
  return { trip: { ...trip, currentStop: stop, boardings }, result: { status: "applied", ...(noShows.length ? { noShows } : {}) } };
}

/** Le louage part de la gare : les réservations pour le premier arrêt non montées deviennent « no_show ». */
export function depart(trip, departedAt = null) {
  if (!OPEN_QUEUE.includes(trip.status)) return { trip, result: { status: trip.status === "en_route" ? "noop" : "rejected", reason: REASONS.closed } };
  const noShows = trip.boardings.filter((b) => b.status === "reserved" && b.from === 0).map((b) => b.id);
  const boardings = trip.boardings.map((b) => (noShows.includes(b.id) ? { ...b, status: "no_show" } : b));
  return { trip: { ...trip, status: "en_route", currentStop: 0, departedAt, boardings }, result: { status: "applied", ...(noShows.length ? { noShows } : {}) } };
}

export function finish(trip, endedAt = null) {
  if (CLOSED.includes(trip.status)) return { trip, result: { status: "noop" } };
  return { trip: { ...trip, status: "done", endedAt, boardings: trip.boardings.map((b) => (b.status === "onboard" ? { ...b, status: "alighted" } : b.status === "reserved" ? { ...b, status: "no_show" } : b)) }, result: { status: "applied" } };
}

/** Ce que le chauffeur voit : places occupées maintenant, retenues, libres pour la suite. */
export function summary(trip) {
  const n = segmentCount(trip);
  const seg = Math.min(trip.currentStop, Math.max(n - 1, 0));
  const onboardLoads = loads(trip, { includeReserved: false });
  const allLoads = loads(trip);
  return {
    capacity: trip.capacity,
    stops: trip.stops,
    currentStop: trip.currentStop,
    onboardNow: n ? onboardLoads[seg] : 0,
    reservedNow: n ? allLoads[seg] - onboardLoads[seg] : 0,
    freeNow: n ? trip.capacity - allLoads[seg] : 0,
    freeFrom: freeFrom(trip),
    full: n > 0 && allLoads[seg] >= trip.capacity,
  };
}

// ---------------------------------------------------------------- file d'attente d'une ligne
/** Voyages en attente ou en remplissage d'une ligne, dans l'ordre d'arrivée à la gare. Le premier est le n° 1. */
export const orderQueue = (trips) => trips.filter((t) => OPEN_QUEUE.includes(t.status)).sort((a, b) => a.queueSeq - b.queueSeq);

export function rankOf(trips, tripId) {
  const index = orderQueue(trips).findIndex((t) => t.id === tripId);
  return index < 0 ? null : index + 1;
}

/**
 * À quel voyage donner une réservation ? (aucune modification)
 * `from`/`to` : indices d'arrêts, ou bien UNE FONCTION `(voyage) => ({ from, to }) | null` quand les voyages n'ont pas tous les mêmes arrêts
 * (le passager demande des arrêts par leur nom ; null = ce voyage ne dessert pas ces arrêts).
 *  - Montée à la gare de départ : **remplissage séquentiel strict**, le premier de la file qui a de la place sur tout le trajet demandé.
 *  - Montée à un arrêt intermédiaire : d'abord le voyage déjà parti le plus proche qui n'a pas dépassé cet arrêt (et a de la place) ;
 *    à défaut, le premier voyage de la file qui passera par là.
 * @returns {object|null} le voyage choisi, ou null si aucun ne convient.
 */
export function chooseTripForReservation(trips, from, to) {
  const at = typeof from === "function" ? from : () => ({ from, to });
  const fits = (t) => {
    const s = at(t);
    return Boolean(s) && !CLOSED.includes(t.status) && canBoard(t, s.from, s.to).ok;
  };
  const queue = orderQueue(trips).filter(fits);
  if (trips.some((t) => at(t)?.from === 0)) return queue.find((t) => at(t).from === 0) ?? null;
  const enRoute = trips
    // <= et non < : un passager peut encore monter à l'arrêt où le louage se trouve EN CE MOMENT (il n'est pas reparti) ; canBoard() le permet déjà, ce filtre doit rester cohérent avec lui.
    .filter((t) => t.status === "en_route" && fits(t) && t.currentStop <= at(t).from)
    .sort((a, b) => b.currentStop - a.currentStop || String(a.departedAt).localeCompare(String(b.departedAt)));
  return enRoute[0] ?? queue[0] ?? null;
}
