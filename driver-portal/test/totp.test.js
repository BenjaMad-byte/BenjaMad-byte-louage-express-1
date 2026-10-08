import { test } from "node:test";
import assert from "node:assert/strict";
import { base32Encode, base32Decode, generateSecret, hotp, verifyTotp, stepOf, otpauthUri } from "../totp.js";

const RFC_SECRET = Buffer.from("12345678901234567890"); // clé de test de la RFC 6238 (SHA-1)

test("RFC 4226 : vecteurs officiels HOTP (6 chiffres)", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  expected.forEach((code, counter) => assert.equal(hotp(RFC_SECRET, counter), code, `compteur ${counter}`));
});

test("RFC 6238 : vecteurs officiels TOTP (les 6 derniers chiffres des valeurs à 8 chiffres)", () => {
  for (const [seconds, code] of [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"]]) {
    assert.equal(hotp(RFC_SECRET, stepOf(seconds * 1000)), code, `t = ${seconds}`);
  }
});

test("base32 : aller-retour, saisie tolérante (espaces, tirets, minuscules, remplissage), refus des caractères invalides", () => {
  assert.equal(base32Encode(RFC_SECRET), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"), RFC_SECRET);
  assert.deepEqual(base32Decode("gezd gnbv-gy3t qojq GEZDGNBVGY3TQOJQ"), RFC_SECRET);
  const random = generateSecret();
  assert.equal(random.length, 20);
  assert.deepEqual(base32Decode(base32Encode(random)), random);
  assert.notDeepEqual(generateSecret(), generateSecret());
  for (const bad of ["", "1", "ABC!", "0189"]) assert.throws(() => base32Decode(bad), /base32/);
});

test("verifyTotp : code courant accepté, tolérance d'un pas, rien au-delà, mauvais format refusé", () => {
  const now = 1_700_000_000_000;
  const step = stepOf(now);
  assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step), now), step);
  assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now), step - 1, "pas précédent (horloge en retard)");
  assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now), step + 1, "pas suivant (horloge en avance)");
  assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now), null, "trop ancien");
  assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), now), null, "trop en avance");
  assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step).replace(/./, (d) => String((Number(d) + 1) % 10)), now), null);
  for (const bad of ["", "12345", "1234567", "abcdef", null, undefined]) assert.equal(verifyTotp(RFC_SECRET, bad, now), null);
  assert.equal(verifyTotp(RFC_SECRET, ` ${hotp(RFC_SECRET, step).slice(0, 3)} ${hotp(RFC_SECRET, step).slice(3)} `, now), step, "espaces tolérés (affichage « 123 456 »)");
});

test("verifyTotp : un code ne sert qu'une fois (lastStep), même rejoué dans la fenêtre de tolérance", () => {
  const now = 1_700_000_000_000;
  const step = stepOf(now);
  const code = hotp(RFC_SECRET, step);
  const first = verifyTotp(RFC_SECRET, code, now);
  assert.equal(first, step);
  assert.equal(verifyTotp(RFC_SECRET, code, now, { lastStep: first }), null, "rejeu refusé");
  assert.equal(verifyTotp(RFC_SECRET, code, now + 30_000, { lastStep: first }), null, "rejeu refusé au pas suivant");
  assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now, { lastStep: first }), null, "un code plus ancien que le dernier accepté est refusé");
  assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, { lastStep: first }), step + 1, "le pas suivant reste accepté");
});

test("otpauthUri : format attendu par les applications d'authentification", () => {
  const uri = otpauthUri({ secret: RFC_SECRET, account: "alice@exemple", issuer: "Louage Express" });
  assert.equal(uri, "otpauth://totp/Louage%20Express:alice%40exemple?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Louage%20Express&algorithm=SHA1&digits=6&period=30");
});
