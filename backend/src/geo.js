// Geofencing temps réel via Redis GEO (GEOADD/GEOSEARCH).
// Un seul sorted-set géospatial contient stations ET louages (membres préfixés).
// Fallback JS (haversine) automatique si Redis est indisponible — le prototype
// reste utilisable sans dépendance dure, mais utilise Redis dès qu'il répond.
import Redis from "ioredis";
import { db, distanceMeters } from "./store.js";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const GEO_KEY = "louage:geo:index";

export const redis = new Redis(REDIS_URL, {
  lazyConnect: true,
  retryStrategy: () => null, // pas de boucle de reconnexion infinie en dev sans Redis
  reconnectOnError: () => false,
});
redis.on("error", () => {}); // évite le bruit ECONNREFUSED répété dans les logs

export let redisAvailable = false;

export async function connectRedis() {
  try {
    await redis.connect();
    await redis.ping();
    redisAvailable = true;
    console.log(`[geo] Redis connecté (${REDIS_URL}) — GEO temps réel actif`);
    await seedStationsGeo();
  } catch (err) {
    redisAvailable = false;
    console.warn(`[geo] Redis indisponible (${err.message}) — fallback haversine JS`);
  }
}

export async function seedStationsGeo() {
  if (!redisAvailable || db.stations.length === 0) return;
  const args = db.stations.flatMap((s) => [s.lon, s.lat, `station:${s.id}`]);
  await redis.geoadd(GEO_KEY, ...args);
}

// Appelé à chaque ping GPS chauffeur — équivalent temps réel de l'UPDATE current_location.
export async function updateLouagePositionGeo(louageId, lon, lat) {
  if (!redisAvailable) return;
  await redis.geoadd(GEO_KEY, lon, lat, `louage:${louageId}`);
}

// Stations dans le rayon (mètres) autour du louage, triées par distance.
// Retourne null si Redis indisponible (signal explicite pour fallback JS).
export async function findStationsNearLouageRedis(louageId, radiusM) {
  if (!redisAvailable) return null;
  const raw = await redis.call(
    "GEOSEARCH", GEO_KEY,
    "FROMMEMBER", `louage:${louageId}`,
    "BYRADIUS", radiusM, "m",
    "ASC", "WITHDIST"
  );
  return raw
    .filter(([member]) => member.startsWith("station:"))
    .map(([member, dist]) => ({
      stationId: member.replace("station:", ""),
      distanceM: parseFloat(dist),
    }));
}

// Fallback pur JS (haversine) — utilisé si Redis n'est pas up (dev sans dépendance).
export function findStationsNearLouageJs(louage, radiusM) {
  return db.stations
    .map((s) => ({ stationId: s.id, distanceM: distanceMeters(louage.lat, louage.lon, s.lat, s.lon) }))
    .filter((r) => r.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);
}

export async function findStationsNearLouage(louage, radiusM) {
  const viaRedis = await findStationsNearLouageRedis(louage.id, radiusM).catch(() => null);
  return viaRedis !== null ? viaRedis : findStationsNearLouageJs(louage, radiusM);
}
