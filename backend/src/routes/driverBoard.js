import { Router } from "express";
import { markFullIfComplete, db } from "../store.js";

const router = Router();

// POST /api/v1/driver/board — 1-click: chauffeur déclare un passager physique
// monté (paiement cash direct, hors SVA). Utilisé par l'app "Zero-Distraction".
router.post("/board", (req, res) => {
  const { louageId } = req.body;
  const louage = db.louages.get(louageId);
  if (!louage) return res.status(404).json({ error: "Louage introuvable" });
  if (louage.seatsTaken >= louage.capacity) {
    return res.status(409).json({ error: "Louage déjà complet" });
  }
  louage.seatsTaken += 1;
  markFullIfComplete(louage);
  res.json({ louage: { id: louage.id, seatsTaken: louage.seatsTaken, capacity: louage.capacity, status: louage.status } });
});

export default router;
