// Suppression d'un dossier (à la demande du chauffeur, de l'administration, ou par la purge automatique) et conservation limitée.
// Les durées viennent de LEGAL_RETENTION_* : ce sont celles que la politique de confidentialité annonce publiquement.

/** Date ISO située `months` mois avant `nowMs` (arithmétique calendaire en UTC). */
export function cutoffIso(nowMs, months) {
  const d = new Date(nowMs);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

/**
 * Supprime TOUT ce qui concerne un dossier : ligne, vérification d'identité, pièces sur le disque, entretiens (liés au dossier ou au même téléphone),
 * codes SMS en attente. La base d'abord (transaction), les fichiers ensuite : un fichier orphelin est inoffensif, une ligne qui pointe vers un fichier absent non.
 * @returns {{files: number, interviews: number} | null} null si le dossier n'existe pas.
 */
export function eraseApplication({ db, uploads }, appId) {
  const app = db.prepare("SELECT id, ref, phone FROM applications WHERE id = ?").get(appId);
  if (!app) return null;
  const stored = db.prepare("SELECT stored_name FROM files WHERE application_id = ?").all(app.id).map((f) => f.stored_name);
  let interviews = 0;
  db.exec("BEGIN");
  try {
    interviews = db.prepare("DELETE FROM interviews WHERE application_id = ? OR phone = ?").run(app.id, app.phone).changes;
    db.prepare("DELETE FROM notifications WHERE application_id = ? OR phone = ?").run(app.id, app.phone);
    db.prepare("DELETE FROM otp_codes WHERE phone = ?").run(app.phone);
    db.prepare("DELETE FROM phone_verifications WHERE phone = ?").run(app.phone);
    db.prepare("DELETE FROM applications WHERE id = ?").run(app.id); // files et kyc_checks suivent (ON DELETE CASCADE)
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  for (const name of stored) uploads.remove(name);
  return { ref: app.ref, files: stored.length, interviews };
}

/**
 * Dossiers dont la durée de conservation est dépassée.
 *  - refusés : depuis la décision (à défaut, la dernière modification) ;
 *  - abandonnés : en attente ou en entretien sans aucune activité depuis aussi longtemps ;
 *  - acceptés : seulement après la fin de collaboration marquée par l'administration, jamais avant.
 * Une durée absente (null) désactive la catégorie correspondante.
 */
export function findExpired(db, { now = Date.now(), rejectedMonths = null, approvedMonths = null } = {}) {
  const found = [];
  if (rejectedMonths) {
    const cutoff = cutoffIso(now, rejectedMonths);
    for (const r of db.prepare("SELECT id, ref FROM applications WHERE status = 'rejected' AND COALESCE(decided_at, updated_at) < ?").all(cutoff)) found.push({ ...r, reason: "rejected" });
    for (const r of db.prepare("SELECT id, ref FROM applications WHERE status IN ('pending','interview') AND updated_at < ?").all(cutoff)) found.push({ ...r, reason: "abandoned" });
  }
  if (approvedMonths) {
    const cutoff = cutoffIso(now, approvedMonths);
    for (const r of db.prepare("SELECT id, ref FROM applications WHERE status = 'approved' AND ended_at IS NOT NULL AND ended_at < ?").all(cutoff)) found.push({ ...r, reason: "ended" });
  }
  return found;
}

/**
 * Supprime les dossiers périmés. `dryRun` : liste sans rien supprimer. Chaque suppression est inscrite au journal (référence seulement).
 * @returns {{dryRun: boolean, rejected: number, abandoned: number, ended: number, refs: string[]}}
 */
export function purgeExpired({ db, uploads, onErase }, { dryRun = false, ...limits } = {}) {
  const expired = findExpired(db, limits);
  const out = { dryRun, rejected: 0, abandoned: 0, ended: 0, refs: [] };
  for (const item of expired) {
    out[item.reason] += 1;
    out.refs.push(item.ref);
    if (dryRun) continue;
    const erased = eraseApplication({ db, uploads }, item.id);
    if (!erased) continue;
    db.prepare("INSERT INTO admin_audit (ip, action, ref) VALUES ('system', ?, ?)").run(`retention_purge_${item.reason}`, item.ref);
    onErase?.(item.ref);
  }
  return out;
}
