import { test } from "node:test";
import assert from "node:assert/strict";
import { PLACES, ALIASES } from "../public/places-data.js";
import { places, matchKey } from "../public/places.js";
import { GOVERNORATES } from "../validate.js";
import { GOVERNORATES_AR } from "../public/i18n.js";

// Nombre officiel de délégations par gouvernorat (264 en tout) : filet contre une régénération qui perdrait ou doublerait des villes.
const OFFICIAL = { Ariana: 7, Béja: 9, "Ben Arous": 12, Bizerte: 14, Gabès: 10, Gafsa: 11, Jendouba: 9, Kairouan: 11, Kasserine: 13, Kébili: 6, "Le Kef": 11, Mahdia: 11, "La Manouba": 8, Médenine: 9, Monastir: 13, Nabeul: 16, Sfax: 16, "Sidi Bouzid": 12, Siliana: 11, Sousse: 16, Tataouine: 7, Tozeur: 5, Tunis: 21, Zaghouan: 6 };

test("les 24 gouvernorats du formulaire, ni plus ni moins, avec une liste de villes chacun", () => {
  assert.deepEqual(Object.keys(PLACES), GOVERNORATES);
  assert.equal(Object.values(OFFICIAL).reduce((a, b) => a + b, 0), 264);
  for (const g of GOVERNORATES) assert.ok(PLACES[g].length >= OFFICIAL[g], `${g} : liste trop courte`);
});

test("chaque gouvernorat contient toutes ses délégations officielles (+ au plus un chef-lieu ajouté)", () => {
  for (const g of GOVERNORATES) {
    const n = PLACES[g].length;
    assert.ok(n === OFFICIAL[g] || n === OFFICIAL[g] + 1, `${g} : ${n} villes pour ${OFFICIAL[g]} délégations`);
  }
});

test("noms propres : arabe en lettres arabes, aucun préfixe « Délégation », aucun caractère invisible, aucun doublon", () => {
  const invisible = /[​-‏‪-‮⁦-⁩﻿]/;
  for (const [gov, list] of Object.entries(PLACES)) {
    const keys = new Set();
    for (const [fr, ar] of list) {
      assert.ok(fr && ar, `${gov} : nom vide`);
      assert.ok(!/^délégation/i.test(fr) && !/^معتمدية/.test(ar) && !/^(de|d')\s/i.test(fr), `${gov} / ${fr} : préfixe de délégation conservé`);
      assert.ok(!invisible.test(fr) && !invisible.test(ar), `${gov} / ${fr} : caractère invisible`);
      assert.ok(/[؀-ۿ]/.test(ar), `${gov} / ${fr} : nom arabe sans lettres arabes (${ar})`);
      assert.ok(!/ا ال|اا/.test(ar), `${gov} / ${ar} : coquille probable`);
      assert.equal(fr, fr.trim());
      assert.ok(!keys.has(matchKey(fr)), `${gov} : « ${fr} » en double`);
      keys.add(matchKey(fr));
    }
  }
});

test("le chef-lieu d'un gouvernorat est proposé en premier, dans les deux langues", () => {
  GOVERNORATES.forEach((gov, i) => {
    assert.equal(matchKey(places.suggestions(gov, "fr")[0]), matchKey(gov), `${gov} (français)`);
    assert.equal(matchKey(places.suggestions(gov, "ar")[0]), matchKey(GOVERNORATES_AR[i]), `${gov} (arabe)`);
  });
});

test("cas du projet : Redeyef, Oum Larayes et Métlaoui à Gafsa, dans toutes leurs écritures", () => {
  for (const typed of ["Redeyef", "redeyef", "الرديف", "رديف", "Rdayef"]) assert.equal(places.find(typed, ["Gafsa"])?.fr, "Redeyef", typed);
  for (const typed of ["Oum El Araies", "Oum Larayes", "om larayes", "أم العرائس"]) assert.equal(places.find(typed, ["Gafsa"])?.fr, "Oum El Araies", typed);
  for (const typed of ["Metlaoui", "Métlaoui", "المتلوي"]) assert.equal(places.find(typed, ["Gafsa"])?.fr, "Metlaoui", typed);
  assert.equal(places.find("Tozeur", ["Tozeur"])?.ar, "توزر");
  assert.equal(places.find("Ben Gardane", ["Médenine"])?.governorate, "Médenine", "Ben Gardane est à Médenine (et non à Tataouine)");
  assert.equal(places.find("Ben Gardane", ["Tataouine"]), null);
});

test("alias : chacun pointe vers une ville qui existe", () => {
  const all = new Set(Object.values(PLACES).flat().map(([fr]) => fr));
  for (const fr of Object.keys(ALIASES)) assert.ok(all.has(fr), `alias pour une ville inconnue : ${fr}`);
});

test("variantes courantes : trouvées dans leur gouvernorat", () => {
  for (const [gov, typed, fr] of [["Sousse", "Sidi El Hani", "Sidi El Heni"], ["Gafsa", "El Guettar", "El Guetar"], ["Gafsa", "Mdhilla", "Mdhila"], ["Béja", "Thibar", "Tibar"], ["Gabès", "Ghannouch", "Ghanouch"], ["Médenine", "Beni Khedache", "Beni Khedech"], ["Mahdia", "Ksour Essaf", "Ksour Essef"], ["Ariana", "Sidi Thabet", "Sidi Thabet"]]) {
    assert.equal(places.find(typed, [gov])?.fr, fr, `${typed} (${gov})`);
  }
});
