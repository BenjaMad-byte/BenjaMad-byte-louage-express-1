import { test } from "node:test";
import assert from "node:assert/strict";
import { matchKey, createPlaceIndex } from "../public/places.js";

test("clé de comparaison : majuscules, accents, tirets, articles et voyelles brèves ne comptent pas", () => {
  assert.equal(matchKey("Redeyef"), matchKey("  redeyef "));
  assert.equal(matchKey("Métlaoui"), matchKey("metlaoui"));
  assert.equal(matchKey("El Guettar"), matchKey("Guettar"), "l'article « El » est ignoré");
  assert.equal(matchKey("Sidi-Bou  Zid"), matchKey("sidi bou zid"));
  assert.equal(matchKey("M'saken"), matchKey("m saken"));
  assert.equal(matchKey("الرَّديف"), matchKey("الرديف"), "voyelles brèves arabes ignorées");
  assert.equal(matchKey("الرديف"), matchKey("رديف"), "article « ال » ignoré");
  assert.equal(matchKey("أريانة"), matchKey("اريانة"), "alef avec ou sans hamza");
  assert.equal(matchKey("المنستير"), matchKey("المنستير"));
  assert.equal(matchKey("قفصة"), matchKey("قفصه"), "ta marbuta / ha");
  assert.equal(matchKey("الكاف"), matchKey("كاف"));
  assert.notEqual(matchKey("Gafsa"), matchKey("Gabès"));
  assert.equal(matchKey(""), "");
  assert.equal(matchKey(null), "");
  assert.equal(matchKey("   "), "");
});

const DATA = {
  Gafsa: [["Gafsa", "قفصة"], ["Redeyef", "الرديف"], ["Oum El Araies", "أم العرائس"], ["Metlaoui", "المتلوي"]],
  Tozeur: [["Tozeur", "توزر"], ["Nefta", "نفطة"]],
  Sousse: [["Sousse", "سوسة"], ["Sidi El Hani", "سيدي الهاني"]],
  Mahdia: [["El Jem", "الجم"]],
  Monastir: [["Sidi El Hani", "سيدي الهاني"]], // même nom dans deux gouvernorats : ambigu hors contexte
};
const ALIASES = { "Oum El Araies": ["Oum Larayes", "Om Larayes", "أم لعرايس"] };
const idx = createPlaceIndex(DATA, ALIASES);

test("recherche dans un gouvernorat : français, arabe, variantes et alias donnent la même ville", () => {
  for (const typed of ["Redeyef", "redeyef", "REDEYEF", "الرديف", "رديف", "الرَّديف"]) {
    assert.deepEqual(idx.find(typed, ["Gafsa"]), { fr: "Redeyef", ar: "الرديف", governorate: "Gafsa" }, typed);
  }
  for (const typed of ["Oum El Araies", "Oum Larayes", "om larayes", "أم العرائس", "أم لعرايس"]) {
    assert.equal(idx.find(typed, ["Gafsa"])?.fr, "Oum El Araies", typed);
  }
  assert.equal(idx.find("Nefta", ["Gafsa"]), null, "pas dans ce gouvernorat");
  assert.equal(idx.find("Nefta", ["Gafsa", "Tozeur"])?.fr, "Nefta", "plusieurs gouvernorats cherchés (départ + arrivée)");
  assert.equal(idx.find("Villeinconnue", ["Gafsa"]), null);
  assert.equal(idx.find("", ["Gafsa"]), null);
});

test("hors contexte : une ville unique est trouvée dans tout le pays ; un nom partagé par deux gouvernorats reste ambigu", () => {
  assert.equal(idx.find("El Jem")?.governorate, "Mahdia");
  assert.equal(idx.find("Jem")?.fr, "El Jem");
  assert.equal(idx.find("Sidi El Hani"), null, "ambigu : on ne devine pas");
  assert.equal(idx.find("Sidi El Hani", ["Sousse"])?.governorate, "Sousse", "le contexte lève l'ambiguïté");
  assert.equal(idx.find("Sidi El Hani", ["Monastir"])?.governorate, "Monastir");
});

test("suggestions : dans la langue de l'interface, le chef-lieu d'abord, sans doublon", () => {
  assert.deepEqual(idx.suggestions("Gafsa", "fr"), ["Gafsa", "Metlaoui", "Oum El Araies", "Redeyef"]);
  assert.deepEqual(idx.suggestions("Gafsa", "ar"), ["قفصة", "الرديف", "المتلوي", "أم العرائس"].sort((a, b) => (a === "قفصة" ? -1 : b === "قفصة" ? 1 : a.localeCompare(b, "ar"))));
  assert.equal(idx.suggestions("Gafsa", "ar")[0], "قفصة");
  assert.deepEqual(idx.suggestions("Narnia", "fr"), []);
  assert.deepEqual(idx.suggestions("", "fr"), []);
});

test("all() : toutes les délégations du pays, avec leur gouvernorat, triées", () => {
  const all = idx.all();
  assert.equal(all.length, 10, "une entrée par ville, tous gouvernorats confondus");
  assert.deepEqual(all.find((p) => p.fr === "Redeyef"), { fr: "Redeyef", ar: "الرديف", governorate: "Gafsa" });
  const names = all.map((p) => p.fr);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "fr")), "triée alphabétiquement");
  assert.equal(all.filter((p) => p.fr === "Sidi El Hani").length, 2, "même nom dans deux gouvernorats : les deux apparaissent");
});

test("alias : ne peuvent pas faire fusionner deux villes différentes", () => {
  assert.throws(() => createPlaceIndex({ Gafsa: [["Redeyef", "الرديف"], ["Metlaoui", "المتلوي"]] }, { Metlaoui: ["Redeyef"] }), /alias.*Redeyef/i);
  assert.throws(() => createPlaceIndex({ Gafsa: [["Redeyef", "الرديف"], ["Redeyef", "الرديف"]] }, {}), /doublon/i);
});
