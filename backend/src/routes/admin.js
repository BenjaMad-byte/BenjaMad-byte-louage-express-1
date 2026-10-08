import { Router } from "express";
import { db } from "../store.js";

const router = Router();

// GET /api/v1/admin/queue/:lineId — état live de la file (pour le dashboard gare)
router.get("/queue/:lineId", (req, res) => {
  const queue = db.queues.get(req.params.lineId) || [];
  const detailed = queue.map((louageId, idx) => {
    const l = db.louages.get(louageId);
    return {
      rank: idx + 1,
      louageId: l.id,
      plate: l.plate,
      status: l.status,
      seatsTaken: l.seatsTaken,
      capacity: l.capacity,
    };
  });
  res.json({ lineId: req.params.lineId, queue: detailed });
});

router.get("/sos-logs", (_req, res) => {
  res.json({ logs: db.sosLogs });
});

router.get("/sync-log", (_req, res) => {
  res.json({ logs: db.syncLog });
});

export default router;
