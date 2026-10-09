// Lien entre la base SQLite et le moteur de règles (public/engine.js) : lignes, file d'attente, voyages et passagers.
import crypto from "node:crypto";
import { places, matchKey } from "../driver-portal/public/places.js";
import * as E from "./public/engine.js";

const MAX_STOPS = 8;
const STOP_NAME_MAX = 60;

// ---------------------------------------------------------------- lignes
/** Résout un nom de ville vers son nom officiel + gouvernorat (repli sur le texte brut, gouvernorat inconnu, si la ville n'est pas reconnue). */
function resolveStop(name, contextGovs = []) {
  const hit = places.find(name ?? "", contextGovs) ?? places.find(name ?? "");
  return hit ? { name: hit.fr, governorate: hit.governorate } : { name: name ?? "", governorate: null };
}

/**
 * Clé de ligne : dérivée des arrêts RÉELLEMENT utilisés pour ce voyage, pas seulement de la ligne déclarée à l'inscription.
 * Un chauffeur qui fait le trajet retour (ou par un autre village) doit apparaître sur une ligne différente, pour que les
 * passagers et la file d'attente ne mélangent jamais les deux sens. Sans `stops`, utilise les arrêts par défaut du chauffeur.
 */
export function lineKeyFor(driver, stops) {
  const theStops = stops ?? defaultStops(driver);
  const from = resolveStop(theStops[0], [driver.governorate]);
  const to = resolveStop(theStops[theStops.length - 1], [driver.governorate, driver.line_to_gov].filter(Boolean));
  const fromGov = from.governorate ?? driver.governorate;
  const fromKey = from.governorate ? `@${fromGov}|${from.name}` : `~${matchKey(from.name)}`;
  return {
    key: `${fromGov}|${fromKey}|${to.governorate ?? "*"}`,
    from_gov: fromGov,
    from_name: from.name,
    to_gov: to.governorate,
    line_type: driver.line_type ?? null,
  };
}

export function ensureLine(db, driver, stops) {
  const l = lineKeyFor(driver, stops);
  const found = db.prepare("SELECT id FROM lines WHERE key = ?").get(l.key);
  if (found) return found.id;
  return Number(db.prepare("INSERT INTO lines (key, from_gov, from_name, to_gov, line_type) VALUES (?,?,?,?,?)").run(l.key, l.from_gov, l.from_name, l.to_gov, l.line_type).lastInsertRowid);
}

/** Arrêts par défaut d'un voyage : départ, arrêts en route déclarés (noms officiels quand ils sont reconnus), arrivée. */
export function defaultStops(driver) {
  const from = resolveStop(driver.line_from ?? driver.station, [driver.governorate]).name;
  let via = [];
  try { via = JSON.parse(driver.line_via ?? "[]"); } catch { /* circuit illisible : aucun arrêt intermédiaire */ }
  const official = (name) => places.find(name, [driver.governorate, driver.line_to_gov].filter(Boolean))?.fr ?? places.find(name)?.fr ?? name;
  const seen = new Set([matchKey(from)]);
  const stops = [from];
  for (const v of via) {
    const name = official(String(v));
    if (seen.has(matchKey(name))) continue;
    seen.add(matchKey(name));
    stops.push(name);
  }
  stops.push(driver.line_to_gov ?? "Destination libre");
  return stops.slice(0, MAX_STOPS);
}

/** Arrêts proposés par le chauffeur : 2 à 8 noms non vides, le premier est la gare de départ. */
export function cleanStops(input) {
  if (!Array.isArray(input) || input.length < 2 || input.length > MAX_STOPS) return null;
  const names = input.map((s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, STOP_NAME_MAX));
  return names.every(Boolean) ? names : null;
}

// ---------------------------------------------------------------- voyages
const rowToTrip = (db, r) => ({
  id: r.id,
  driverId: r.driver_id,
  lineId: r.line_id,
  capacity: r.capacity,
  stops: JSON.parse(r.stops),
  currentStop: r.current_stop,
  status: r.status,
  queueSeq: r.queue_seq,
  createdAt: r.created_at,
  departedAt: r.departed_at,
  endedAt: r.ended_at,
  boardings: db.prepare("SELECT id, from_idx AS \"from\", to_idx AS \"to\", source, status, created_at AS createdAt FROM boardings WHERE trip_id = ? ORDER BY rowid").all(r.id).map((b) => ({ ...b })),
});

export const loadTrip = (db, id) => {
  const r = db.prepare("SELECT * FROM trips WHERE id = ?").get(id);
  return r ? rowToTrip(db, r) : null;
};

export const openTripOf = (db, driverId) => {
  const r = db.prepare("SELECT * FROM trips WHERE driver_id = ? AND status IN ('queued','en_route')").get(driverId);
  return r ? rowToTrip(db, r) : null;
};

/** Voyages d'une ligne qui peuvent encore recevoir des passagers (file + déjà partis). */
export const tripsOfLine = (db, lineId) =>
  db.prepare("SELECT * FROM trips WHERE line_id = ? AND status IN ('queued','en_route')").all(lineId).map((r) => rowToTrip(db, r));

/** Enregistre l'état d'un voyage (après une opération du moteur). */
export function saveTrip(db, trip) {
  db.prepare("UPDATE trips SET status = ?, current_stop = ?, capacity = ?, departed_at = ?, ended_at = ? WHERE id = ?").run(trip.status, trip.currentStop, trip.capacity, trip.departedAt ?? null, trip.endedAt ?? null, trip.id);
  const upsert = db.prepare(
    `INSERT INTO boardings (id, trip_id, from_idx, to_idx, source, status, created_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET to_idx = excluded.to_idx, status = excluded.status`
  );
  for (const b of trip.boardings) upsert.run(b.id, trip.id, b.from, b.to, b.source, b.status, b.createdAt ?? null);
}

/** Met le chauffeur dans la file de sa ligne, en dernière position. */
export function createTrip(db, driver, { stops, now }) {
  const lineId = ensureLine(db, driver, stops);
  const seq = (db.prepare("SELECT COALESCE(MAX(queue_seq), 0) + 1 AS n FROM trips WHERE line_id = ?").get(lineId).n);
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO trips (id, driver_id, line_id, status, queue_seq, capacity, stops, current_stop, created_at) VALUES (?,?,?,?,?,?,?,0,?)")
    .run(id, driver.id, lineId, "queued", seq, driver.capacity, JSON.stringify(stops), now);
  return loadTrip(db, id);
}

/** Rang (1 = en tête, remplit en premier) et nombre de louages dans la file, ou null si le voyage n'est pas dans la file. */
export function queuePosition(db, trip) {
  if (trip.status !== "queued") return null;
  const queue = E.orderQueue(tripsOfLine(db, trip.lineId));
  const rank = queue.findIndex((t) => t.id === trip.id) + 1;
  return rank ? { rank, size: queue.length } : null;
}
