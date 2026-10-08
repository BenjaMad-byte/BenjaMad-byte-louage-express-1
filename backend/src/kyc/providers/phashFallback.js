// Fallback dev/offline — PAS une reconnaissance biométrique faciale réelle.
// Similarité structurelle d'image par perceptual hash (dHash) : pas de
// détection de visage, pas d'alignement, pas d'embedding. Utilisé uniquement
// quand AWS Rekognition n'est pas configuré/joignable — voir faceMatch.js.
import sharp from "sharp";

const HASH_W = 9;
const HASH_H = 8;

async function dHash(imageBuffer) {
  const { data } = await sharp(imageBuffer)
    .resize(HASH_W, HASH_H, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = "";
  for (let row = 0; row < HASH_H; row++) {
    for (let col = 0; col < HASH_W - 1; col++) {
      const left = data[row * HASH_W + col];
      const right = data[row * HASH_W + col + 1];
      bits += left < right ? "1" : "0";
    }
  }
  return bits;
}

function hammingDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

export async function matchFacesPhash(selfieBuffer, idPhotoBuffer) {
  const [hashSelfie, hashId] = await Promise.all([dHash(selfieBuffer), dHash(idPhotoBuffer)]);
  const totalBits = hashSelfie.length;
  const distance = hammingDistance(hashSelfie, hashId);
  const score = 1 - distance / totalBits;

  return {
    provider: "phash-fallback",
    isRealBiometric: false,
    score: Number(score.toFixed(4)),
    hammingDistance: distance,
  };
}
