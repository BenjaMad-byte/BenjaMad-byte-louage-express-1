// Alertes SOS. Aucune règle de capacité ni de conflit ne s'y applique : toujours enregistrées, jamais rejetées pour une raison métier.
//
// IMPORTANT : ceci n'alerte PAS la Police ni la Protection civile (il n'existe pas d'interface publique pour cela).
// L'alerte part par SMS vers des numéros de PERMANENCE choisis par l'équipe (SOS_ALERT_PHONES), est répétée toutes les 2 minutes
// tant que personne n'a accusé réception dans la console, et reste visible dans l'onglet « Exploitation ».
import crypto from "node:crypto";

export const SOS_TRIGGERS = ["triple_tap", "long_press", "button"];
const REPEAT_MS = 120_000;
const MAX_ALERTS = 10;

const num = (v, min, max) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);

export function createSosService({ db, sms, alertPhones = [], now = Date.now, repeatMs = REPEAT_MS, maxAlerts = MAX_ALERTS }) {
  const iso = () => new Date(now()).toISOString();
  const pending = new Set(); // envois en cours (les tests les attendent avec flush())

  const mapsLink = (e) => (e.lat === null ? "position inconnue" : `https://www.google.com/maps?q=${e.lat.toFixed(5)},${e.lon.toFixed(5)}`);
  const describe = (e) => {
    const d = db.prepare("SELECT full_name, phone, plate FROM drivers WHERE id = ?").get(e.driver_id);
    const age = e.position_age_s === null ? "" : ` (position d'il y a ${e.position_age_s}s)`;
    return `${d.full_name} ${d.phone} ${d.plate} : ${mapsLink(e)}${age}`;
  };

  async function send(text) {
    let ok = false;
    for (const phone of alertPhones) {
      try {
        await sms.send(phone, text);
        ok = true;
      } catch (e) {
        console.error(`[sos] envoi SMS échoué : ${String(e.message).slice(0, 80)}`); // ni numéro ni texte dans les journaux
      }
    }
    return ok;
  }

  function dispatch(promise) {
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    return promise;
  }

  async function alert(id) {
    const e = db.prepare("SELECT * FROM sos_events WHERE id = ?").get(id);
    if (!e || e.status !== "open" || e.alerts_sent >= maxAlerts) return false;
    db.prepare("UPDATE sos_events SET alerts_sent = alerts_sent + 1, last_alert_at = ? WHERE id = ?").run(now(), id);
    const n = e.alerts_sent + 1;
    return send(`SOS LOUAGE${n > 1 ? ` (rappel ${n})` : ""} : ${describe(e)}. Accusez réception dans la console.`);
  }

  /** Enregistre une alerte (idempotent par identifiant d'action) et lance l'envoi immédiat. */
  function record(driver, tripId, payload, { id: clientActionId, createdAt }) {
    const existing = db.prepare("SELECT * FROM sos_events WHERE client_action_id = ?").get(clientActionId);
    if (existing) return { event: existing, created: false };
    const id = crypto.randomUUID();
    const trigger = SOS_TRIGGERS.includes(payload.trigger) ? payload.trigger : "button";
    db.prepare(
      `INSERT INTO sos_events (id, driver_id, trip_id, client_action_id, lat, lon, accuracy_m, position_age_s, trigger, client_created_at, received_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, driver.id, tripId ?? null, clientActionId, num(payload.lat, -90, 90), num(payload.lon, -180, 180), num(payload.accuracy, 0, 100000), Number.isInteger(payload.ageS) && payload.ageS >= 0 ? payload.ageS : null, trigger, createdAt ?? null, iso());
    dispatch(alert(id));
    return { event: db.prepare("SELECT * FROM sos_events WHERE id = ?").get(id), created: true };
  }

  /** Faux déclenchement signalé par le chauffeur : l'alerte reste dans le journal, marquée annulée, et la permanence est prévenue. */
  function cancel(driver, targetClientActionId, note) {
    const e = db.prepare("SELECT * FROM sos_events WHERE client_action_id = ? AND driver_id = ?").get(targetClientActionId, driver.id);
    if (!e) return { status: "rejected", reason: "unknown_sos" };
    if (e.status !== "open") return { status: "noop" };
    db.prepare("UPDATE sos_events SET status = 'cancelled', note = ?, resolved_at = ? WHERE id = ?").run(String(note ?? "faux déclenchement signalé par le chauffeur").slice(0, 200), iso(), e.id);
    dispatch(send(`SOS ANNULÉ par le chauffeur (faux déclenchement) : ${describe(e)}.`));
    return { status: "applied" };
  }

  /** À appeler toutes les minutes : relance les alertes sans accusé de réception. */
  async function tick() {
    const due = db.prepare("SELECT id FROM sos_events WHERE status = 'open' AND alerts_sent < ? AND (last_alert_at IS NULL OR last_alert_at <= ?)").all(maxAlerts, now() - repeatMs);
    for (const { id } of due) await alert(id);
    return due.length;
  }

  function ack(id, by) {
    const e = db.prepare("SELECT status FROM sos_events WHERE id = ?").get(id);
    if (!e) return { error: "not_found" };
    if (e.status !== "open") return { error: "not_open" };
    db.prepare("UPDATE sos_events SET status = 'ack', ack_by = ?, ack_at = ? WHERE id = ?").run(String(by).slice(0, 40), iso(), id);
    return { ok: true };
  }

  function resolve(id, by, note) {
    const e = db.prepare("SELECT status FROM sos_events WHERE id = ?").get(id);
    if (!e) return { error: "not_found" };
    if (e.status === "resolved" || e.status === "cancelled") return { error: "not_open" };
    db.prepare("UPDATE sos_events SET status = 'resolved', ack_by = COALESCE(ack_by, ?), ack_at = COALESCE(ack_at, ?), resolved_at = ?, note = ? WHERE id = ?").run(String(by).slice(0, 40), iso(), iso(), String(note ?? "").slice(0, 300) || null, id);
    return { ok: true };
  }

  const list = ({ limit = 50 } = {}) =>
    db.prepare(
      `SELECT s.*, d.full_name, d.phone, d.plate FROM sos_events s JOIN drivers d ON d.id = s.driver_id
       ORDER BY CASE s.status WHEN 'open' THEN 0 WHEN 'ack' THEN 1 ELSE 2 END, s.received_at DESC LIMIT ?`
    ).all(Math.min(Math.max(Number(limit) || 50, 1), 200));

  return { record, cancel, tick, ack, resolve, list, flush: () => Promise.allSettled([...pending]), start({ intervalMs = 60_000 } = {}) { const t = setInterval(() => tick().catch(() => {}), intervalMs); t.unref?.(); return t; } };
}
