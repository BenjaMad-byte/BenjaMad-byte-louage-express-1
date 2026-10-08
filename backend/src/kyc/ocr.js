// OCR des documents (CIN / Permis / Licence transport) via Tesseract.js.
// Extraction réelle de texte (pas un mock) — le parsing des champs (regex)
// est calibré pour le format CIN tunisienne (8 chiffres) et reste best-effort :
// à durcir avec un template matching par type de document en production.
import { createWorker } from "tesseract.js";

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker("eng"); // eng dispo par défaut; ajouter "fra" pour prod CIN tunisienne
  }
  return workerPromise;
}

export async function extractDocumentText(imageBuffer) {
  const worker = await getWorker();
  const { data } = await worker.recognize(imageBuffer);
  return { rawText: data.text || "", confidence: data.confidence ?? 0 };
}

const CIN_REGEX = /\b\d{8}\b/;
const DATE_REGEX = /\b(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})\b/;
const PERMIS_REGEX = /\b[A-Z0-9]{6,12}\b/;

export function parseCinFields(rawText) {
  const cinMatch = rawText.match(CIN_REGEX);
  const dateMatch = rawText.match(DATE_REGEX);
  return {
    cinNumber: cinMatch ? cinMatch[0] : null,
    birthDate: dateMatch ? dateMatch[0] : null,
  };
}

export function parsePermisFields(rawText) {
  const numberMatch = rawText.match(PERMIS_REGEX);
  const dateMatch = rawText.match(DATE_REGEX);
  return {
    permisNumber: numberMatch ? numberMatch[0] : null,
    expiryDate: dateMatch ? dateMatch[0] : null,
  };
}

export async function terminateOcr() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}
