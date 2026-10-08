// Conservation limitée : supprime les dossiers dont la durée annoncée par la politique de confidentialité est dépassée.
//
//   npm run purge -- --dry-run     liste les dossiers concernés, ne supprime rien
//   npm run purge                  supprime (base, pièces, entretiens) et inscrit chaque suppression au journal
//
// Le serveur fait déjà ce passage seul, une fois par jour ; cette commande sert à vérifier avant, ou à forcer un passage.
// Durées : LEGAL_RETENTION_REJECTED_MONTHS (refusés ou abandonnés) et LEGAL_RETENTION_APPROVED_MONTHS (acceptés, APRÈS la fin de collaboration marquée dans l'admin).
import { db, UPLOAD_DIR } from "./db.js";
import { legalValues } from "./legal.js";
import { createUploadStore } from "./uploads.js";
import { purgeExpired } from "./retention.js";

const dryRun = process.argv.includes("--dry-run");
const v = legalValues(process.env);
if (!v.retention_rejected && !v.retention_approved) {
  console.error("Aucune durée définie : renseigner LEGAL_RETENTION_REJECTED_MONTHS et LEGAL_RETENTION_APPROVED_MONTHS.");
  process.exit(1);
}
const uploads = createUploadStore({ dir: UPLOAD_DIR, key: null, previousKeys: [] }); // supprimer un fichier n'exige pas la clé
const r = purgeExpired({ db, uploads }, { dryRun, rejectedMonths: v.retention_rejected, approvedMonths: v.retention_approved });
console.log(`${dryRun ? "[simulation] " : ""}${r.rejected} refusé(s), ${r.abandoned} abandonné(s), ${r.ended} fin(s) de collaboration${dryRun ? " seraient supprimés" : " supprimés"}.`);
if (r.refs.length) console.log(r.refs.join("\n"));
