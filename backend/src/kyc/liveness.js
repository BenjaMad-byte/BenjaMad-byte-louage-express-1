// Heuristique de vivacité pour le "Selfie Dynamique" (plusieurs frames captées
// pendant une consigne : tourner la tête / cligner des yeux). Vérifie qu'il y a
// un mouvement réel entre frames — détecte le cas trivial "photo figée envoyée
// plusieurs fois".
//
// ⚠️ Ce n'est PAS un anti-spoofing certifié (pas de détection de profondeur,
// de texture peau, ni de détection d'écran/impression re-photographié). Pour
// la prod : SDK liveness dédié (AWS Rekognition Face Liveness, FaceTec, iProov).
import sharp from "sharp";

const SAMPLE_SIZE = 32;
const MOTION_THRESHOLD = 2; // delta moyen de niveau de gris entre frames consécutives

async function grayscaleSample(buffer) {
  return sharp(buffer).resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: "fill" }).grayscale().raw().toBuffer();
}

export async function checkLiveness(frameBuffers) {
  if (!frameBuffers || frameBuffers.length < 2) {
    return { passed: false, reason: "frames_insuffisantes_pour_detecter_le_mouvement", motionScore: 0 };
  }

  const grays = await Promise.all(frameBuffers.map(grayscaleSample));
  let totalDiff = 0;
  for (let i = 1; i < grays.length; i++) {
    let diff = 0;
    for (let p = 0; p < grays[i].length; p++) diff += Math.abs(grays[i][p] - grays[i - 1][p]);
    totalDiff += diff / grays[i].length;
  }
  const motionScore = Number((totalDiff / (grays.length - 1)).toFixed(2));

  return {
    passed: motionScore > MOTION_THRESHOLD,
    motionScore,
    reason: motionScore > MOTION_THRESHOLD ? null : "mouvement_insuffisant_entre_frames",
  };
}
