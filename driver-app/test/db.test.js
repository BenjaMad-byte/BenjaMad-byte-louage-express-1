// Garde-fou de migration : un futur ajout de colonne doit réellement s'appliquer à une base existante
// (CREATE TABLE IF NOT EXISTS seul ne le fait jamais).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempData } from "./_helpers.js";

tempData();
const { db, ensureColumn } = await import("../db.js");

const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

test("ensureColumn : ajoute une colonne manquante, et un second appel ne lève pas", () => {
  assert.equal(hasColumn("drivers", "test_migration_col"), false);
  ensureColumn("drivers", "test_migration_col", "TEXT");
  assert.ok(hasColumn("drivers", "test_migration_col"));
  assert.doesNotThrow(() => ensureColumn("drivers", "test_migration_col", "TEXT"));
});

test("ensureColumn : une colonne déjà déclarée dans CREATE TABLE n'est jamais recréée", () => {
  ensureColumn("drivers", "plate", "TEXT"); // colonne réelle du schéma, déjà NOT NULL
  const matches = db.prepare("PRAGMA table_info(drivers)").all().filter((c) => c.name === "plate");
  assert.equal(matches.length, 1);
});
