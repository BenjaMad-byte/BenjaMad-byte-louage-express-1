import { Router } from "express";
import { db } from "../store.js";
import { updateLouagePositionGeo, findStationsNearLouage, redisAvailable } from "../geo.js";

const router = Router();

// POST /api/v1/driver/gps-ping
// Ping GPS périodique du chauffeur. Met à jour la position dans Redis GEO,
// détecte l'entrée en gare (rayon configurable par station, 500m par défaut)
// et bascule automatiquement le statut en "en_station_disponible".
router.post("/gps-ping", async (req, res) => {
  const { louageId, lat, lon } = req.body;
  if (!louageId || lat === undefined || lon === undefined) {
    return res.status(400).json({ error: "louageId, lat, lon requis" });
  }

  const louage = db.louages.get(louageId);
  if (!louage) return res.status(404).json({ error: "Louage introuvable" });

  louage.lat = lat;
  louage.lon = lon;
  louage.lastPingAt = new Date().toISOString();

  await updateLouagePositionGeo(louageId, lon, lat);

  // Rayon le plus strict parmi les stations connues (défaut 500m, cf. schema.sql).
  const maxRadius = Math.max(...db.stations.map((s) => s.geofenceRadiusM), 500);
  const nearby = await findStationsNearLouage(louage, maxRadius);

  const previousStatus = louage.status;
  if (nearby.length > 0 && louage.status === "en_route") {
    louage.status = "en_station_disponible";
  }

  res.json({
    louageId,
    engine: redisAvailable ? "redis-geo" : "js-haversine-fallback",
    nearbyStations: nearby,
    statusChanged: previousStatus !== louage.status,
    status: louage.status,
  });
});

export default router;
