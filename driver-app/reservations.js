// Réservations en ligne : retenue d'une place dans un voyage, acompte par SVA, code à montrer au chauffeur.
//
// Cycle d'une réservation :
//   pending_sva ──(callback « success »)──► confirmed ──(le chauffeur confirme la montée)──► boarded
//        │                                       │──(déplacée par un passager physique)──► réattribuée, sinon remboursée (displaced)
//        │──(callback « failed » / expiration)──► cancelled            └──(le passager n'est pas venu)──► no_show
// Une place est RETENUE dans le voyage (statut « reserved » du moteur) dès la création, pendant `holdMs` tant que le paiement n'est pas confirmé.
// Un paiement qui arrive APRÈS l'annulation ou l'expiration est remboursé automatiquement : de l'argent ne reste jamais pris pour rien.
import crypto from "node:crypto";
import * as E from "./public/engine.js";
import { matchKey } from "../driver-portal/public/places.js";
import { loadTrip, saveTrip, tripsOfLine } from "./trips.js";
import { OPERATORS, DEPOSITS_MILLIMES } from "./sva.js";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sans 0/O/1/I/L
const ACTIVE = ["pending_sva", "confirmed"];
const FINAL = ["boarded", "cancelled", "refunded", "no_show", "displaced"];
const MAX_ACTIVE_PER_PHONE = 2;

const newCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
const stopIndex = (trip, name) => trip.stops.findIndex((s) => matchKey(s) === matchKey(name));

export function createReservations({ db, sva, sms, now = Date.now, holdMs = 3 * 60_000, retentionDays = 30 }) {
  const iso = () => new Date(now()).toISOString();
  const pending = new Set();
  const track = (promise) => { pending.add(promise); promise.finally(() => pending.delete(promise)); return promise; };

  const byId = (id) => db.prepare("SELECT * FROM reservations WHERE id = ?").get(id);
  const byCode = (code) => db.prepare("SELECT * FROM reservations WHERE code = ?").get(String(code ?? "").trim().toUpperCase());
  const touch = (id, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE reservations SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), iso(), id);
  };

  const notify = (r, fr, ar) => track(
    Promise.resolve().then(() => sms.send(r.passenger_phone, r.lang === "fr" ? fr : ar)).catch((e) => console.error(`[reservations] SMS échoué : ${String(e.message).slice(0, 80)}`))
  );

  /** Ce que le passager a le droit de voir : jamais le nom ni le téléphone du chauffeur. La plaque n'apparaît qu'une fois la réservation confirmée. */
  function view(r) {
    const trip = r.trip_id ? db.prepare("SELECT t.status, d.plate FROM trips t JOIN drivers d ON d.id = t.driver_id WHERE t.id = ?").get(r.trip_id) : null;
    const line = db.prepare("SELECT from_name FROM lines WHERE id = ?").get(r.line_id);
    return {
      code: r.code, status: r.status, from: r.from_name, to: r.to_name, depositMillimes: r.deposit_millimes,
      expiresAt: r.status === "pending_sva" ? r.hold_expires_at : null,
      ...(["confirmed", "boarded"].includes(r.status) && trip ? { plate: trip.plate, station: line?.from_name } : {}),
    };
  }

  /** Lignes proposées aux passagers : celles qui ont au moins un louage dans la file ou en route. */
  function publicLines() {
    return db.prepare("SELECT * FROM lines").all().map((l) => {
      const trips = tripsOfLine(db, l.id).filter((t) => !E.CLOSED.includes(t.status));
      if (!trips.length) return null;
      const first = E.orderQueue(trips)[0] ?? trips[0];
      return { id: l.id, from: l.from_name, toGov: l.to_gov, stops: first.stops, freeAtOrigin: first.status === "queued" ? E.summary(first).freeNow : 0 };
    }).filter(Boolean);
  }

  /** @returns {Promise<{error: string} | {reservation: object}>} */
  async function create({ lineId, fromName, toName, phone, operator, depositMillimes, lang }) {
    if (!phone) return { error: "invalid_phone" };
    if (!OPERATORS.includes(operator)) return { error: "invalid_operator" };
    if (!DEPOSITS_MILLIMES.includes(depositMillimes)) return { error: "invalid_deposit" };
    if (typeof fromName !== "string" || typeof toName !== "string" || !fromName.trim() || !toName.trim()) return { error: "invalid_stops" };
    const line = db.prepare("SELECT id FROM lines WHERE id = ?").get(Number(lineId));
    if (!line) return { error: "unknown_line" };
    const active = db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE passenger_phone = ? AND status IN (${ACTIVE.map(() => "?").join(",")})`).get(phone, ...ACTIVE).n;
    if (active >= MAX_ACTIVE_PER_PHONE) return { error: "too_many_active" };

    const id = crypto.randomUUID();
    let created;
    db.exec("BEGIN IMMEDIATE");
    try {
      const trips = tripsOfLine(db, line.id);
      const route = (t) => {
        const from = stopIndex(t, fromName);
        const to = stopIndex(t, toName);
        return from >= 0 && to > from ? { from, to } : null;
      };
      const trip = E.chooseTripForReservation(trips, route);
      if (!trip) { db.exec("ROLLBACK"); return { error: "no_trip_available" }; }
      const { from, to } = route(trip);
      const { trip: next, result } = E.board(trip, { id, from, to, source: "reservation", createdAt: iso() });
      if (result.status !== "applied") { db.exec("ROLLBACK"); return { error: "no_trip_available" }; }
      saveTrip(db, next);
      let code = newCode();
      while (byCode(code)) code = newCode();
      db.prepare(
        `INSERT INTO reservations (id, code, line_id, trip_id, from_name, to_name, boarding_id, lang, passenger_phone, deposit_millimes, operator, status, hold_expires_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending_sva',?,?,?)`
      ).run(id, code, line.id, trip.id, trip.stops[from], trip.stops[to], id, lang === "fr" ? "fr" : "ar", phone, depositMillimes, operator, now() + holdMs, iso(), iso());
      db.exec("COMMIT");
      created = byId(id);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    try {
      const { providerRef } = await sva.charge({ reservationId: id, phone, operator, amountMillimes: depositMillimes });
      touch(id, { sva_ref: providerRef });
    } catch (e) {
      console.error(`[reservations] prélèvement impossible : ${String(e.message).slice(0, 80)}`);
      release(created, "cancelled");
      return { error: "sva_unavailable" };
    }
    return { reservation: view(byId(id)) };
  }

  /** Libère la place retenue dans le voyage et passe la réservation à `status`. */
  function release(r, status) {
    const trip = r.trip_id ? loadTrip(db, r.trip_id) : null;
    if (trip && r.boarding_id) saveTrip(db, E.release(trip, r.boarding_id, "cancelled").trip);
    touch(r.id, { status });
  }

  /** Résultat du prélèvement envoyé par l'opérateur (signature vérifiée par l'appelant). Idempotent. */
  async function handleCallback({ reservationId, status, providerRef }) {
    const r = byId(reservationId);
    if (!r) return { error: "not_found" };
    if (!["success", "failed"].includes(status)) return { error: "invalid_status" };
    if (status === "failed") {
      if (r.status === "pending_sva") release(r, "cancelled");
      return { ok: true };
    }
    if (r.status === "confirmed" || r.status === "boarded") return { ok: true }; // callback rejoué
    if (r.status === "pending_sva") {
      touch(r.id, { status: "confirmed", sva_ref: providerRef ?? r.sva_ref });
      const v = view(byId(r.id));
      notify(r, `Louage Express : réservation confirmée. Code ${r.code}. Louage ${v.plate ?? ""} à ${v.station ?? ""} (${r.from_name} → ${r.to_name}). Montrez ce code au chauffeur.`,
        `Louage Express: تأكّد حجزك. الكود ${r.code}. اللواج ${v.plate ?? ""} في ${v.station ?? ""} (${r.from_name} ← ${r.to_name}). وري الكود للسوّاق.`);
      return { ok: true };
    }
    // Le paiement arrive APRÈS l'expiration ou l'annulation : la place a été libérée, on rend l'argent.
    await refund(r, providerRef ?? r.sva_ref, "refunded");
    return { ok: true, refunded: true };
  }

  async function refund(r, providerRef, status) {
    try {
      await sva.refund({ providerRef, amountMillimes: r.deposit_millimes });
      touch(r.id, { status });
    } catch (e) {
      console.error(`[reservations] REMBOURSEMENT À FAIRE À LA MAIN : réservation ${r.code} : ${String(e.message).slice(0, 80)}`);
    }
  }

  async function cancel({ code, phone }) {
    const r = byCode(code);
    if (!r || r.passenger_phone !== phone) return { error: "not_found" };
    if (r.status === "pending_sva") { release(r, "cancelled"); return { ok: true }; }
    if (r.status === "confirmed") {
      release(r, "cancelled");
      await refund(byId(r.id), r.sva_ref, "refunded");
      return { ok: true, refunded: true };
    }
    return { error: "not_cancellable" };
  }

  function status({ code, phone }) {
    const r = byCode(code);
    return !r || r.passenger_phone !== phone ? null : view(r);
  }

  /** Retenues non payées à temps : la place est libérée. À appeler chaque minute. */
  function expire() {
    const due = db.prepare("SELECT * FROM reservations WHERE status = 'pending_sva' AND hold_expires_at <= ?").all(now());
    for (const r of due) release(r, "cancelled");
    return due.length;
  }

  /** Données de passagers : supprimées `retentionDays` jours après la fin de la réservation. */
  function purgeOld() {
    const cutoff = new Date(now() - retentionDays * 86_400_000).toISOString();
    return db.prepare(`DELETE FROM reservations WHERE status IN (${FINAL.map(() => "?").join(",")}) AND updated_at < ?`).run(...FINAL, cutoff).changes;
  }

  // ---------------------------------------------------------------- liens avec les actions du chauffeur
  const hooks = {
    /** Des passagers physiques ont pris la place de ces réservations : on les réattribue à un autre voyage, sinon on les rembourse. */
    displaced(trip, boardingIds) {
      for (const bid of boardingIds) {
        const r = db.prepare("SELECT * FROM reservations WHERE boarding_id = ?").get(bid);
        if (!r || !ACTIVE.includes(r.status)) continue;
        const others = tripsOfLine(db, r.line_id).filter((t) => t.id !== trip.id);
        const route = (t) => {
          const from = stopIndex(t, r.from_name);
          const to = stopIndex(t, r.to_name);
          return from >= 0 && to > from ? { from, to } : null;
        };
        const target = E.chooseTripForReservation(others, route);
        if (target) {
          const newId = `${r.id}-${crypto.randomBytes(3).toString("hex")}`;
          const { from, to } = route(target);
          const { trip: next, result } = E.board(target, { id: newId, from, to, source: "reservation", createdAt: r.created_at });
          if (result.status === "applied") {
            saveTrip(db, next);
            touch(r.id, { trip_id: target.id, boarding_id: newId });
            const plate = db.prepare("SELECT plate FROM drivers WHERE id = ?").get(target.driverId)?.plate ?? "";
            notify(r, `Louage Express : votre place a changé. Nouveau louage ${plate}. Code ${r.code} inchangé.`, `Louage Express: البلاصة تبدّلت. اللواج الجديد ${plate}. الكود ${r.code} هو هو.`);
            continue;
          }
        }
        touch(r.id, { status: "displaced" });
        notify(r, `Louage Express : désolé, votre place n'est plus disponible. Votre acompte vous est remboursé.`, `Louage Express: نعتذرو، البلاصة ما عادتش متوفّرة. تتسترجع فلوسك.`);
        if (r.status === "confirmed") track(refund(r, r.sva_ref, "displaced"));
      }
    },
    noShow(_trip, boardingIds) {
      for (const bid of boardingIds) {
        const r = db.prepare("SELECT * FROM reservations WHERE boarding_id = ?").get(bid);
        if (r && ACTIVE.includes(r.status)) touch(r.id, { status: "no_show" });
      }
    },
    boarded(boardingId) {
      const r = db.prepare("SELECT * FROM reservations WHERE boarding_id = ?").get(boardingId);
      if (r && ACTIVE.includes(r.status)) touch(r.id, { status: "boarded" });
    },
  };

  const counts = () => Object.fromEntries(db.prepare("SELECT status, COUNT(*) AS n FROM reservations GROUP BY status").all().map((x) => [x.status, x.n]));
  const codeOfBoarding = (id) => db.prepare("SELECT code FROM reservations WHERE boarding_id = ?").get(id)?.code ?? null;

  return { create, handleCallback, cancel, status, expire, purgeOld, publicLines, hooks, counts, codeOfBoarding, view, byCode, flush: () => Promise.allSettled([...pending]) };
}
