import assert from "node:assert/strict";

/** Faux fournisseur SMS : mémorise les messages et expose le dernier code. */
export function stubSms() {
  return {
    name: "stub",
    sent: [],
    failing: false,
    async send(phone, text) {
      if (this.failing) throw new Error("fournisseur indisponible");
      this.sent.push({ phone, text, code: text.match(/\d{6}/)[0] });
    },
  };
}

/** Horloge injectable pour tester l'expiration sans attendre. */
export function makeClock(start = Date.now()) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const JSON_HEADERS = { "Content-Type": "application/json" };
export const postJson = (base, url, body) => fetch(base + url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

/** Envoie un code, le lit dans le faux SMS, le vérifie, retourne le jeton « téléphone vérifié ». */
export async function verifiedToken(base, sms, clock, phone) {
  clock.advance(61_000); // dépasse le délai minimum entre deux envois
  const sent = await postJson(base, "/api/otp/send", { phone, lang: "fr" });
  assert.equal(sent.status, 200, "envoi du code");
  const verified = await postJson(base, "/api/otp/verify", { phone, code: sms.sent.at(-1).code });
  assert.equal(verified.status, 200, "vérification du code");
  return (await verified.json()).token;
}
