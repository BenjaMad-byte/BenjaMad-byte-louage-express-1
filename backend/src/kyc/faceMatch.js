// Comparaison faciale — AWS Rekognition CompareFaces (production), avec
// fallback perceptual hash local si AWS échoue ou n'est pas joignable
// (dev sans credentials, coupure réseau, quota dépassé...).
//
// AWS Rekognition fait une vraie reconnaissance biométrique (détection +
// embedding + comparaison). Le fallback (providers/phashFallback.js) NE l'est
// PAS — voir son avertissement. Toute réponse avec `isRealBiometric: false`
// signifie que la décision KYC n'est PAS fiable et doit repasser en revue
// manuelle, quel que soit le score.
import { matchFacesAwsRekognition } from "./providers/awsRekognition.js";
import { matchFacesPhash } from "./providers/phashFallback.js";

export async function matchFaces(selfieBuffer, idPhotoBuffer) {
  try {
    return await matchFacesAwsRekognition(selfieBuffer, idPhotoBuffer);
  } catch (err) {
    console.warn(`[kyc] AWS Rekognition indisponible (${err.name || "Error"}: ${err.message}) — fallback phash`);
    const fallback = await matchFacesPhash(selfieBuffer, idPhotoBuffer);
    return { ...fallback, awsError: err.name || err.message };
  }
}
