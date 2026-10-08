import { test } from "node:test";
import assert from "node:assert/strict";
import { createSmsProvider, otpMessage } from "../sms.js";

test("le fournisseur console est refusé en production", () => {
  assert.throws(() => createSmsProvider({ NODE_ENV: "production" }), /interdit en production/);
  assert.throws(() => createSmsProvider({ NODE_ENV: "production", SMS_PROVIDER: "console" }), /interdit en production/);
  assert.equal(createSmsProvider({}).name, "console");
});

test("fournisseur inconnu ou Twilio mal configuré → erreur explicite au démarrage", () => {
  assert.throws(() => createSmsProvider({ SMS_PROVIDER: "nope" }), /inconnu/);
  assert.throws(() => createSmsProvider({ SMS_PROVIDER: "twilio" }), /TWILIO_ACCOUNT_SID/);
  assert.throws(() => createSmsProvider({ SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "x" }), /TWILIO_FROM/);
});

test("Twilio : requête correcte (URL, authentification, numéro +216, expéditeur)", async () => {
  let seen;
  const fakeFetch = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 201 }; };
  const env = { SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "secret", TWILIO_FROM: "+15005550006" };
  await createSmsProvider(env, fakeFetch).send("98123456", "Bonjour 123456");
  assert.equal(seen.url, "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
  assert.equal(seen.opts.method, "POST");
  assert.equal(seen.opts.headers.Authorization, `Basic ${Buffer.from("AC123:secret").toString("base64")}`);
  const body = new URLSearchParams(seen.opts.body);
  assert.equal(body.get("To"), "+21698123456");
  assert.equal(body.get("From"), "+15005550006");
  assert.equal(body.get("Body"), "Bonjour 123456");

  const withService = { ...env, TWILIO_MESSAGING_SERVICE_SID: "MG999" };
  await createSmsProvider(withService, fakeFetch).send("98123456", "x");
  const b2 = new URLSearchParams(seen.opts.body);
  assert.equal(b2.get("MessagingServiceSid"), "MG999");
  assert.equal(b2.get("From"), null);
});

test("Twilio : une erreur HTTP fait échouer l'envoi sans recopier le corps de la réponse (contient le numéro)", async () => {
  const fakeFetch = async () => ({ ok: false, status: 400, text: async () => "To: +21698123456 is invalid" });
  const env = { SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "s", TWILIO_FROM: "+1555" };
  await assert.rejects(createSmsProvider(env, fakeFetch).send("98123456", "x"), (e) => {
    assert.match(e.message, /HTTP 400/);
    assert.ok(!e.message.includes("98123456"));
    return true;
  });
});

test("le message contient le code, la durée de validité et l'avertissement, dans les deux langues", () => {
  assert.match(otpMessage("123456", "fr"), /123456.*5 min.*Ne le partagez/);
  assert.match(otpMessage("123456", "ar"), /123456.*5 دقائق.*لا تشاركه/);
});
