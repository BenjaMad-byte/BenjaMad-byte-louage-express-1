// In-memory store simulant PostgreSQL/PostGIS pour le prototype.
// Chaque fonction ici correspond à une requête SQL documentée dans db/schema.sql.
import { v4 as uuid } from "uuid";

const CAPACITY = 8;
const DEPOSIT_OPTIONS_DT = [1.5, 2.0];

export const db = {
  stations: [
    { id: "station-tunis", name: "Bab Alioua Tunis", lat: 36.7538, lon: 10.2261, geofenceRadiusM: 500 },
    { id: "station-sousse", name: "Tafala Sousse", lat: 35.8256, lon: 10.6084, geofenceRadiusM: 500 },
  ],
  lines: [
    { id: "line-tunis-sousse", originStationId: "station-tunis", destinationStationId: "station-sousse", officialPriceDt: 12.5 },
  ],
  louages: new Map(),   // id -> { id, driverId, plate, capacity, status, seatsTaken, lat, lon }
  queues: new Map(),    // lineId -> array of louageId ordered by rank (index 0 = rank 1 = tête de file)
  reservations: new Map(),
  sosLogs: [],
  syncedActionIds: new Set(),   // idempotence: client_action_id déjà appliqués
  syncLog: [],                  // historique des actions rejouées (pending/applied/conflict_rejected)
  driverKyc: new Map(),         // driverId -> { status, faceMatch, ocrCin, ocrPermis, liveness, createdAt }
};

// --- seed: 2 louages en file sur la ligne Tunis-Sousse -----------------------
function seedLouage(id, driverId, plate) {
  db.louages.set(id, {
    id, driverId, plate, capacity: CAPACITY, seatsTaken: 0,
    status: "en_remplissage", lat: 36.7538, lon: 10.2261,
  });
}
seedLouage("louage-1", "driver-1", "123 TUN 4567");
seedLouage("louage-2", "driver-2", "789 TUN 1234");
db.queues.set("line-tunis-sousse", ["louage-1", "louage-2"]);

// --- distance haversine (mètres) — simule ST_Distance/ST_DWithin -----------
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function isWithinGeofence(louage, station) {
  return distanceMeters(louage.lat, louage.lon, station.lat, station.lon) <= station.geofenceRadiusM;
}

// --- First-Available Seat: cible le louage de rang le plus bas non complet --
// Équivalent SQL: SELECT * FROM queues WHERE line_id = ? AND seats_taken < capacity
//                 ORDER BY rank_in_queue ASC LIMIT 1;
export function findAvailableLouage(lineId) {
  const queue = db.queues.get(lineId) || [];
  for (const louageId of queue) {
    const louage = db.louages.get(louageId);
    if (louage && louage.seatsTaken < louage.capacity && louage.status !== "complet_parti") {
      return louage;
    }
  }
  return null;
}

export function markFullIfComplete(louage) {
  if (louage.seatsTaken >= louage.capacity) {
    louage.status = "complet_parti"; // libère la tête de file pour le rang suivant
  }
}

export { uuid, CAPACITY, DEPOSIT_OPTIONS_DT };
