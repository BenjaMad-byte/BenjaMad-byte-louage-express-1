// Fournisseurs SMS. Interface : { name, send(phone8, text) } — rejette si l'envoi échoue.
// `phone8` est le numéro tunisien sur 8 chiffres ; le préfixe +216 est ajouté ici.

export function createSmsProvider(env = process.env, fetchImpl = fetch) {
  const name = (env.SMS_PROVIDER || "console").toLowerCase();

  if (name === "console") {
    // Développement uniquement : le code apparaît dans les logs du serveur. Jamais en production.
    if (env.NODE_ENV === "production") throw new Error("SMS_PROVIDER=console est interdit en production");
    return {
      name,
      async send(phone8, text) {
        console.log(`[sms:console] +216${phone8} → ${text}`);
      },
    };
  }

  if (name === "twilio") {
    const sid = env.TWILIO_ACCOUNT_SID;
    const token = env.TWILIO_AUTH_TOKEN;
    const from = env.TWILIO_FROM;
    const service = env.TWILIO_MESSAGING_SERVICE_SID;
    if (!sid || !token || !(from || service)) {
      throw new Error("Twilio : TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN et TWILIO_FROM (ou TWILIO_MESSAGING_SERVICE_SID) sont requis");
    }
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    return {
      name,
      async send(phone8, text) {
        const body = new URLSearchParams({ To: `+216${phone8}`, Body: text });
        if (service) body.set("MessagingServiceSid", service);
        else body.set("From", from);
        const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: "POST",
          headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(8000),
        });
        // On ne journalise que le statut HTTP : le corps de la réponse contient le numéro du destinataire.
        if (!res.ok) throw new Error(`twilio HTTP ${res.status}`);
      },
    };
  }

  throw new Error(`SMS_PROVIDER inconnu : « ${name} » (valeurs : console, twilio)`);
}

/** Texte court : un SMS en arabe est encodé en UCS-2 (70 caractères par segment). */
export function otpMessage(code, lang) {
  return lang === "fr"
    ? `Louage Express : votre code est ${code} (valable 5 min). Ne le partagez avec personne.`
    : `Louage Express: رمز التحقق ${code} (صالح 5 دقائق). لا تشاركه مع أحد.`;
}
