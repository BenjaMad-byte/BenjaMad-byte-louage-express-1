// Provider de production — AWS Rekognition CompareFaces.
// Vraie reconnaissance faciale biométrique (détection + embedding + comparaison),
// contrairement au fallback phash. Credentials résolus via la chaîne standard
// AWS SDK v3 (env AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, rôle IAM, profil
// partagé, etc.) — rien à coder ici pour ça.
import { RekognitionClient, CompareFacesCommand } from "@aws-sdk/client-rekognition";

const REGION = process.env.AWS_REKOGNITION_REGION || process.env.AWS_REGION || "eu-west-1";
const REQUEST_TIMEOUT_MS = 8000;

let client = null;
function getClient() {
  if (!client) {
    client = new RekognitionClient({
      region: REGION,
      requestHandler: { requestTimeout: REQUEST_TIMEOUT_MS },
    });
  }
  return client;
}

export function isAwsRekognitionConfigured() {
  // Informationnel uniquement (logs/health) — le SDK peut aussi s'authentifier
  // via rôle IAM/profil partagé sans ces variables d'env.
  return Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

export async function matchFacesAwsRekognition(selfieBuffer, idPhotoBuffer) {
  const command = new CompareFacesCommand({
    SourceImage: { Bytes: selfieBuffer },
    TargetImage: { Bytes: idPhotoBuffer },
    SimilarityThreshold: 0,
  });

  const result = await getClient().send(command);
  const bestMatch = [...(result.FaceMatches || [])].sort((a, b) => b.Similarity - a.Similarity)[0];

  if (!bestMatch) {
    return {
      provider: "aws-rekognition",
      isRealBiometric: true,
      region: REGION,
      score: 0,
      rawSimilarity: 0,
      matched: false,
      sourceFaceConfidence: result.SourceImageFace?.Confidence ?? null,
      unmatchedFacesCount: (result.UnmatchedFaces || []).length,
      reason: "aucun_visage_correspondant_detecte",
    };
  }

  return {
    provider: "aws-rekognition",
    isRealBiometric: true,
    region: REGION,
    score: Number((bestMatch.Similarity / 100).toFixed(4)),
    rawSimilarity: bestMatch.Similarity,
    matched: true,
    sourceFaceConfidence: result.SourceImageFace?.Confidence ?? null,
    targetFaceConfidence: bestMatch.Face?.Confidence ?? null,
  };
}
