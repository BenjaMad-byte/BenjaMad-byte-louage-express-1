// File d'actions hors ligne et synchronisation avec le serveur.
//
// Chaque geste du chauffeur devient une action avec un identifiant unique (clé d'idempotence côté serveur) et un numéro d'ordre qui ne fait que croître
// sur l'appareil (le serveur rejoue DANS CET ORDRE, pas selon l'horloge du téléphone). L'action est écrite sur l'appareil AVANT tout envoi :
// une coupure, une fermeture de l'application ou un plantage n'en perd aucune.

const BATCH = 200;
const FAIL = ["rejected", "conflict_rejected"];
const newId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);

/**
 * @param {object} o
 * @param {object} o.store  voir store.js
 * @param {(update: {state: object|null, results: object[]}) => void} [o.onUpdate]
 * @param {() => void} [o.onAuthLost]  le serveur ne reconnaît plus le jeton (compte désactivé, session expirée)
 * @param {(results: object[]) => void} [o.onRejected]  actions refusées par le serveur (ex. place refusée : louage plein)
 */
export function createSync({ store, fetchImpl = (...a) => fetch(...a), now = Date.now, onUpdate = () => {}, onAuthLost = () => {}, onRejected = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let running = false;
  let again = false;
  let timer = null;
  let delay = 3000;
  let lastError = null;

  async function nextSeq() {
    const seq = ((await store.get("seq")) ?? 0) + 1;
    await store.set("seq", seq);
    return seq;
  }

  /**
   * Enregistre une action sur l'appareil. À appeler AVANT de modifier l'affichage.
   * `accept(action)` (facultatif) est consulté avant d'écrire : s'il répond faux, rien n'est enregistré et la fonction renvoie null
   * (ex. le moteur local voit déjà que le louage est plein : inutile d'envoyer une action condamnée).
   */
  async function enqueue(type, payload = {}, accept = null) {
    const action = { id: newId(), seq: await nextSeq(), type, payload, createdAt: new Date(now()).toISOString() };
    if (accept && !accept(action)) return null;
    await store.outboxPut(action);
    return action;
  }

  const pending = () => store.outboxAll();

  function schedule() {
    clearTimer(timer);
    timer = setTimer(() => flush(), delay);
    delay = Math.min(delay * 2, 60_000);
  }

  /** Envoie tout ce qui attend. Sans action en attente, rafraîchit simplement l'état. @returns {Promise<{ok: boolean, sent: number}>} */
  async function flush() {
    if (running) { again = true; return { ok: true, sent: 0 }; }
    running = true;
    let sentTotal = 0;
    try {
      const token = await store.get("token");
      if (!token) return { ok: false, sent: 0 };
      for (;;) {
        const batch = (await pending()).slice(0, BATCH);
        let res;
        try {
          res = batch.length
            ? await fetchImpl("/api/driver/sync", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ actions: batch }), signal: AbortSignal.timeout?.(15_000) })
            : await fetchImpl("/api/driver/state", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout?.(15_000) });
        } catch (e) {
          lastError = "network";
          if ((await pending()).length) schedule();
          return { ok: false, sent: sentTotal };
        }
        if (res.status === 401) { await store.del("token"); onAuthLost(); return { ok: false, sent: sentTotal }; }
        if (!res.ok) {
          lastError = `http_${res.status}`;
          if ((await pending()).length) schedule();
          return { ok: false, sent: sentTotal };
        }
        const data = await res.json();
        const state = batch.length ? data.state : data;
        if (batch.length) {
          await store.outboxDelete(batch.map((a) => a.id)); // le serveur a répondu pour chacune (appliquée, rejouée ou refusée) : elles sortent de la file
          sentTotal += batch.length;
          const rejected = data.results.filter((r) => FAIL.includes(r.status));
          if (rejected.length) onRejected(rejected);
        }
        await store.set("server", state);
        await store.set("lastSync", now());
        lastError = null;
        delay = 3000;
        clearTimer(timer);
        onUpdate({ state, results: batch.length ? data.results : [] });
        if (!(await pending()).length) break;
      }
      return { ok: true, sent: sentTotal };
    } finally {
      running = false;
      if (again) { again = false; setTimer(() => flush(), 0); }
    }
  }

  return { enqueue, flush, pending, get lastError() { return lastError; }, cancelRetry: () => clearTimer(timer) };
}
