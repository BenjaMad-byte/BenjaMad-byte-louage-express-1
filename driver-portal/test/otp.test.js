import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stubSms, makeClock, postJson } from "./_helpers.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-otp-"));
process.env.DATA_DIR = dataDir;
const sms = stubSms();
const clock = makeClock();
let server, base, db;

before(async () => {
  const { createApp } = await import("../server.js");
  ({ db } = await import("../db.js"));
  server = createApp({ adminToken: "test-token-otp-1234", rateLimits: false, sms, now: clock.now }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const send = (phone, lang = "ar") => postJson(base, "/api/otp/send", { phone, lang });
const verify = (phone, code) => postJson(base, "/api/otp/verify", { phone, code });
const lastCode = () => sms.sent.at(-1).code;

test("envoi : SMS au bon numéro (+216 ajouté par le fournisseur), langue respectée, code à 6 chiffres", async () => {
  const res = await send("98 123 456", "fr");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, retry_after: 60 });
  assert.equal(sms.sent.at(-1).phone, "98123456");
  assert.match(sms.sent.at(-1).text, /^Louage Express : votre code est \d{6}/);
  clock.advance(61_000);
  await send("98123456", "ar");
  assert.match(sms.sent.at(-1).text, /رمز التحقق \d{6}/);
});

test("numéro non tunisien ou invalide → 400 et aucun SMS envoyé", async () => {
  const before = sms.sent.length;
  for (const phone of ["+33612345678", "12345678", "", "abc", undefined]) {
    assert.equal((await send(phone)).status, 400, String(phone));
  }
  assert.equal(sms.sent.length, before);
});

test("délai minimum de 60 s entre deux envois au même numéro", async () => {
  await send("55000111");
  const again = await send("55000111");
  assert.equal(again.status, 429);
  const body = await again.json();
  assert.equal(body.error, "otp_cooldown");
  assert.ok(body.retry_after > 0 && body.retry_after <= 60);
  clock.advance(61_000);
  assert.equal((await send("55000111")).status, 200);
});

test("3 envois par heure et par numéro, puis blocage jusqu'à l'heure suivante", async () => {
  const phone = "55000222";
  for (let i = 0; i < 3; i++) {
    clock.advance(61_000);
    assert.equal((await send(phone)).status, 200, `envoi ${i + 1}`);
  }
  clock.advance(61_000);
  const blocked = await send(phone);
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error, "otp_limit");
  clock.advance(3_600_000);
  assert.equal((await send(phone)).status, 200);
});

test("mauvais code : 5 essais puis verrouillage, même avec le bon code ; un nouvel envoi débloque", async () => {
  const phone = "55000333";
  clock.advance(61_000);
  await send(phone);
  const good = lastCode();
  const wrong = good === "000000" ? "111111" : "000000";
  let r = await verify(phone, wrong);
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "otp_invalid", attempts_left: 4 });
  for (let i = 0; i < 3; i++) await verify(phone, wrong);
  r = await verify(phone, wrong); // 5e échec
  assert.equal((await r.json()).error, "otp_locked");
  assert.equal((await (await verify(phone, good)).json()).error, "otp_locked");
  clock.advance(61_000);
  await send(phone);
  assert.equal((await verify(phone, lastCode())).status, 200);
});

test("code expiré après 5 minutes", async () => {
  const phone = "55000444";
  clock.advance(61_000);
  await send(phone);
  const code = lastCode();
  clock.advance(5 * 60_000 + 1000);
  assert.equal((await (await verify(phone, code)).json()).error, "otp_expired");
});

test("vérifier sans avoir demandé de code, ou avec un format invalide → otp_invalid", async () => {
  assert.equal((await (await verify("55000555", "123456")).json()).error, "otp_invalid");
  clock.advance(61_000);
  await send("55000555");
  for (const code of ["12345", "1234567", "abcdef", "", null]) {
    assert.equal((await (await verify("55000555", code)).json()).error, "otp_invalid", String(code));
  }
});

test("succès : jeton retourné, code à usage unique, rien de sensible stocké en clair", async () => {
  const phone = "55000666";
  clock.advance(61_000);
  await send(phone);
  const code = lastCode();
  const ok = await verify(phone, code);
  assert.equal(ok.status, 200);
  const { token, expires_in } = await ok.json();
  assert.ok(token.length >= 40);
  assert.equal(expires_in, 1800);
  assert.equal((await (await verify(phone, code)).json()).error, "otp_invalid", "le code ne sert qu'une fois");

  const dump = JSON.stringify([db.prepare("SELECT * FROM otp_codes").all(), db.prepare("SELECT * FROM phone_verifications").all(), db.prepare("SELECT * FROM otp_sends").all()]);
  assert.ok(!dump.includes(token), "jeton non stocké en clair");
  assert.ok(!dump.includes(`"${code}"`), "code non stocké en clair");
});

test("échec du fournisseur SMS → 503, et l'utilisateur peut réessayer immédiatement (quota non consommé)", async () => {
  const phone = "55000777";
  clock.advance(61_000);
  sms.failing = true;
  const res = await send(phone);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "sms_failed");
  sms.failing = false;
  assert.equal((await send(phone)).status, 200, "pas de délai d'attente après un échec d'envoi");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM otp_sends WHERE phone = ?").get(phone).n, 1);
});
