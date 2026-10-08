// Vérification d'identité : envoie CIN + selfies au backend KYC (reconnaissance faciale + OCR) en tâche de fond,
// et ne conserve que des indicateurs. Le résultat est une AIDE À LA DÉCISION : l'acceptation reste humaine.
import fs from "node:fs";
import path from "node:path";
import { latinDigits } from "./validate.js";

export const KYC = {
  maxAttempts: 4,
  backoffMs: [30_000, 120_000, 600_000], // après l'échec n°1, 2, 3
  requestTimeoutMs: 120_000,             // OCR + reconnaissance faciale peuvent être lents
};
// Le backend accepte 15 Mo de JSON et le base64 gonfle de 33 % : on plafonne le poids brut envoyé.
// CIN recto et selfies sont indispensables ; permis et licence ne sont joints que s'il reste de la place.
const MAX_REQUEST_RAW_BYTES = 10 * 1024 * 1024;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SELFIE_KIND = /^selfie_\d+$/;

/** Supprime les selfies (données biométriques) de la base et du disque. */
export function purgeSelfies(db, uploadDir, appId) {
  const rows = db.prepare("SELECT id, kind, stored_name FROM files WHERE application_id = ?").all(appId).filter((f) => SELFIE_KIND.test(f.kind));
  for (const f of rows) {
    fs.rmSync(path.join(uploadDir, f.stored_name), { force: true });
    db.prepare("DELETE FROM files WHERE id = ?").run(f.id);
  }
  return rows.length;
}

/** Le numéro saisi apparaît-il tel quel (nombre isolé) dans le texte lu par OCR ? Tolère les espaces insérés par l'OCR. */
export function cinInText(text, cin) {
  const t = latinDigits(text);
  const isolated = new RegExp(`(?<!\\d)${cin}(?!\\d)`);
  return isolated.test(t) || isolated.test(t.replace(/(?<=\d)[ \t]+(?=\d)/g, ""));
}

export function createKycWorker({ db, uploadDir, backendUrl, serviceKey, fetchImpl = fetch, now = Date.now, readUpload }) {
  const touch = "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  // `readUpload` déchiffre les fichiers stockés chiffrés ; sans lui, lecture directe (tests, fichiers en clair).
  const readBytes = (f) => (readUpload ? readUpload(f) : fs.readFileSync(path.join(uploadDir, f.stored_name)));
  const dataUri = (f) => `data:${f.mime};base64,${readBytes(f).toString("base64")}`;
  const endpoint = `${backendUrl.replace(/\/+$/, "")}/api/v1/auth/driver/verify-identity`;
  const headers = { "Content-Type": "application/json", ...(serviceKey ? { "X-Service-Key": serviceKey } : {}) };
  let timer = null;
  let kick = null;
  let running = false;

  const finish = (row, fields) => {
    const cols = Object.keys(fields);
    db.prepare(`UPDATE kyc_checks SET ${cols.map((c) => `${c} = ?`).join(", ")}, ${touch} WHERE id = ?`).run(...cols.map((c) => fields[c]), row.id);
  };

  const retryOrFail = (row, error) => {
    const attempts = row.attempts + 1;
    if (attempts >= KYC.maxAttempts) return finish(row, { status: "error", attempts, error });
    finish(row, { status: "queued", attempts, error, next_attempt_at: now() + KYC.backoffMs[attempts - 1] });
  };

  async function check(row) {
    const app = db.prepare("SELECT ref, cin FROM applications WHERE id = ?").get(row.application_id);
    const files = db.prepare("SELECT kind, stored_name, mime, size, enc, key_id FROM files WHERE application_id = ?").all(row.application_id);
    const byKind = Object.fromEntries(files.map((f) => [f.kind, f]));
    const selfies = files.filter((f) => SELFIE_KIND.test(f.kind) && IMAGE_MIMES.has(f.mime)).sort((a, b) => a.kind.localeCompare(b.kind));
    const cin = byKind.cin_front;

    if (!cin || !IMAGE_MIMES.has(cin.mime)) return finish(row, { status: "skipped", reasons: JSON.stringify(["cin_recto_non_image"]) });
    if (!selfies.length) return finish(row, { status: "skipped", reasons: JSON.stringify(["selfie_absent_ou_purge"]) });

    const body = { driverId: app.ref, cinPhoto: dataUri(cin), selfieFrames: selfies.map(dataUri) };
    let budget = MAX_REQUEST_RAW_BYTES - cin.size - selfies.reduce((n, f) => n + f.size, 0);
    for (const [kind, field] of [["permis", "permisPhoto"], ["licence", "licencePhoto"]]) {
      const f = byKind[kind];
      if (f && IMAGE_MIMES.has(f.mime) && f.size <= budget) { body[field] = dataUri(f); budget -= f.size; }
    }

    let res;
    try {
      res = await fetchImpl(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(KYC.requestTimeoutMs) });
    } catch {
      return retryOrFail(row, "backend_unreachable");
    }
    if (res.status === 401 || res.status === 403) return finish(row, { status: "error", attempts: row.attempts + 1, error: "backend_auth" });
    if (res.status >= 500) return retryOrFail(row, `backend_${res.status}`);
    if (!res.ok) return finish(row, { status: "error", attempts: row.attempts + 1, error: "backend_rejected" });

    const data = await res.json();
    const cinMatch = cinInText(data.ocrCin?.rawText, app.cin);
    const reasons = [...(data.reasons ?? [])];
    if (!cinMatch) reasons.push("cin_ocr_ne_correspond_pas_a_la_saisie");
    // « verified » exige l'accord du backend, une biométrie réelle (pas le fallback) ET une CIN lue = CIN saisie.
    const verified = data.status === "verified" && data.faceMatch?.isRealBiometric === true && cinMatch;

    finish(row, {
      status: verified ? "verified" : "review",
      attempts: row.attempts + 1,
      face_score: data.faceMatch?.score ?? null,
      face_provider: data.faceMatch?.provider ?? null,
      real_biometric: data.faceMatch?.isRealBiometric ? 1 : 0,
      liveness_passed: data.liveness?.passed ? 1 : 0,
      cin_match: cinMatch ? 1 : 0,
      ocr_confidence: data.ocrCin?.confidence ?? null,
      reasons: JSON.stringify(reasons),
      error: null,
    });
    // Minimisation : le backend garde le texte OCR complet en mémoire, on lui demande de l'effacer (au mieux).
    fetchImpl(`${endpoint}/${encodeURIComponent(app.ref)}`, { method: "DELETE", headers, signal: AbortSignal.timeout(10_000) }).catch(() => {});
    if (verified) purgeSelfies(db, uploadDir, row.application_id);
  }

  /** Traite la prochaine vérification due. Retourne false s'il n'y en a pas. */
  async function runOnce() {
    const row = db.prepare("SELECT * FROM kyc_checks WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT 1").get(now());
    if (!row) return false;
    db.prepare(`UPDATE kyc_checks SET status = 'processing', ${touch} WHERE id = ?`).run(row.id);
    try {
      await check(row);
    } catch (e) {
      console.error("[kyc] échec inattendu:", e.message);
      retryOrFail(row, "internal_error");
    }
    return true;
  }

  async function drain() {
    if (running) return;
    running = true;
    try { while (await runOnce()); } finally { running = false; }
  }

  /** Remet en file une vérification (action admin). Impossible si les selfies ont déjà été supprimés. */
  function requeue(appId) {
    const files = db.prepare("SELECT kind, mime FROM files WHERE application_id = ?").all(appId);
    const ok = files.some((f) => f.kind === "cin_front") && files.some((f) => SELFIE_KIND.test(f.kind));
    if (!ok) return false;
    db.prepare(`UPDATE kyc_checks SET status = 'queued', attempts = 0, next_attempt_at = 0, error = NULL, ${touch} WHERE application_id = ?`).run(appId);
    return true;
  }

  function start({ intervalMs = 15_000 } = {}) {
    db.prepare("UPDATE kyc_checks SET status = 'queued' WHERE status = 'processing'").run(); // reprise après un arrêt brutal
    timer = setInterval(drain, intervalMs);
    timer.unref?.();
    kick = setTimeout(drain, 0); // premier passage immédiat, mais pas dans le même tick que start()
  }
  /** Lance un passage tout de suite si le worker tourne (appelé après une inscription ou une relance). */
  const kickNow = () => { if (timer) setTimeout(drain, 0).unref?.(); };
  const stop = () => { clearInterval(timer); clearTimeout(kick); timer = kick = null; };

  /** Demande au backend KYC d'oublier un dossier supprimé (au mieux : il ne garde rien sur disque). */
  const forget = (ref) => fetchImpl(`${endpoint}/${encodeURIComponent(ref)}`, { method: "DELETE", headers, signal: AbortSignal.timeout(10_000) }).catch(() => {});

  return { runOnce, drain, requeue, start, stop, kick: kickNow, forget };
}
