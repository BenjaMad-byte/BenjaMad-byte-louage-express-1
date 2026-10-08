import { Router } from "express";
import { db, uuid, findAvailableLouage, DEPOSIT_OPTIONS_DT } from "../store.js";

const router = Router();

// POST /api/v1/reservations
// Algorithme "First-Available Seat": la réservation en ligne est injectée
// dans le louage N°1 actif en tête de file (jamais dans le N°2 tant que le
// N°1 n'est pas complet — cf. findAvailableLouage).
router.post("/", (req, res) => {
  const { passengerId, lineId, depositAmountDt } = req.body;

  if (!passengerId || !lineId) {
    return res.status(400).json({ error: "passengerId et lineId requis" });
  }
  if (!DEPOSIT_OPTIONS_DT.includes(depositAmountDt)) {
    return res.status(400).json({ error: `depositAmountDt doit être ${DEPOSIT_OPTIONS_DT.join(" ou ")}` });
  }
  if (!db.lines.find((l) => l.id === lineId)) {
    return res.status(404).json({ error: "Ligne inconnue" });
  }

  const louage = findAvailableLouage(lineId);
  if (!louage) {
    return res.status(409).json({ error: "Aucun louage disponible en tête de file pour cette ligne" });
  }

  const reservationId = uuid();
  const reservation = {
    id: reservationId,
    passengerId,
    lineId,
    louageId: louage.id,
    depositAmountDt,
    svaOperator: null,
    svaTransactionRef: null,
    status: "pending_sva",
    qrCode: null,
    createdAt: new Date().toISOString(),
  };

  // Le siège est réservé optimistiquement; libéré si le callback SVA échoue.
  louage.seatsTaken += 1;
  db.reservations.set(reservationId, reservation);

  res.status(201).json({
    reservation,
    louage: { id: louage.id, plate: louage.plate, seatsTaken: louage.seatsTaken, capacity: louage.capacity },
    message: "Réservation créée, en attente de confirmation SVA (prélèvement solde mobile).",
  });
});

router.get("/:id", (req, res) => {
  const reservation = db.reservations.get(req.params.id);
  if (!reservation) return res.status(404).json({ error: "Réservation introuvable" });
  res.json(reservation);
});

export default router;
