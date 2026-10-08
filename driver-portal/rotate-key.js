// Rotation de la clé de chiffrement des pièces (et chiffrement des fichiers restés en clair).
//
//   1. Générer une nouvelle clé :           node deploy/secrets.js        (garder DATA_KEY affichée)
//   2. Dans l'environnement :               DATA_KEY=<nouvelle>   DATA_KEY_PREVIOUS=<ancienne>
//   3. Redémarrer le service, puis :        npm run rotate-key -- --status     (ne modifie rien)
//                                           npm run rotate-key                 (rechiffre tout)
//   4. Vérifier avec --status : « 0 fichier(s) à rechiffrer ». Retirer DATA_KEY_PREVIOUS seulement quand les sauvegardes
//      faites avec l'ancienne clé ont expiré (elles ne se relisent qu'avec elle).
//
// Relançable à volonté (reprise après coupure), sans arrêter le site. Aucune clé n'est jamais affichée : seulement leurs empreintes.
import { db, UPLOAD_DIR } from "./db.js";
import { parseDataKeys } from "./security.js";
import { createUploadStore, rotateAllFiles, inspectKeys } from "./uploads.js";
import { createAdminAuth } from "./admin-auth.js";

const statusOnly = process.argv.includes("--status");
let keys;
try {
  keys = parseDataKeys(process.env.DATA_KEY, process.env.DATA_KEY_PREVIOUS);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (!keys.current) {
  console.error("DATA_KEY est requise (la NOUVELLE clé, 32 octets en hexadécimal ou base64).");
  process.exit(1);
}
const store = createUploadStore({ dir: UPLOAD_DIR, key: keys.current, previousKeys: keys.previous });

function report(status) {
  const f = status.files;
  const todo = f.other + f.plaintext + f.unknown_fingerprint;
  console.log(`Clé courante : ${status.current_key_id}   Anciennes clés fournies : ${keys.previous.length ? status.known_key_ids.slice(1).join(", ") : "aucune"}`);
  console.log(`Fichiers : ${f.total} au total, ${f.current} sur la clé courante, ${f.other} sur une autre clé, ${f.unknown_fingerprint} sans empreinte, ${f.plaintext} en clair`);
  if (status.unreadable_key_ids.length) console.log(`⚠ Clés manquantes (empreintes) : ${status.unreadable_key_ids.join(", ")} : ajouter l'ancienne clé dans DATA_KEY_PREVIOUS.`);
  console.log(`${todo} fichier(s) à rechiffrer`);
  return todo;
}

const before = inspectKeys({ db, store });
let todo = report(before);

// Les secrets de double authentification des comptes admin sont scellés avec DATA_KEY : ils suivent la rotation.
const adminAuth = createAdminAuth({ db, keys: { current: keys.current, previous: keys.previous } });
const secretsTodo = adminAuth.unsealedCount();
console.log(`${secretsTodo} secret(s) de double authentification à rechiffrer`);
todo += secretsTodo;
if (!statusOnly && secretsTodo > 0) console.log(`${adminAuth.reseal()} secret(s) de double authentification rechiffré(s)`);

if (!statusOnly && before.files.other + before.files.plaintext + before.files.unknown_fingerprint > 0) {
  const result = rotateAllFiles({ db, store });
  console.log(`${result.rotated} fichier(s) rechiffré(s), ${result.repaired} base(s) remise(s) à jour`);
  for (const f of result.failed) console.error(`✖ ${f.stored_name} : ${f.reason}`);
  db.prepare("INSERT INTO admin_audit (ip, action, ref) VALUES ('cli', 'key_rotation', NULL)").run();
  if (result.failed.length) {
    console.error(`${result.failed.length} fichier(s) non terminés. Aucun fichier n'est perdu ni abîmé : relancer la même commande pour reprendre.`);
    db.close();
    process.exit(1);
  }
  console.log("\nTerminé. ANCIENNES CLÉS : ne retirer DATA_KEY_PREVIOUS qu'une fois les sauvegardes faites avec l'ancienne clé expirées (elles ne se relisent qu'avec elle).");
}
db.close();
