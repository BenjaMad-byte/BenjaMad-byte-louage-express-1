// Notifications SMS : changement de statut du dossier, confirmation d'entretien, rappel avant l'entretien.
//
// File d'attente en base (table `notifications`) plutôt qu'envoi direct : un SMS qui échoue est réessayé, un redémarrage ne perd rien,
// et le plafond quotidien protège le budget. Le texte n'est PAS stocké : il est composé au moment de l'envoi, à partir du type et de la langue.
// Sobriété : le SMS dit qu'il y a du nouveau et renvoie vers la page de suivi ; il ne donne jamais le motif d'un refus ni le lien de visioconférence.

const MAX_ATTEMPTS = 5;
const HOUSEKEEPING_DAYS = 30; // journal d'envoi conservé 30 jours (annoncé dans la politique de confidentialité)
const MAX_PER_APPLICATION_PER_DAY = 5; // coupe-circuit contre un statut basculé en boucle

export const NOTIFICATION_KINDS = ["status_approved", "status_rejected", "status_interview", "interview_booked", "interview_reminder"];

/** « 2026-11-01T09:00:00+01:00 » → { date: "01/11", time: "09:00" } (déjà à l'heure de Tunis : on lit le texte, sans conversion). */
const slotParts = (slot) => ({ date: `${slot.slice(8, 10)}/${slot.slice(5, 7)}`, time: slot.slice(11, 16) });

/** Texte court : en arabe un SMS passe en UCS-2 (70 caractères par segment). `url` = adresse du site, sans « / » final ; absente en développement. */
export function messageFor(kind, lang, { slot, url } = {}) {
  const fr = lang === "fr";
  const link = (path) => (url ? ` ${url}${path}` : "");
  const when = slot ? slotParts(slot) : null;
  switch (kind) {
    case "status_approved":
      return fr ? `Louage Express : bonne nouvelle, votre demande est acceptée.${link("/status")}` : `Louage Express: تم قبول طلبك.${link("/status")}`;
    case "status_rejected":
      return fr ? `Louage Express : votre demande a été examinée. Consultez la décision :${link("/status")}` : `Louage Express: تم النظر في طلبك. اطّلع على القرار:${link("/status")}`;
    case "status_interview":
      return fr ? `Louage Express : un entretien vous est proposé. Choisissez un créneau :${link("/interview")}` : `Louage Express: نقترح عليك مقابلة. اختر موعدًا:${link("/interview")}`;
    case "interview_booked":
      return fr ? `Louage Express : entretien confirmé le ${when.date} à ${when.time}. Lien et détails :${link("/status")}` : `Louage Express: تأكدت مقابلتك يوم ${when.date} على ${when.time}. الرابط:${link("/status")}`;
    case "interview_reminder":
      return fr ? `Louage Express : rappel, votre entretien est à ${when.time} (${when.date}). Lien :${link("/status")}` : `Louage Express: تذكير، مقابلتك على ${when.time} (${when.date}). الرابط:${link("/status")}`;
    default:
      throw new Error(`type de notification inconnu : ${kind}`);
  }
}

/**
 * @param {object} o
 * @param {boolean} o.enabled         faux : rien n'est mis en file ni envoyé (développement, ou SMS_NOTIFICATIONS absent)
 * @param {string|null} o.baseUrl     adresse publique du site (PUBLIC_URL), pour les liens ; null = pas de lien
 * @param {number} o.dailyCap         SMS de notification max par 24 h (budget)
 * @param {number} o.reminderHours    délai avant l'entretien pour le rappel
 */
export function createNotifier({ db, sms, enabled = false, baseUrl = null, dailyCap = 300, reminderHours = 3, now = Date.now, maxAttempts = MAX_ATTEMPTS }) {
  let timer = null;
  let running = false;
  let capWarnedAt = 0;
  const iso = (ms) => new Date(ms).toISOString();

  /** Met un SMS en file. `key` rend l'ajout idempotent (un seul SMS par entretien). @returns {boolean} vrai si ajouté. */
  function enqueue({ appId, phone, lang, kind, params = {}, key = null }) {
    if (!enabled || !phone || !NOTIFICATION_KINDS.includes(kind)) return false;
    const t = now();
    if (appId) {
      const recent = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE application_id = ? AND created_at > ?").get(appId, iso(t - 86_400_000)).n;
      if (recent >= MAX_PER_APPLICATION_PER_DAY) return false;
    }
    const info = db
      .prepare("INSERT OR IGNORE INTO notifications (application_id, phone, lang, kind, params, dedupe_key, next_attempt_at, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(appId ?? null, phone, lang === "fr" ? "fr" : "ar", kind, JSON.stringify(params), key, t, iso(t));
    return info.changes === 1;
  }

  /** Rappel pour les entretiens qui commencent dans `reminderHours` heures. Un entretien réservé à l'intérieur de ce délai n'a pas de rappel (la confirmation vient d'être envoyée). */
  function enqueueReminders() {
    if (!enabled) return 0;
    const t = now();
    let added = 0;
    const rows = db
      .prepare("SELECT i.id, i.slot_start, i.created_at, a.id AS app_id, a.phone, a.lang FROM interviews i JOIN applications a ON a.id = i.application_id WHERE i.status = 'booked'")
      .all();
    for (const iv of rows) {
      const slotMs = Date.parse(iv.slot_start);
      if (!(slotMs > t && slotMs - t <= reminderHours * 3_600_000)) continue;
      if (Date.parse(iv.created_at) > slotMs - reminderHours * 3_600_000) continue;
      if (enqueue({ appId: iv.app_id, phone: iv.phone, lang: iv.lang, kind: "interview_reminder", params: { interview_id: iv.id, slot: iv.slot_start }, key: `reminder:${iv.id}` })) added += 1;
    }
    return added;
  }

  /** Ce que le SMS annonce est-il toujours vrai au moment de l'envoi ? (statut rétabli, entretien annulé : on n'envoie pas.) */
  function stillTrue(row, params) {
    if (row.kind.startsWith("status_")) {
      const a = db.prepare("SELECT status FROM applications WHERE id = ?").get(row.application_id);
      return Boolean(a) && a.status === row.kind.slice("status_".length);
    }
    const iv = db.prepare("SELECT status, slot_start FROM interviews WHERE id = ?").get(params.interview_id);
    return Boolean(iv) && iv.status === "booked" && iv.slot_start === params.slot;
  }

  const sentLast24h = () => db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE status = 'sent' AND sent_at > ?").get(iso(now() - 86_400_000)).n;

  /** Envoie le prochain SMS dû. @returns {boolean} faux s'il n'y a rien à faire (ou plafond atteint). */
  async function runOnce() {
    const t = now();
    const row = db.prepare("SELECT * FROM notifications WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT 1").get(t);
    if (!row) return false;
    const params = JSON.parse(row.params);
    if (!stillTrue(row, params)) {
      db.prepare("UPDATE notifications SET status = 'skipped', error = 'stale' WHERE id = ?").run(row.id);
      return true;
    }
    if (sentLast24h() >= dailyCap) {
      if (t - capWarnedAt > 3_600_000) { capWarnedAt = t; console.warn(`[notifications] plafond de ${dailyCap} SMS par 24 h atteint : les envois reprennent seuls`); }
      return false;
    }
    try {
      await sms.send(row.phone, messageFor(row.kind, row.lang, { slot: params.slot, url: baseUrl }));
      db.prepare("UPDATE notifications SET status = 'sent', sent_at = ?, attempts = attempts + 1, error = NULL WHERE id = ?").run(iso(now()), row.id);
    } catch (e) {
      const attempts = row.attempts + 1;
      const failed = attempts >= maxAttempts;
      db.prepare("UPDATE notifications SET attempts = ?, status = ?, next_attempt_at = ?, error = ? WHERE id = ?")
        .run(attempts, failed ? "failed" : "queued", t + 60_000 * 2 ** attempts, String(e.message).slice(0, 120), row.id); // ni numéro ni texte dans l'erreur
      console.error(`[notifications] envoi échoué (${row.kind}, essai ${attempts}) : ${String(e.message).slice(0, 120)}`);
    }
    return true;
  }

  function housekeeping() {
    return db.prepare("DELETE FROM notifications WHERE status <> 'queued' AND created_at < ?").run(iso(now() - HOUSEKEEPING_DAYS * 86_400_000)).changes;
  }

  async function drain() {
    if (running || !enabled) return;
    running = true;
    try {
      enqueueReminders();
      housekeeping();
      while (await runOnce());
    } catch (e) {
      console.error("[notifications] échec inattendu :", e.message);
    } finally {
      running = false;
    }
  }

  function start({ intervalMs = 30_000 } = {}) {
    if (!enabled || timer) return;
    timer = setInterval(drain, intervalMs);
    timer.unref?.();
    setTimeout(drain, 0).unref?.();
  }
  /** À appeler après une mise en file : envoi sans attendre le prochain passage. */
  const kick = () => { if (timer) setTimeout(drain, 0).unref?.(); };
  const stop = () => { clearInterval(timer); timer = null; };

  return { enabled, enqueue, enqueueReminders, runOnce, drain, housekeeping, start, stop, kick };
}
