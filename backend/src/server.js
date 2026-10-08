import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import reservationsRouter from "./routes/reservations.js";
import svaRouter from "./routes/sva.js";
import sosRouter from "./routes/sos.js";
import adminRouter from "./routes/admin.js";
import driverBoardRouter from "./routes/driverBoard.js";
import offlineSyncRouter from "./routes/offlineSync.js";
import gpsPingRouter from "./routes/gpsPing.js";
import kycVerifyRouter from "./routes/kycVerify.js";
import { connectRedis, redisAvailable } from "./geo.js";

// La route KYC reçoit des photos de CIN et de visages : elle ne doit répondre qu'au portail chauffeurs,
// qui s'identifie avec la clé de service partagée (en-tête X-Service-Key).
const SERVICE_KEY = process.env.KYC_SERVICE_KEY;
if (!SERVICE_KEY && process.env.NODE_ENV === "production") {
  throw new Error("KYC_SERVICE_KEY est requis en production (la route KYC traite des données biométriques)");
}
if (!SERVICE_KEY) console.warn("[kyc] KYC_SERVICE_KEY non défini : la route KYC est OUVERTE (acceptable en développement uniquement)");
const keyDigest = SERVICE_KEY ? crypto.createHash("sha256").update(SERVICE_KEY).digest() : null;
function requireServiceKey(req, res, next) {
  if (!keyDigest) return next();
  const given = crypto.createHash("sha256").update(String(req.get("x-service-key") ?? "")).digest();
  if (!crypto.timingSafeEqual(given, keyDigest)) return res.status(401).json({ error: "unauthorized" });
  next();
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" })); // selfies/documents en base64 (multi-frames)

app.use("/api/v1/reservations", reservationsRouter);
app.use("/api/v1/sva", svaRouter);
app.use("/api/v1/driver", sosRouter);
app.use("/api/v1/driver", driverBoardRouter);
app.use("/api/v1/driver", gpsPingRouter);
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/sync", offlineSyncRouter);
app.use("/api/v1/auth/driver", requireServiceKey, kycVerifyRouter);

app.get("/health", (_req, res) => res.json({ status: "ok", geoEngine: redisAvailable ? "redis" : "js-fallback" }));

const PORT = process.env.PORT || 4000;

connectRedis().finally(() => {
  // HOST=127.0.0.1 en production : le backend KYC ne doit être joignable que par le portail, sur la même machine.
  app.listen(PORT, process.env.HOST || undefined, () => {
    console.log(`Louage Express backend prototype — http://${process.env.HOST || "localhost"}:${PORT}`);
  });
});
