// Client du site d'inscription (service à service) : qui est un chauffeur ACCEPTÉ ? Clé partagée APP_SERVICE_KEY, en-tête X-Service-Key.
// Le téléphone voyage dans le corps d'une requête POST, jamais dans une URL.

export class PortalUnreachable extends Error {
  constructor(message) {
    super(message);
    this.code = "portal_unreachable";
  }
}

export function createPortalClient({ url, key, fetchImpl = fetch, timeoutMs = 6000 }) {
  const base = String(url ?? "").replace(/\/+$/, "");
  async function call(path, body) {
    if (!base || !key) throw new PortalUnreachable("PORTAL_URL ou APP_SERVICE_KEY non configuré");
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Service-Key": key },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new PortalUnreachable(`site d'inscription injoignable (${e.name})`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new PortalUnreachable(`site d'inscription : HTTP ${res.status}`); // 401 (clé), 503 (service désactivé), 5xx
    return res.json();
  }
  return {
    /** @returns {Promise<object|null>} le chauffeur accepté, ou null s'il n'existe pas (ou plus). */
    async lookup(phone) {
      const data = await call("/api/service/drivers/lookup", { phone });
      return data?.driver ?? null;
    },
    /** @returns {Promise<object[]>} tous les chauffeurs acceptés. */
    async approved() {
      return (await call("/api/service/drivers/approved", {})).drivers;
    },
  };
}
