import { Router } from "express";
import { db } from "../store.js";
import { matchFaces } from "../kyc/faceMatch.js";
import { extractDocumentText, parseCinFields, parsePermisFields } from "../kyc/ocr.js";
import { checkLiveness } from "../kyc/liveness.js";

const router = Router();

const FACE_MATCH_AUTO_APPROVE_THRESHOLD = 0.95;

function decodeBase64Image(str) {
  if (!str) return null;
  const cleaned = str.replace(/^data:image\/\w+;base64,/, "");
  return Buffer.from(cleaned, "base64");
}

// POST /api/v1/auth/driver/verify-identity
// Pipeline KYC biométrique :
//   1. OCR CIN (+ Permis/Licence si fournis) — extraction texte réelle (Tesseract).
//   2. Liveness — vérifie un mouvement réel entre les frames du "Selfie Dynamique".
//   3. Face Match — compare le selfie au visuel CIN (cf. avertissement dans faceMatch.js :
//      prototype = similarité d'image par perceptual hash, PAS une biométrie faciale
//      certifiée ; à remplacer par AWS Rekognition/Azure Face en production).
//   4. Décision : score > 95% + liveness OK + CIN lisible => compte auto-validé.
//      Sinon => en revue manuelle, avec le détail des raisons.
router.post("/verify-identity", async (req, res) => {
  const { driverId, selfieFrames, cinPhoto, permisPhoto, licencePhoto } = req.body;

  if (!driverId || !cinPhoto || !Array.isArray(selfieFrames) || selfieFrames.length === 0) {
    return res.status(400).json({ error: "driverId, cinPhoto et selfieFrames[] (>=1) requis" });
  }

  const cinBuffer = decodeBase64Image(cinPhoto);
  const selfieBuffers = selfieFrames.map(decodeBase64Image);
  const permisBuffer = decodeBase64Image(permisPhoto);
  const licenceBuffer = decodeBase64Image(licencePhoto);

  if (!cinBuffer || selfieBuffers.some((b) => !b)) {
    return res.status(400).json({ error: "Images base64 invalides" });
  }

  try {
    const [ocrCinRaw, ocrPermisRaw, liveness, faceMatch] = await Promise.all([
      extractDocumentText(cinBuffer),
      permisBuffer ? extractDocumentText(permisBuffer) : Promise.resolve(null),
      checkLiveness(selfieBuffers),
      matchFaces(selfieBuffers[selfieBuffers.length - 1], cinBuffer),
    ]);

    const ocrCin = { ...ocrCinRaw, ...parseCinFields(ocrCinRaw.rawText) };
    const ocrPermis = ocrPermisRaw ? { ...ocrPermisRaw, ...parsePermisFields(ocrPermisRaw.rawText) } : null;

    const reasons = [];
    if (!faceMatch.isRealBiometric) reasons.push("moteur_biometrique_indisponible_fallback_non_fiable");
    if (faceMatch.score <= FACE_MATCH_AUTO_APPROVE_THRESHOLD) reasons.push("face_match_score_insuffisant");
    if (!liveness.passed) reasons.push(liveness.reason || "liveness_echec");
    if (!ocrCin.cinNumber) reasons.push("cin_illisible_ou_absente");

    const autoApproved = reasons.length === 0;
    const status = autoApproved ? "verified" : "pending_manual_review";

    const record = {
      driverId,
      status,
      faceMatch,
      ocrCin,
      ocrPermis,
      hasLicencePhoto: Boolean(licenceBuffer),
      liveness,
      reasons,
      threshold: FACE_MATCH_AUTO_APPROVE_THRESHOLD,
      createdAt: new Date().toISOString(),
    };
    db.driverKyc.set(driverId, record);

    res.status(200).json({
      ...record,
      biometricEngineNote: faceMatch.isRealBiometric
        ? `Face-match via AWS Rekognition CompareFaces (région ${faceMatch.region}) — biométrie faciale réelle.`
        : "AWS Rekognition indisponible — fallback phash (similarité d'image, PAS une biométrie faciale). " +
          "Auto-validation bloquée par sécurité ; revue manuelle requise.",
    });
  } catch (err) {
    console.error("[kyc] Erreur pipeline vérification identité:", err);
    res.status(500).json({ error: "Échec du traitement KYC", detail: err.message });
  }
});

router.get("/verify-identity/:driverId", (req, res) => {
  const record = db.driverKyc.get(req.params.driverId);
  if (!record) return res.status(404).json({ error: "Aucune vérification KYC pour ce chauffeur" });
  res.json(record);
});

// Minimisation des données : le résultat contient le texte OCR complet de la CIN. Une fois le résultat
// récupéré, l'appelant peut demander l'effacement de l'enregistrement gardé en mémoire ici.
router.delete("/verify-identity/:driverId", (req, res) => {
  res.json({ deleted: db.driverKyc.delete(req.params.driverId) });
});

export default router;
