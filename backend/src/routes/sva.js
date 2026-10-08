import { Router } from "express";
import { db, uuid, markFullIfComplete } from "../store.js";

const router = Router();

// POST /api/v1/sva/callback
// Simule le webhook envoyé par l'opérateur (TT/Ooredoo/Orange) après
// tentative de prélèvement sur le solde mobile du passager.
router.post("/callback", (req, res) => {
  const { reservationId, operator, status, transactionRef } = req.body;

  const reservation = db.reservations.get(reservationId);
  if (!reservation) {
    return res.status(404).json({ error: "Réservation introuvable" });
  }
  if (!["success", "failed"].includes(status)) {
    return res.status(400).json({ error: "status doit être 'success' ou 'failed'" });
  }

  const louage = db.louages.get(reservation.louageId);

  if (status === "success") {
    reservation.status = "confirmed";
    reservation.svaOperator = operator;
    reservation.svaTransactionRef = transactionRef || uuid();
    reservation.qrCode = `LX-${reservation.id.slice(0, 8).toUpperCase()}`;
    if (louage) markFullIfComplete(louage);
  } else {
    reservation.status = "cancelled";
    if (louage) louage.seatsTaken = Math.max(0, louage.seatsTaken - 1); // libère le siège
  }

  res.json({ reservation });
});

export default router;
