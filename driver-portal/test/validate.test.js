import { test } from "node:test";
import assert from "node:assert/strict";
import { latinDigits, normalizePhone, normalizeCin, normalizeRef, newRef, sniffMime, validateApplication } from "../validate.js";
import { listSlots } from "../slots.js";

test("normalizePhone accepte les formats tunisiens courants", () => {
  assert.equal(normalizePhone("98 123 456"), "98123456");
  assert.equal(normalizePhone("+216 98123456"), "98123456");
  assert.equal(normalizePhone("0021655123456"), "55123456");
  assert.equal(normalizePhone("98-123-456"), "98123456");
});

test("normalizePhone refuse les numéros invalides", () => {
  assert.equal(normalizePhone("12345678"), null); // préfixe 1 inexistant
  assert.equal(normalizePhone("9812345"), null);
  assert.equal(normalizePhone("981234567"), null);
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(undefined), null);
});

test("normalizeCin exige exactement 8 chiffres", () => {
  assert.equal(normalizeCin("01234567"), "01234567");
  assert.equal(normalizeCin("0123 4567"), "01234567");
  assert.equal(normalizeCin("1234567"), null);
  assert.equal(normalizeCin("0123456a"), null);
});

test("newRef produit une référence valide et unique", () => {
  const refs = new Set(Array.from({ length: 200 }, newRef));
  assert.equal(refs.size, 200);
  for (const r of refs) assert.equal(normalizeRef(r), r);
  assert.equal(normalizeRef("lx-abcdefgh"), "LX-ABCDEFGH"); // insensible à la casse
  assert.equal(normalizeRef("LX-ABCDEFG1"), null); // 0, 1, O, I exclus de l'alphabet
  assert.equal(normalizeRef("LX-ABCDEF"), null);
});

test("sniffMime lit la signature binaire, pas l'extension", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);
  const pdf = Buffer.from("%PDF-1.7\n1 0 obj");
  assert.equal(sniffMime(png), "image/png");
  assert.equal(sniffMime(jpg), "image/jpeg");
  assert.equal(sniffMime(pdf), "application/pdf");
  assert.equal(sniffMime(Buffer.from("<script>alert(1)</script>")), null);
  assert.equal(sniffMime(Buffer.alloc(4)), null);
});

const valid = {
  full_name: "Ali Ben Salah", phone: "98 123 456", cin: "01234567", role: "driver", plate: "123 tun 4567",
  governorate: "Tunis", station: "Bab Alioua", line_type: "interregional", line_from: "Bab Alioua", line_to_gov: "Sousse", consent: "true", consent_biometric: "true", lang: "fr",
};

test("validateApplication normalise et accepte un dossier valide", () => {
  const r = validateApplication(valid);
  assert.equal(r.ok, true);
  assert.equal(r.values.phone, "98123456");
  assert.equal(r.values.plate, "123 TUN 4567");
});

test("validateApplication remonte un code d'erreur par champ", () => {
  const r = validateApplication({ ...valid, phone: "1", cin: "x", role: "boss", governorate: "Paris", consent: "" });
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.errors).sort(), ["cin", "consent", "governorate", "phone", "role"]);
  assert.equal(validateApplication({ ...valid, consent_biometric: "" }).errors.consent_biometric, "consent_required");
});

test("validateApplication neutralise les caractères de contrôle", () => {
  const r = validateApplication({ ...valid, full_name: "Ali\u0000\n\tBen   Salah" });
  assert.equal(r.values.full_name, "Ali Ben Salah");
});

test("listSlots : pas de dimanche, préavis respecté, créneaux pris exclus", () => {
  const now = new Date("2026-10-06T08:00:00Z"); // mardi 09:00 à Tunis
  const slots = listSlots(new Set(), now);
  assert.ok(slots.length > 0);
  assert.ok(slots.every((s) => new Date(s).getTime() >= now.getTime() + 120 * 60000), "préavis de 2 h");
  assert.ok(slots.every((s) => new Date(`${s.slice(0, 10)}T12:00:00Z`).getUTCDay() !== 0), "jamais le dimanche");
  assert.ok(slots.every((s) => /T(09|1[0-6]):(00|30):00\+01:00$/.test(s)), "09:00 à 16:30");
  const taken = new Set([slots[0]]);
  assert.ok(!listSlots(taken, now).includes(slots[0]));
});

test("les chiffres indo-arabes d'un clavier arabe sont acceptés (téléphone, CIN, code)", () => {
  assert.equal(latinDigits("٩٨١٢٣٤٥٦"), "98123456");
  assert.equal(latinDigits("۹۸۱۲۳۴۵۶"), "98123456");
  assert.equal(normalizePhone("٩٨ ١٢٣ ٤٥٦"), "98123456");
  assert.equal(normalizeCin("٠١٢٣٤٥٦٧"), "01234567");
  assert.equal(normalizePhone("+٢١٦٩٨١٢٣٤٥٦"), "98123456", "le préfixe +216 est reconnu aussi en chiffres indo-arabes");
});

test("circuit : le champ ligne est dérivé de « ville de départ → gouvernorat d'arrivée »", () => {
  const r = validateApplication(valid);
  assert.equal(r.ok, true);
  assert.equal(r.values.route, "Bab Alioua → Sousse");
});

test("circuit régional : l'arrivée doit rester dans le gouvernorat de la station", () => {
  const ok = validateApplication({ ...valid, governorate: "Gafsa", line_type: "regional", line_from: "Redeyef", line_to_gov: "Gafsa" });
  assert.equal(ok.ok, true);
  assert.equal(ok.values.route, "Redeyef → Gafsa");
  const bad = validateApplication({ ...valid, governorate: "Gafsa", line_type: "regional", line_from: "Redeyef", line_to_gov: "Tunis" });
  assert.equal(bad.errors.line_to_gov, "line_regional_same_gov");
});

test("circuit interrégional : l'arrivée doit être un autre gouvernorat", () => {
  const bad = validateApplication({ ...valid, governorate: "Sousse", line_type: "interregional", line_from: "Sousse", line_to_gov: "Sousse" });
  assert.equal(bad.errors.line_to_gov, "line_interregional_other_gov");
});

test("circuit : type, ville et gouvernorat d'arrivée sont obligatoires et contrôlés", () => {
  const r = validateApplication({ ...valid, line_type: "mondial", line_from: "x", line_to_gov: "Paris" });
  assert.equal(r.errors.line_type, "invalid_line_type");
  assert.equal(r.errors.line_from, "invalid_line_from");
  assert.equal(r.errors.line_to_gov, "invalid_line_to_gov");
  assert.equal(validateApplication({ ...valid, line_type: undefined, line_from: undefined, line_to_gov: undefined }).ok, false);
});

test("arrêts en route : liste nettoyée, doublons et ville de départ ignorés", () => {
  const r = validateApplication({ ...valid, governorate: "Gafsa", line_type: "regional", line_from: "Redeyef", line_to_gov: "Gafsa", line_via: "Oum Larayes، Métlaoui; oum larayes, redeyef", pickup_en_route: "true" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.values.line_via, ["Oum Larayes", "Métlaoui"]);
  assert.equal(r.values.pickup_en_route, true);
  assert.equal(r.values.route, "Redeyef → Gafsa (via Oum El Araies, Metlaoui)", "la ligne affichée utilise les noms officiels");
});

test("arrêts en route : « je prends des passagers en route » exige au moins une ville, et 5 arrêts maximum", () => {
  const base = { ...valid, governorate: "Gafsa", line_type: "regional", line_from: "Redeyef", line_to_gov: "Gafsa" };
  assert.equal(validateApplication({ ...base, pickup_en_route: "true" }).errors.line_via, "line_via_required");
  assert.equal(validateApplication({ ...base, line_via: "a1,b2,c3,d4,e5,f6" }).errors.line_via, "line_via_too_many");
  assert.equal(validateApplication({ ...base, line_via: "x" }).errors.line_via, "invalid_line_via");
  const none = validateApplication({ ...base, leaves_partial: "true" });
  assert.equal(none.ok, true, "partir incomplet ne demande pas d'arrêt");
  assert.deepEqual(none.values.line_via, []);
  assert.equal(none.values.leaves_partial, true);
});

test("louage national : pas de gouvernorat d'arrivée, seule la ville de départ habituelle est requise", () => {
  const r = validateApplication({ ...valid, governorate: "Médenine", line_type: "national", line_from: "Médenine", line_to_gov: "Paris" });
  assert.equal(r.ok, true, "l'arrivée est ignorée pour un louage national");
  assert.equal(r.values.line_to_gov, "");
  assert.equal(r.values.route, "Médenine → tous les gouvernorats");
  assert.equal(validateApplication({ ...valid, line_type: "national", line_from: "x" }).errors.line_from, "invalid_line_from");
});

test("circuit rural : comme le régional, l'arrivée reste dans le gouvernorat de la station", () => {
  const ok = validateApplication({ ...valid, governorate: "Médenine", line_type: "rural", line_from: "Jelal", line_to_gov: "Médenine" });
  assert.equal(ok.ok, true);
  assert.equal(ok.values.route, "Jelal → Médenine");
  const bad = validateApplication({ ...valid, governorate: "Médenine", line_type: "rural", line_from: "Jelal", line_to_gov: "Tunis" });
  assert.equal(bad.errors.line_to_gov, "line_rural_same_gov");
});

test("profil : toujours « chauffeur » ; sans champ role c'est accepté, un autre profil est refusé", () => {
  const { role, ...noRole } = { ...valid, role: undefined };
  assert.equal(validateApplication(noRole).ok, true);
  assert.equal(validateApplication(noRole).values.role, "driver");
  assert.equal(validateApplication({ ...valid, role: "driver" }).ok, true);
  assert.equal(validateApplication({ ...valid, role: "owner" }).errors.role, "invalid_role");
});

test("ligne affichée : les villes saisies en arabe ou en variante sont ramenées au nom officiel ; la saisie brute est conservée", () => {
  const r = validateApplication({ ...valid, governorate: "Gafsa", line_type: "regional", line_from: "الرديف", line_to_gov: "Gafsa", line_via: "أم العرائس، Oum Larayes, المتلوي, Villeinconnue" });
  assert.equal(r.ok, true);
  assert.equal(r.values.route, "Redeyef → Gafsa (via Oum El Araies, Metlaoui, Villeinconnue)", "doublon arabe/variante fusionné, ville inconnue conservée telle quelle");
  assert.equal(r.values.line_from, "الرديف", "la valeur enregistrée reste ce que le chauffeur a écrit");
  assert.deepEqual(r.values.line_via, ["أم العرائس", "Oum Larayes", "المتلوي", "Villeinconnue"]);
  const same = validateApplication({ ...valid, governorate: "Gafsa", line_type: "regional", line_from: "Redeyef", line_to_gov: "Gafsa", line_via: "الرديف, Metlaoui" });
  assert.equal(same.values.route, "Redeyef → Gafsa (via Metlaoui)", "un arrêt identique à la ville de départ (même en arabe) est ignoré");
});
