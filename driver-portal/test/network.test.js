import test from "node:test";
import assert from "node:assert/strict";
import { buildNetwork, networkCsv, foldPlace } from "../network.js";

const row = (o) => ({ governorate: "Gafsa", line_type: "regional", line_from: "Redeyef", line_to_gov: "Gafsa", status: "pending", ...o });

test("foldPlace ignore casse, accents latins et ponctuation", () => {
  assert.equal(foldPlace(" Redéyef! "), "redeyef");
  assert.equal(foldPlace("Oum  Larayes"), "oum larayes");
  assert.equal(foldPlace("الرَّديف"), foldPlace("الرديف"));
});

test("buildNetwork liste toujours les 24 gouvernorats, même sans circuit", () => {
  const n = buildNetwork([]);
  assert.equal(n.length, 24);
  assert.ok(n.every((g) => g.drivers === 0 && g.regional.length === 0 && g.interregional.length === 0));
});

test("buildNetwork regroupe les orthographes d'une même ville et garde la plus fréquente", () => {
  const n = buildNetwork([row({ line_from: "Redeyef" }), row({ line_from: "redeyef" }), row({ line_from: "Redeyef", status: "approved" }), row({ line_from: "Métlaoui" })]);
  const gafsa = n.find((g) => g.governorate === "Gafsa");
  assert.equal(gafsa.drivers, 4);
  assert.equal(gafsa.regional.length, 2);
  assert.deepEqual(gafsa.regional[0], { type: "regional", from: "Redeyef", from_ar: "الرديف", recognized: true, to_gov: "Gafsa", drivers: 3, approved: 1, via: [], pickup: 0, partial: 0 });
});

test("buildNetwork sépare régional et interrégional et classe par gouvernorat de départ", () => {
  const n = buildNetwork([row({}), row({ line_type: "interregional", line_from: "Gafsa", line_to_gov: "Tunis" }), row({ governorate: "Sousse", line_from: "Sousse", line_type: "interregional", line_to_gov: "Tunis" })]);
  const gafsa = n.find((g) => g.governorate === "Gafsa");
  assert.equal(gafsa.regional.length, 1);
  assert.equal(gafsa.interregional.length, 1);
  assert.equal(n.find((g) => g.governorate === "Sousse").interregional[0].to_gov, "Tunis");
});

test("buildNetwork ignore les refusés et les demandes sans circuit (anciennes)", () => {
  const n = buildNetwork([row({ status: "rejected" }), row({ line_type: null, line_from: null })]);
  assert.equal(n.find((g) => g.governorate === "Gafsa").drivers, 0);
});

test("networkCsv neutralise les formules et échappe les guillemets", () => {
  const csv = networkCsv(buildNetwork([row({ line_from: "=HYPERLINK(\"x\")" }), row({ line_from: 'Ville "Inconnue"' })]));
  assert.ok(csv.startsWith("﻿gouvernorat_depart,type"));
  assert.ok(csv.includes("\"'=HYPERLINK(\"\"x\"\")\""));
  assert.ok(csv.includes('"Ville ""Inconnue"""'));
});

test("buildNetwork agrège les arrêts en route et les comportements (prend en route / part incomplet)", () => {
  const n = buildNetwork([
    row({ line_via: JSON.stringify(["Métlaoui", "Oum Larayes"]), pickup_en_route: 1 }),
    row({ line_via: JSON.stringify(["metlaoui"]), pickup_en_route: 1, leaves_partial: 1 }),
    row({ line_via: "pas du json", leaves_partial: 1 }),
    row({ line_via: null }),
  ]);
  const line = n.find((g) => g.governorate === "Gafsa").regional[0];
  assert.equal(line.drivers, 4);
  assert.equal(line.pickup, 2);
  assert.equal(line.partial, 2);
  assert.deepEqual(line.via, [{ city: "Metlaoui", city_ar: "المتلوي", recognized: true, drivers: 2 }, { city: "Oum El Araies", city_ar: "أم العرائس", recognized: true, drivers: 1 }]);
});

test("networkCsv exporte les arrêts en route", () => {
  const csv = networkCsv(buildNetwork([row({ line_via: JSON.stringify(["Métlaoui", "Oum Larayes"]), pickup_en_route: 1 })]));
  assert.ok(csv.includes("Gafsa,regional,Redeyef,Gafsa,1,0,Metlaoui | Oum El Araies,1,0"));
});

test("buildNetwork classe les louages nationaux à part, regroupés par ville de départ", () => {
  const n = buildNetwork([
    row({ governorate: "Médenine", line_type: "national", line_from: "Médenine", line_to_gov: null }),
    row({ governorate: "Médenine", line_type: "national", line_from: "medenine", line_to_gov: null, status: "approved" }),
    row({ governorate: "Médenine", line_type: "national", line_from: "Zarzis", line_to_gov: null }),
  ]);
  const med = n.find((g) => g.governorate === "Médenine");
  assert.equal(med.regional.length + med.interregional.length, 0);
  assert.equal(med.national.length, 2);
  assert.deepEqual(med.national[0], { type: "national", from: "Médenine", from_ar: "مدنين", recognized: true, to_gov: null, drivers: 2, approved: 1, via: [], pickup: 0, partial: 0 });
  assert.ok(networkCsv(n).includes("Médenine,national,Médenine,tous,2,1,,0,0"));
});

test("buildNetwork classe les lignes rurales à part des lignes régionales", () => {
  const n = buildNetwork([
    row({ governorate: "Médenine", line_type: "rural", line_from: "Jelal", line_to_gov: "Médenine" }),
    row({ governorate: "Médenine", line_type: "regional", line_from: "Zarzis", line_to_gov: "Médenine" }),
  ]);
  const med = n.find((g) => g.governorate === "Médenine");
  assert.equal(med.rural.length, 1);
  assert.equal(med.regional.length, 1);
  assert.equal(med.rural[0].from, "Jelal");
  assert.ok(networkCsv(n).includes("Médenine,rural,Jelal,Médenine,1,0,,0,0"));
});

test("fusion des villes : français, arabe, casse et variantes (« Rdayef ») forment UNE ligne, affichée avec le nom officiel", () => {
  const n = buildNetwork([
    row({ line_from: "Redeyef" }), row({ line_from: "redeyef" }), row({ line_from: "الرديف" }), row({ line_from: "Rdayef", status: "approved" }),
    row({ line_from: "Bab Alioua" }), row({ line_from: "bab alioua" }),
  ]);
  const regional = n.find((g) => g.governorate === "Gafsa").regional;
  assert.equal(regional.length, 2, "Redeyef ×4 et Bab Alioua ×2 (non reconnue mais orthographes fusionnées)");
  assert.deepEqual(regional[0], { type: "regional", from: "Redeyef", from_ar: "الرديف", recognized: true, to_gov: "Gafsa", drivers: 4, approved: 1, via: [], pickup: 0, partial: 0 });
  assert.deepEqual([regional[1].from, regional[1].from_ar, regional[1].recognized, regional[1].drivers], ["Bab Alioua", null, false, 2]);
});

test("une ville n'est reconnue que dans le bon gouvernorat : « Nefta » à Gafsa n'est pas Nefta de Tozeur, mais reste fusionnée avec elle-même", () => {
  const n = buildNetwork([row({ line_from: "Nefta" }), row({ line_from: "nefta" }), row({ governorate: "Tozeur", line_to_gov: "Tozeur", line_from: "نفطة" })]);
  const gafsa = n.find((g) => g.governorate === "Gafsa").regional;
  assert.deepEqual([gafsa.length, gafsa[0].drivers, gafsa[0].recognized], [1, 2, false]);
  const tozeur = n.find((g) => g.governorate === "Tozeur").regional;
  assert.deepEqual([tozeur[0].from, tozeur[0].from_ar, tozeur[0].recognized], ["Nefta", "نفطة", true]);
});

test("arrêts en route : reconnus dans le gouvernorat de départ, d'arrivée, ou ailleurs si le nom est unique dans le pays", () => {
  const n = buildNetwork([
    row({ governorate: "Tunis", line_type: "interregional", line_from: "Tunis", line_to_gov: "Sousse", line_via: JSON.stringify(["Enfidha", "الحمامات", "Zarzis"]) }),
  ]);
  const via = n.find((g) => g.governorate === "Tunis").interregional[0].via.map((v) => [v.city, v.recognized]);
  assert.deepEqual(via.sort(), [["Enfidha", true], ["Hammamet", true], ["Zarzis", true]]);
});

test("networkCsv : nom arabe et « reconnue » ajoutés en fin de ligne", () => {
  const csv = networkCsv(buildNetwork([row({ line_from: "الرديف" }), row({ line_from: "Bab Alioua" })]));
  assert.match(csv, /ville_depart_ar,ville_reconnue/);
  assert.ok(csv.includes("Gafsa,regional,Redeyef,Gafsa,1,0,,0,0,الرديف,oui"));
  assert.ok(csv.includes("Gafsa,regional,Bab Alioua,Gafsa,1,0,,0,0,,non"));
});
