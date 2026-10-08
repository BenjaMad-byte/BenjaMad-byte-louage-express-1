// Paiement de l'acompte par solde mobile (SVA : Tunisie Telecom, Ooredoo, Orange).
//
// ⚠ AUCUNE CONNEXION RÉELLE À UN OPÉRATEUR N'EXISTE. Ce module définit l'interface qu'un vrai fournisseur devra respecter et fournit une SIMULATION
// pour le développement et les tests. Le circuit des fonds (qui encaisse, comment le chauffeur est payé, remboursements) dépend d'un contrat
// avec les opérateurs et n'est pas défini : voir docs/plan-application-chauffeur.md §6.
//
// Interface d'un fournisseur :
//   charge({ reservationId, phone, operator, amountMillimes }) → { providerRef }   lance le prélèvement ; le résultat arrive plus tard par callback signé
//   refund({ providerRef, amountMillimes })                    → { ok }
import crypto from "node:crypto";

export const OPERATORS = Object.freeze(["tt", "ooredoo", "orange"]);
export const DEPOSITS_MILLIMES = Object.freeze([1500, 2000]);

/** Signature d'un callback : HMAC-SHA256 du corps brut avec le secret partagé avec l'opérateur. */
export const signCallback = (rawBody, secret) => `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;

export function verifyCallbackSignature(rawBody, header, secret) {
  if (!secret || !header) return false;
  const expected = Buffer.from(signCallback(rawBody, secret));
  const given = Buffer.from(String(header));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Fournisseur SIMULÉ : n'appelle personne. Les prélèvements sont mémorisés ; les tests (ou la page de démonstration) déclenchent le callback.
 * Un numéro se terminant par « 00 » simule un solde insuffisant.
 */
export function createSimulatedSva() {
  const charges = new Map();
  const refunds = [];
  return {
    name: "simulated",
    charges,
    refunds,
    async charge({ reservationId, phone, operator, amountMillimes }) {
      const providerRef = `SIM-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
      charges.set(reservationId, { providerRef, phone, operator, amountMillimes, willFail: phone.endsWith("00") });
      return { providerRef };
    },
    async refund({ providerRef, amountMillimes }) {
      refunds.push({ providerRef, amountMillimes });
      return { ok: true };
    },
  };
}

/** Fournisseur choisi par SVA_PROVIDER. Aujourd'hui seule la simulation existe : un autre nom est une erreur franche, jamais un repli silencieux. */
export function createSva(env = process.env) {
  const name = (env.SVA_PROVIDER || "simulated").toLowerCase();
  if (name === "simulated") {
    if (env.NODE_ENV === "production") throw new Error("SVA_PROVIDER=simulated est interdit en production : aucun opérateur n'est branché, les réservations en ligne restent désactivées");
    return createSimulatedSva();
  }
  throw new Error(`SVA_PROVIDER inconnu : « ${name} » (aucune connexion réelle à un opérateur n'est implémentée)`);
}
