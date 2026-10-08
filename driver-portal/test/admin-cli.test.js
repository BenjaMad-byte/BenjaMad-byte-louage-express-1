import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-admincli-"));
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const run = (...args) => {
  const r = spawnSync(process.execPath, ["admin-cli.js", ...args], { cwd: root, env: { ...process.env, DATA_DIR: dataDir }, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
};
const tempPassword = (out) => out.match(/([a-z2-9]{4}-){3}[a-z2-9]{4}/)?.[0];

test("ligne de commande : premier compte propriétaire, suivants relecteurs, mot de passe provisoire affiché une fois", () => {
  assert.match(run("list").out, /Aucun compte/);
  const first = run("create", "alice", "--name", "Alice A.");
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /\(owner\)/);
  assert.ok(tempPassword(first.out));
  const second = run("create", "bob");
  assert.match(second.out, /\(reviewer\)/);
  assert.notEqual(tempPassword(first.out), tempPassword(second.out));
  const list = run("list").out;
  assert.match(list, /alice\s+owner\s+actif\s+2FA:non/);
  assert.match(list, /bob\s+reviewer/);
  assert.ok(!list.includes(tempPassword(first.out)), "la liste n'affiche jamais de mot de passe");
});

test("ligne de commande : refus clairs (doublon, nom invalide, compte inconnu, dernier propriétaire) et réinitialisations", () => {
  assert.equal(run("create", "alice").code, 1);
  assert.match(run("create", "Alice B").out, /invalid_username/);
  assert.match(run("reset-2fa", "personne").out, /introuvable/);
  assert.match(run("disable", "alice").out, /dernier propriétaire/);
  assert.equal(run("disable", "bob").code, 0);
  assert.match(run("list").out, /bob\s+reviewer\s+inactif/);
  assert.equal(run("enable", "bob").code, 0);
  const reset = run("reset-password", "bob");
  assert.ok(tempPassword(reset.out));
  assert.equal(run("reset-2fa", "bob").code, 0);
  assert.equal(run("unlock", "bob").code, 0);
  assert.equal(run("inconnue").code, 1);
});

test("ligne de commande : chaque action est inscrite au journal sous l'acteur « cli », sans mot de passe", async () => {
  process.env.DATA_DIR = dataDir;
  const { db } = await import("../db.js");
  try {
    const rows = db.prepare("SELECT ip, action, ref, actor FROM admin_audit ORDER BY id").all().map((r) => ({ ...r }));
    assert.ok(rows.length >= 6);
    assert.ok(rows.every((r) => r.ip === "local" && r.actor === "cli"));
    assert.ok(rows.some((r) => r.action === "user_create" && r.ref === "alice"));
    assert.ok(rows.some((r) => r.action === "user_reset_password" && r.ref === "bob"));
    assert.ok(!JSON.stringify(rows).match(/([a-z2-9]{4}-){3}[a-z2-9]{4}/));
  } finally {
    db.close();
  }
});
