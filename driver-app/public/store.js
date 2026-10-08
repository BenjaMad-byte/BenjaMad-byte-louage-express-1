// Stockage local de l'appareil (IndexedDB) : jeton de session, dernier état connu du serveur, actions en attente d'envoi.
// Si IndexedDB est indisponible (navigation privée de certains navigateurs), repli en mémoire : l'application marche, mais rien ne survit à sa fermeture.

const DB_NAME = "lx-driver";
const VERSION = 1;

function memoryStore() {
  const kv = new Map();
  const outbox = new Map();
  return {
    persistent: false,
    async get(k) { return kv.get(k) ?? null; },
    async set(k, v) { kv.set(k, structuredClone(v)); },
    async del(k) { kv.delete(k); },
    async outboxAll() { return [...outbox.values()].sort((a, b) => a.seq - b.seq).map((a) => structuredClone(a)); },
    async outboxPut(a) { outbox.set(a.id, structuredClone(a)); },
    async outboxDelete(ids) { for (const id of ids) outbox.delete(id); },
    async clearAll() { kv.clear(); outbox.clear(); },
  };
}

const wrap = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function openStore() {
  if (typeof indexedDB === "undefined") return memoryStore();
  let idb;
  try {
    idb = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("kv");
        req.result.createObjectStore("outbox", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("blocked"));
    });
  } catch {
    return memoryStore();
  }
  const tx = (stores, mode, fn) => new Promise((resolve, reject) => {
    const t = idb.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => { out = v; }, reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return {
    persistent: true,
    get: (k) => tx("kv", "readonly", (t) => wrap(t.objectStore("kv").get(k))).then((v) => v ?? null),
    set: (k, v) => tx("kv", "readwrite", (t) => wrap(t.objectStore("kv").put(v, k))),
    del: (k) => tx("kv", "readwrite", (t) => wrap(t.objectStore("kv").delete(k))),
    outboxAll: () => tx("outbox", "readonly", (t) => wrap(t.objectStore("outbox").getAll())).then((all) => all.sort((a, b) => a.seq - b.seq)),
    outboxPut: (a) => tx("outbox", "readwrite", (t) => wrap(t.objectStore("outbox").put(a))),
    outboxDelete: (ids) => tx("outbox", "readwrite", (t) => Promise.all(ids.map((id) => wrap(t.objectStore("outbox").delete(id))))),
    clearAll: () => tx(["kv", "outbox"], "readwrite", (t) => Promise.all([wrap(t.objectStore("kv").clear()), wrap(t.objectStore("outbox").clear())])),
  };
}
