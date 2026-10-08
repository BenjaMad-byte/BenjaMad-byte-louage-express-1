import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { keyId, parseDataKeys, encryptBuffer, assertProductionConfig } from "../security.js";
import { createUploadStore, rotateAllFiles, inspectKeys } from "../uploads.js";
import { LEGAL_ENV } from "./legal-fixture.js";

const A = crypto.randomBytes(32);
const B = crypto.randomBytes(32);
const C = crypto.randomBytes(32);

/** Environnement jetable : dossier de fichiers + table `files` minimale. */
function lab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rotation-"));
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE files (id INTEGER PRIMARY KEY, stored_name TEXT, enc INTEGER NOT NULL DEFAULT 0, key_id TEXT)");
  const add = (name, bytes, enc, kid) => {
    fs.writeFileSync(path.join(dir, name), bytes);
    db.prepare("INSERT INTO files (stored_name, enc, key_id) VALUES (?,?,?)").run(name, enc, kid);
  };
  const row = (name) => ({ ...db.prepare("SELECT * FROM files WHERE stored_name = ?").get(name) });
  return { dir, db, add, row, done() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("empreinte de clé : stable, courte, différente d'une clé à l'autre, sans révéler la clé", () => {
  assert.equal(keyId(A), keyId(Buffer.from(A)));
  assert.notEqual(keyId(A), keyId(B));
  assert.match(keyId(A), /^[0-9a-f]{16}$/);
  assert.notEqual(keyId(A), A.toString("hex").slice(0, 16), "l'empreinte n'est pas un extrait de la clé");
});

test("DATA_KEY + DATA_KEY_PREVIOUS : analyse, formats mixtes, refus des cas dangereux", () => {
  const ok = parseDataKeys(B.toString("hex"), `${A.toString("base64")}, ${C.toString("hex")}`);
  assert.deepEqual(ok.current, B);
  assert.deepEqual(ok.previous, [A, C]);
  assert.deepEqual(parseDataKeys(B.toString("hex"), undefined).previous, []);
  assert.deepEqual(parseDataKeys(undefined, undefined), { current: null, previous: [] });
  assert.throws(() => parseDataKeys(undefined, A.toString("hex")), /DATA_KEY_PREVIOUS.*DATA_KEY/s, "des anciennes clés sans clé courante : incohérent");
  assert.throws(() => parseDataKeys(B.toString("hex"), B.toString("hex")), /identique/, "la clé courante ne peut pas figurer parmi les anciennes");
  assert.throws(() => parseDataKeys(B.toString("hex"), `${A.toString("hex")},${A.toString("hex")}`), /deux fois/);
  assert.throws(() => parseDataKeys(B.toString("hex"), "trop-court"), /DATA_KEY_PREVIOUS/);
});

test("lecture : la clé déclarée, la clé courante ou une ancienne ; message précis si aucune ne convient", () => {
  const l = lab();
  try {
    const plain = Buffer.from("CIN-01234567");
    const oldStore = createUploadStore({ dir: l.dir, key: A });
    const saved = oldStore.save(plain, ".png");
    assert.equal(saved.key_id, keyId(A));

    const rotated = createUploadStore({ dir: l.dir, key: B, previousKeys: [A] });
    assert.deepEqual(rotated.read(saved), plain, "après rotation de la clé, les anciens fichiers restent lisibles tant que l'ancienne clé est fournie");
    assert.deepEqual(rotated.read({ ...saved, key_id: null }), plain, "ancien fichier sans empreinte : toutes les clés sont essayées");

    const forgotten = createUploadStore({ dir: l.dir, key: B });
    assert.throws(() => forgotten.read(saved), (e) => e.message.includes(keyId(A)) && e.message.includes("DATA_KEY_PREVIOUS") && !e.message.includes(A.toString("hex")), "le message cite l'empreinte et la variable à renseigner, jamais la clé");
    assert.throws(() => forgotten.read({ ...saved, key_id: null }), /aucune clé/i);
  } finally {
    l.done();
  }
});

test("rotation : tout passe sur la nouvelle clé, contenu identique, relançable sans effet", () => {
  const l = lab();
  try {
    const contents = { plain: Buffer.from("EN-CLAIR"), legacyA: Buffer.from("ANCIEN-SANS-EMPREINTE"), declA: Buffer.from("ANCIEN-AVEC-EMPREINTE"), crashB: Buffer.from("DEJA-NOUVELLE-CLE"), okB: Buffer.from("TOUT-EST-DEJA-BON") };
    l.add("plain.png", contents.plain, 0, null);
    l.add("legacyA.png", encryptBuffer(contents.legacyA, A), 1, null);
    l.add("declA.png", encryptBuffer(contents.declA, A), 1, keyId(A));
    l.add("crashB.png", encryptBuffer(contents.crashB, B), 1, null); // coupure entre le renommage du fichier et la mise à jour de la base
    l.add("okB.png", encryptBuffer(contents.okB, B), 1, keyId(B));
    const untouchedBefore = fs.readFileSync(path.join(l.dir, "okB.png"));

    const store = createUploadStore({ dir: l.dir, key: B, previousKeys: [A] });
    const first = rotateAllFiles({ db: l.db, store });
    assert.deepEqual({ rotated: first.rotated, repaired: first.repaired, failed: first.failed.length }, { rotated: 3, repaired: 1, failed: 0 });

    for (const name of Object.keys(contents)) {
      const r = l.row(`${name}.png`);
      assert.equal(r.enc, 1, name);
      assert.equal(r.key_id, keyId(B), name);
      assert.deepEqual(store.read(r), contents[name], `${name} : contenu intact`);
      assert.ok(!fs.readFileSync(path.join(l.dir, `${name}.png`)).includes(contents[name]), `${name} : plus rien en clair`);
    }
    assert.deepEqual(fs.readFileSync(path.join(l.dir, "okB.png")), untouchedBefore, "un fichier déjà à jour n'est pas réécrit");
    // Sans l'ancienne clé, tout est lisible : la rotation est complète
    const onlyNew = createUploadStore({ dir: l.dir, key: B });
    for (const name of Object.keys(contents)) assert.deepEqual(onlyNew.read(l.row(`${name}.png`)), contents[name]);

    assert.deepEqual(rotateAllFiles({ db: l.db, store }), { rotated: 0, repaired: 0, failed: [] }, "deuxième passage : rien à faire");
    assert.equal(fs.readdirSync(l.dir).filter((n) => n.endsWith(".tmp")).length, 0);
  } finally {
    l.done();
  }
});

test("rotation : une panne sur un fichier n'arrête pas les autres et n'abîme jamais l'original", () => {
  const l = lab();
  try {
    l.add("good.png", encryptBuffer(Buffer.from("BON"), A), 1, keyId(A));
    l.add("lostkey.png", encryptBuffer(Buffer.from("CLE-PERDUE"), C), 1, keyId(C)); // chiffré avec une clé qu'on n'a plus
    l.db.prepare("INSERT INTO files (stored_name, enc, key_id) VALUES ('missing.png', 1, ?)").run(keyId(A)); // fichier disparu du disque
    const lostBytes = fs.readFileSync(path.join(l.dir, "lostkey.png"));
    fs.writeFileSync(path.join(l.dir, "good.png.tmp"), "reste d'une coupure précédente");

    const store = createUploadStore({ dir: l.dir, key: B, previousKeys: [A] });
    const r = rotateAllFiles({ db: l.db, store });
    assert.equal(r.rotated, 1, "le bon fichier est quand même traité");
    assert.deepEqual(r.failed.map((f) => f.stored_name).sort(), ["lostkey.png", "missing.png"]);
    assert.ok(r.failed.every((f) => typeof f.reason === "string" && !f.reason.includes(A.toString("hex"))));
    assert.deepEqual(fs.readFileSync(path.join(l.dir, "lostkey.png")), lostBytes, "le fichier illisible n'est pas modifié");
    assert.equal(l.row("lostkey.png").key_id, keyId(C), "sa ligne en base non plus");
    assert.deepEqual(store.read(l.row("good.png")), Buffer.from("BON"));
    assert.equal(fs.existsSync(path.join(l.dir, "good.png.tmp")), false, "le reste d'une coupure précédente est écrasé puis renommé");
  } finally {
    l.done();
  }
});

test("état des clés : combien de fichiers sur la clé courante, sur d'autres, en clair, et quelles empreintes inconnues", () => {
  const l = lab();
  try {
    l.add("a.png", encryptBuffer(Buffer.from("1"), A), 1, keyId(A));
    l.add("b.png", encryptBuffer(Buffer.from("2"), B), 1, keyId(B));
    l.add("c.png", encryptBuffer(Buffer.from("3"), C), 1, keyId(C));
    l.add("d.png", Buffer.from("4"), 0, null);
    l.add("e.png", encryptBuffer(Buffer.from("5"), B), 1, null);
    const status = inspectKeys({ db: l.db, store: createUploadStore({ dir: l.dir, key: B, previousKeys: [A] }) });
    assert.equal(status.current_key_id, keyId(B));
    assert.deepEqual(status.files, { total: 5, current: 1, other: 2, plaintext: 1, unknown_fingerprint: 1 });
    assert.deepEqual(status.unreadable_key_ids, [keyId(C)], "empreinte sans clé correspondante : la clé manque");
    assert.equal(status.readable, false);
    assert.ok(!JSON.stringify(status).includes(B.toString("hex")));
    const ok = inspectKeys({ db: l.db, store: createUploadStore({ dir: l.dir, key: B, previousKeys: [A, C] }) });
    assert.equal(ok.readable, true);
    assert.deepEqual(ok.unreadable_key_ids, []);
  } finally {
    l.done();
  }
});

test("configuration de production : DATA_KEY_PREVIOUS valide, jamais identique à DATA_KEY", () => {
  const good = {
    NODE_ENV: "production", ADMIN_TOKEN: "a".repeat(32), DATA_KEY: B.toString("hex"), OTP_SECRET: "o".repeat(32), KYC_SERVICE_KEY: "k".repeat(24),
    KYC_BACKEND_URL: "https://kyc.example.tn", SMS_PROVIDER: "twilio", TRUST_PROXY: "1", PUBLIC_URL: "https://inscription.exemple.tn", ...LEGAL_ENV,
  };
  assert.doesNotThrow(() => assertProductionConfig({ ...good, DATA_KEY_PREVIOUS: A.toString("hex") }));
  assert.throws(() => assertProductionConfig({ ...good, DATA_KEY_PREVIOUS: B.toString("hex") }), /DATA_KEY_PREVIOUS/);
  assert.throws(() => assertProductionConfig({ ...good, DATA_KEY_PREVIOUS: "nimporte" }), /DATA_KEY_PREVIOUS/);
});
