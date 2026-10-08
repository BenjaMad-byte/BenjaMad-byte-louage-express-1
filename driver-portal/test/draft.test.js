import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDraft, readDraft, buildOtpState, readOtpState, DRAFT_TTL_MS, DRAFT_FIELDS } from "../public/draft.js";

const NOW = Date.UTC(2026, 9, 7, 10, 0, 0);
const full = {
  full_name: "Ali Ben Salah", phone: "98123456", plate: "123 TUN 4567", governorate: "Gafsa", station: "Gare de Redeyef",
  line_type: "regional", line_from: "Redeyef", line_to_gov: "Gafsa", line_via: "Oum Larayes, Métlaoui", pickup_en_route: true, leaves_partial: false,
};

test("brouillon : seuls les champs prévus sont gardés — jamais la CIN, les consentements, les photos ni le code SMS", () => {
  const draft = buildDraft(
    { ...full, cin: "01234567", consent: true, consent_biometric: true, otp_code: "654321", otp_token: "secret-token-xyz", cin_front: "photo", selfie_1: "photo" },
    NOW
  );
  assert.deepEqual(Object.keys(draft.fields).sort(), [...DRAFT_FIELDS].sort());
  const dump = JSON.stringify(draft);
  for (const forbidden of ["01234567", "consent", "654321", "secret-token-xyz", "photo", "cin"]) assert.ok(!dump.includes(forbidden), `« ${forbidden} » ne doit pas être enregistré`);
  assert.equal(draft.savedAt, NOW);
  assert.equal(draft.v, 1);
});

test("brouillon vide : rien n'est enregistré (on ne crée pas de brouillon à partir de rien)", () => {
  assert.equal(buildDraft({}, NOW), null);
  assert.equal(buildDraft({ full_name: "   ", phone: "", governorate: "", pickup_en_route: false }, NOW), null);
  assert.notEqual(buildDraft({ pickup_en_route: true }, NOW), null, "une case cochée est déjà une saisie");
  assert.notEqual(buildDraft({ full_name: "Ali" }, NOW), null);
});

test("lecture : aller-retour exact, avec la date d'enregistrement", () => {
  const raw = JSON.stringify(buildDraft(full, NOW));
  const read = readDraft(raw, NOW + 60_000);
  assert.deepEqual(read.fields, full);
  assert.equal(read.savedAt, NOW);
});

test("lecture : un brouillon périmé (plus de 3 jours), d'une autre version, illisible ou absent est ignoré", () => {
  const raw = JSON.stringify(buildDraft(full, NOW));
  assert.notEqual(readDraft(raw, NOW + DRAFT_TTL_MS - 1000), null);
  assert.equal(readDraft(raw, NOW + DRAFT_TTL_MS + 1000), null, "périmé");
  assert.equal(readDraft(JSON.stringify({ ...JSON.parse(raw), v: 2 }), NOW), null, "version inconnue");
  assert.equal(readDraft(JSON.stringify({ ...JSON.parse(raw), savedAt: NOW + 10 * 60_000 }), NOW), null, "date dans le futur : suspect");
  for (const bad of [null, undefined, "", "pas du json", "[]", "null", "42", '{"v":1}', '{"v":1,"savedAt":"hier","fields":{}}']) assert.equal(readDraft(bad, NOW), null, String(bad));
});

test("lecture : données hostiles ou corrompues — types forcés, longueurs coupées, champs inconnus retirés", () => {
  const hostile = JSON.stringify({
    v: 1, savedAt: NOW,
    fields: {
      full_name: "A".repeat(500), phone: { $ne: 1 }, plate: 12345, governorate: ["Gafsa"], station: "<script>alert(1)</script>",
      line_type: "cargo", line_from: "x".repeat(200), line_to_gov: null, line_via: "v".repeat(1000),
      pickup_en_route: "true", leaves_partial: 1, cin: "01234567", __proto__: { polluted: true }, constructor: "x",
    },
  });
  const read = readDraft(hostile, NOW);
  assert.ok(read, "un brouillon partiellement abîmé reste utilisable");
  const f = read.fields;
  assert.equal(f.full_name.length, 80);
  assert.equal(f.line_from.length, 60);
  assert.equal(f.line_via.length, 200);
  assert.equal(f.phone, undefined);
  assert.equal(f.plate, undefined);
  assert.equal(f.governorate, undefined);
  assert.equal(f.line_type, undefined, "type de ligne inconnu écarté");
  assert.equal(f.station, "<script>alert(1)</script>", "le texte est conservé tel quel : il n'est JAMAIS interprété comme du HTML (champ de saisie)");
  assert.equal(f.pickup_en_route, undefined);
  assert.equal(f.leaves_partial, undefined);
  assert.ok(!Object.hasOwn(f, "cin") && !Object.hasOwn(f, "constructor") && !Object.hasOwn(f, "polluted") && ({}).polluted === undefined);
});

test("vérification du téléphone : gardée pour l'onglet courant seulement, avec expiration, liée au numéro", () => {
  const state = buildOtpState({ token: "t".repeat(43), phone: "98123456", expiresInSeconds: 1800 }, NOW);
  assert.ok(state.expiresAt < NOW + 1800 * 1000, "marge de sécurité : on considère le jeton expiré un peu avant le serveur");
  const raw = JSON.stringify(state);
  assert.deepEqual(readOtpState(raw, NOW + 60_000), { token: "t".repeat(43), phone: "98123456" });
  assert.equal(readOtpState(raw, NOW + 1800 * 1000), null, "expiré");
  for (const bad of [null, "", "{}", "pas du json", JSON.stringify({ token: "court", phone: "98123456", expiresAt: NOW + 1e6 }), JSON.stringify({ token: "t".repeat(43), phone: "123", expiresAt: NOW + 1e6 }), JSON.stringify({ token: 42, phone: "98123456", expiresAt: NOW + 1e6 })]) {
    assert.equal(readOtpState(bad, NOW), null, String(bad));
  }
  assert.equal(buildOtpState({ token: "", phone: "98123456", expiresInSeconds: 1800 }, NOW), null);
});
