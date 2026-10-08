// Stockage des pièces envoyées par les chauffeurs (CIN, permis, licence, selfies).
// Avec une clé (DATA_KEY), chaque fichier est chiffré sur le disque ; sans clé (développement), il est stocké tel quel.
// Rotation : DATA_KEY est la clé qui ÉCRIT ; les anciennes clés (DATA_KEY_PREVIOUS) ne servent qu'à LIRE, le temps de tout rechiffrer.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { encryptBuffer, decryptBuffer, keyId } from "./security.js";

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Renommage atomique. Sous Windows, renommer un fichier pendant qu'il est lu est refusé un instant (EPERM/EBUSY) : quelques nouvelles tentatives. */
function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      if (attempt >= 8 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      sleepSync(25 * attempt);
    }
  }
}

export function createUploadStore({ dir, key, previousKeys = [] }) {
  const full = (name) => path.join(dir, name);
  const allKeys = [key, ...previousKeys].filter(Boolean);
  const byId = new Map(allKeys.map((k) => [keyId(k), k]));
  const currentId = key ? keyId(key) : null;

  /** Déchiffre avec la clé déclarée par la base, puis avec la clé courante, puis avec les anciennes. */
  function decryptAny(bytes, declaredId) {
    const order = [];
    const declared = declaredId ? byId.get(declaredId) : null;
    if (declared) order.push(declared);
    for (const k of allKeys) if (!order.includes(k)) order.push(k);
    for (const k of order) {
      try {
        return { plain: decryptBuffer(bytes, k), usedKeyId: keyId(k) };
      } catch { /* clé suivante : l'authentification GCM échoue avec une mauvaise clé */ }
    }
    if (!allKeys.length) throw new Error("DATA_KEY est requise pour lire ce fichier chiffré");
    const hint = declaredId && !byId.has(declaredId) ? ` Ce fichier a été chiffré avec la clé d'empreinte ${declaredId} : la fournir dans DATA_KEY_PREVIOUS.` : "";
    throw new Error(`aucune clé fournie ne déchiffre ce fichier.${hint}`);
  }

  return {
    keyId: currentId,
    knownKeyIds: [...byId.keys()],
    /** Écrit le fichier et retourne les colonnes à enregistrer : { stored_name, enc, key_id }. */
    save(buffer, ext) {
      const stored_name = `${crypto.randomBytes(16).toString("hex")}${ext}`;
      fs.writeFileSync(full(stored_name), key ? encryptBuffer(buffer, key) : buffer, { mode: 0o600 });
      return { stored_name, enc: key ? 1 : 0, key_id: currentId };
    },
    /** Relit le fichier d'origine à partir de la ligne `files` (stored_name, enc, key_id). */
    read({ stored_name, enc, key_id }) {
      const bytes = fs.readFileSync(full(stored_name));
      return enc ? decryptAny(bytes, key_id).plain : bytes;
    },
    remove(stored_name) {
      fs.rmSync(full(stored_name), { force: true });
    },
    /**
     * Met un fichier sur la clé courante. Écriture dans un fichier temporaire, relecture et comparaison, puis renommage atomique :
     * à aucun moment le fichier d'origine n'est abîmé. Retourne { status, enc, key_id } avec status :
     * « rotated » (réécrit), « repaired » (déjà sur la clé courante, seule la base était en retard), « current » (rien à faire).
     */
    rotate({ stored_name, enc, key_id }) {
      if (!key) throw new Error("DATA_KEY est requise pour chiffrer");
      const target = full(stored_name);
      const bytes = fs.readFileSync(target);
      let plain = bytes;
      if (enc) {
        const r = decryptAny(bytes, key_id);
        if (r.usedKeyId === currentId) return { status: key_id === currentId ? "current" : "repaired", enc: 1, key_id: currentId };
        plain = r.plain;
      }
      const out = encryptBuffer(plain, key);
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, out, { mode: 0o600 });
      let check;
      try {
        check = decryptBuffer(fs.readFileSync(tmp), key);
      } catch {
        check = null;
      }
      if (!check || !check.equals(plain)) {
        fs.rmSync(tmp, { force: true });
        throw new Error("vérification du fichier rechiffré échouée : original conservé");
      }
      renameWithRetry(tmp, target);
      return { status: "rotated", enc: 1, key_id: currentId };
    },
  };
}

/**
 * Rechiffre tous les fichiers qui ne sont pas encore sur la clé courante (en clair, ou chiffrés avec une ancienne clé).
 * Relançable à volonté : un fichier déjà à jour n'est ni lu ni réécrit. Une panne sur un fichier n'arrête pas les autres.
 * @returns {{rotated: number, repaired: number, failed: {id: number, stored_name: string, reason: string}[]}}
 */
export function rotateAllFiles({ db, store }) {
  if (!store.keyId) throw new Error("DATA_KEY est requise pour rechiffrer");
  const rows = db.prepare("SELECT id, stored_name, enc, key_id FROM files WHERE enc = 0 OR key_id IS NULL OR key_id <> ?").all(store.keyId); // pas de NOT(...) : avec key_id NULL, la comparaison est « inconnue » et la ligne serait ignorée
  const result = { rotated: 0, repaired: 0, failed: [] };
  for (const row of rows) {
    try {
      const r = store.rotate(row);
      db.prepare("UPDATE files SET enc = ?, key_id = ? WHERE id = ?").run(r.enc, r.key_id, row.id);
      if (r.status === "rotated") result.rotated += 1;
      else if (r.status === "repaired") result.repaired += 1;
    } catch (e) {
      result.failed.push({ id: row.id, stored_name: row.stored_name, reason: e.message });
    }
  }
  return result;
}

const SAMPLE_UNLABELED = 5;

/** État des clés : où en sont les fichiers, et manque-t-il une clé pour en lire certains ? Ne contient jamais de clé. */
export function inspectKeys({ db, store }) {
  const rows = db.prepare("SELECT id, stored_name, enc, key_id FROM files").all();
  const files = { total: rows.length, current: 0, other: 0, plaintext: 0, unknown_fingerprint: 0 };
  const unreadable = new Set();
  const unlabeled = [];
  for (const r of rows) {
    if (!r.enc) files.plaintext += 1;
    else if (!r.key_id) { files.unknown_fingerprint += 1; unlabeled.push(r); }
    else if (r.key_id === store.keyId) files.current += 1;
    else {
      files.other += 1;
      if (!store.knownKeyIds.includes(r.key_id)) unreadable.add(r.key_id);
    }
  }
  // Fichiers sans empreinte (anciens) : on ne sait pas quelle clé les a chiffrés, on en essaie quelques-uns.
  let unreadableUnlabeled = 0;
  for (const r of unlabeled.slice(-SAMPLE_UNLABELED)) {
    try {
      store.read(r);
    } catch {
      unreadableUnlabeled += 1;
    }
  }
  return {
    current_key_id: store.keyId,
    known_key_ids: store.knownKeyIds,
    files,
    unreadable_key_ids: [...unreadable].sort(),
    unreadable_unlabeled: unreadableUnlabeled,
    readable: unreadable.size === 0 && unreadableUnlabeled === 0,
  };
}
