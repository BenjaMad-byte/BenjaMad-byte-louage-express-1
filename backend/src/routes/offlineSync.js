import { Router } from "express";
import { db, uuid, markFullIfComplete } from "../store.js";

const router = Router();

// POST /api/v1/sync/offline-buffer
// Rejoue le buffer d'actions locales (SQLite) capturées par l'app chauffeur
// pendant une coupure 4G. Idempotent (client_action_id), ordonné par horloge
// client, capacité serveur = source de vérité (cf. db/architecture.md).
router.post("/offline-buffer", (req, res) => {
  const { louageId, driverId, actions } = req.body;

  if (!louageId || !driverId || !Array.isArray(actions)) {
    return res.status(400).json({ error: "louageId, driverId, actions[] requis" });
  }

  const louage = db.louages.get(louageId);
  if (!louage) return res.status(404).json({ error: "Louage introuvable" });

  // Ordre logique: horloge locale du chauffeur, pas ordre d'arrivée réseau.
  const ordered = [...actions].sort(
    (a, b) => new Date(a.clientCreatedAt) - new Date(b.clientCreatedAt)
  );

  const results = ordered.map((action) => {
    const { clientActionId, type, payload = {} } = action;

    if (!clientActionId || !type) {
      return { clientActionId: clientActionId || null, status: "rejected", reason: "action_malformee" };
    }

    // Idempotence: rejeu réseau ou double-tap déjà appliqué -> no-op.
    if (db.syncedActionIds.has(clientActionId)) {
      return { clientActionId, status: "noop_already_applied" };
    }

    let result;
    switch (type) {
      case "board_passenger": {
        if (louage.seatsTaken < louage.capacity) {
          louage.seatsTaken += 1;
          markFullIfComplete(louage);
          result = { clientActionId, status: "applied", seatsTaken: louage.seatsTaken };
        } else {
          result = { clientActionId, status: "conflict_rejected", reason: "seat_full_conflict" };
        }
        break;
      }
      case "sos_trigger": {
        // Jamais bloqué par un conflit — priorité absolue.
        const log = {
          id: uuid(),
          louageId,
          driverId,
          triggerType: payload.triggerType || "physical_button",
          lat: payload.lat,
          lon: payload.lon,
          hasAudioChunk: Boolean(payload.encryptedAudioChunk),
          resolved: false,
          createdAt: action.clientCreatedAt,
          syncedFromOffline: true,
        };
        db.sosLogs.push(log);
        result = { clientActionId, status: "applied", sosId: log.id };
        break;
      }
      case "status_change": {
        louage.status = payload.status || louage.status;
        result = { clientActionId, status: "applied", newStatus: louage.status };
        break;
      }
      default:
        result = { clientActionId, status: "rejected", reason: "type_action_inconnu" };
    }

    db.syncedActionIds.add(clientActionId);
    db.syncLog.push({ ...result, type, receivedAt: new Date().toISOString() });
    return result;
  });

  res.json({
    louageId,
    processed: results.length,
    applied: results.filter((r) => r.status === "applied").length,
    conflicts: results.filter((r) => r.status === "conflict_rejected").length,
    noop: results.filter((r) => r.status === "noop_already_applied").length,
    results,
  });
});

export default router;
