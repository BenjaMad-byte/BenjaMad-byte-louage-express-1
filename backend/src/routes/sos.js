import { Router } from "express";
import { db, uuid } from "../store.js";

const router = Router();

// POST /api/v1/driver/sos
// Réception prioritaire: position GPS + flux audio chiffré (paquets 10s).
// En prod: la transmission vers Police 197 / SAMU 198 est déclenchée ici.
router.post("/sos", (req, res) => {
  const { louageId, driverId, triggerType, lat, lon, encryptedAudioChunk } = req.body;

  if (!louageId || !driverId || !lat || !lon) {
    return res.status(400).json({ error: "louageId, driverId, lat, lon requis" });
  }
  if (!["physical_button", "voice_keyword"].includes(triggerType)) {
    return res.status(400).json({ error: "triggerType doit être 'physical_button' ou 'voice_keyword'" });
  }

  const log = {
    id: uuid(),
    louageId,
    driverId,
    triggerType,
    lat,
    lon,
    hasAudioChunk: Boolean(encryptedAudioChunk),
    resolved: false,
    createdAt: new Date().toISOString(),
  };
  db.sosLogs.push(log);

  // Simulation: transmission immédiate et prioritaire aux secours.
  console.log(`[SOS PRIORITAIRE] Louage ${louageId} — GPS ${lat},${lon} — déclenché via ${triggerType}`);

  res.status(201).json({
    ack: true,
    sosId: log.id,
    message: "Position GPS transmise en priorité. Secours notifiés (Police 197 / SAMU 198).",
  });
});

router.get("/sos/:id", (req, res) => {
  const log = db.sosLogs.find((l) => l.id === req.params.id);
  if (!log) return res.status(404).json({ error: "Log SOS introuvable" });
  res.json(log);
});

export default router;
