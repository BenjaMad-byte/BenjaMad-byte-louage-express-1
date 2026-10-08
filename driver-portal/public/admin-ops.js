// Console d'administration, onglet « Exploitation » : files des louages, voyages en cours et ALERTES SOS de l'application chauffeur.
// Tout texte passe par textContent (fonction h() fournie par admin.js).

const SOS_STATUS = { open: "À prendre en charge", ack: "Prise en charge", resolved: "Clôturée", cancelled: "Annulée par le chauffeur (faux déclenchement)" };
const TRIGGER = { triple_tap: "3 appuis", long_press: "appui long", button: "bouton" };
const LINE_STATUS = { queued: "dans la file", en_route: "en route" };

export function createOps({ $, h, call, fmtDate }) {
  let unavailable = false;
  let timer = null;

  const fmtAge = (s) => (s === null || s === undefined ? "" : s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);

  async function load() {
    const res = await call("/ops/overview");
    if (res.status === 503 || res.status === 502) { unavailable = true; return { error: res.status }; }
    unavailable = false;
    return res.ok ? res.json() : { error: res.status };
  }

  function sosRow(s, refresh) {
    const act = async (path, body) => {
      await call(`/ops/sos/${encodeURIComponent(s.id)}/${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });
      refresh();
      document.dispatchEvent(new CustomEvent("lx-sos-changed")); // la bannière se met à jour tout de suite, pas 20 s plus tard
    };
    const where = s.lat === null || s.lat === undefined
      ? "position inconnue"
      : h("a", { href: `https://www.google.com/maps?q=${s.lat},${s.lon}`, target: "_blank", rel: "noopener noreferrer" }, `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`);
    return h("tr", { class: s.status === "open" ? "sos-open" : "" },
      h("td", {}, h("span", { class: `badge ${s.status === "open" ? "rejected" : s.status === "ack" ? "interview" : "approved"}` }, SOS_STATUS[s.status] ?? s.status)),
      h("td", {}, fmtDate(s.received_at)),
      h("td", {}, h("strong", {}, s.full_name), h("div", { class: "note mono" }, s.phone)),
      h("td", { class: "mono" }, s.plate),
      h("td", {}, where, s.position_age_s !== null && s.position_age_s !== undefined ? h("div", { class: "note" }, `lue il y a ${fmtAge(s.position_age_s)}`) : null),
      h("td", {}, TRIGGER[s.trigger] ?? s.trigger, h("div", { class: "note" }, `${s.alerts_sent} SMS`)),
      h("td", {}, s.ack_by ? `${s.ack_by}${s.ack_at ? ` · ${fmtDate(s.ack_at)}` : ""}` : "", s.note ? h("div", { class: "note" }, s.note) : null),
      h("td", {}, h("div", { class: "doc-actions" },
        s.status === "open" ? h("button", { type: "button", class: "btn small", onclick: () => act("ack") }, "Prendre en charge") : null,
        s.status === "open" || s.status === "ack" ? h("button", { type: "button", class: "btn secondary small", onclick: () => { const note = prompt("Note de clôture (qu'est-ce qui s'est passé ?)"); if (note !== null) act("resolve", { note }); } }, "Clôturer") : null)));
  }

  const seatsOf = (t) => `${t.onboardNow + t.reservedNow} / ${t.capacity}${t.reservedNow ? ` (dont ${t.reservedNow} réservée${t.reservedNow > 1 ? "s" : ""})` : ""}`;

  function lineBlock(l) {
    const row = (t) => h("tr", {},
      h("td", {}, t.rank ? `#${t.rank}` : LINE_STATUS[t.status]),
      h("td", { class: "mono" }, t.plate), h("td", {}, t.driver), h("td", {}, seatsOf(t)),
      h("td", {}, t.status === "en_route" ? `à ${t.stops[t.currentStop] ?? ""}` : t.stops.join(" → ")));
    return h("div", { class: "line-block" },
      h("h3", {}, `${l.from} → ${l.toGov ?? "destination libre"}`),
      h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Rang / état", "Plaque", "Chauffeur", "Places", "Arrêts"].map((x) => h("th", {}, x)))),
        h("tbody", {}, [...l.queue, ...l.enRoute].map(row)))));
  }

  async function render() {
    const host = $("view-ops");
    const data = await load();
    if (data.error) {
      host.replaceChildren(h("p", { class: "banner error", role: "alert" }, unavailable ? "L'application chauffeur n'est pas joignable (ou n'est pas configurée : APP_URL et APP_OPS_KEY)." : "Erreur de chargement."));
      return;
    }
    const refresh = () => render();
    const open = data.sos.filter((s) => s.status === "open");
    host.replaceChildren(
      h("div", { class: "toolbar" },
        h("p", { class: "note", role: "status" }, `${data.drivers.active} chauffeur(s) actif(s) sur ${data.drivers.total} · réservations : ${Object.entries(data.reservations ?? {}).map(([k, v]) => `${v} ${k}`).join(", ") || "aucune"} · mis à jour ${fmtDate(data.now)}`),
        h("div", { class: "doc-actions" },
          h("button", { type: "button", class: "btn secondary small", onclick: refresh }, "Actualiser"),
          h("button", { type: "button", class: "btn secondary small", onclick: async () => { await call("/ops/drivers/sync", { method: "POST", body: "{}" }); refresh(); } }, "Resynchroniser les chauffeurs"))),
      h("h2", {}, `Alertes SOS${open.length ? ` (${open.length} à prendre en charge)` : ""}`),
      data.sos.length
        ? h("div", { class: "table-wrap" }, h("table", { id: "sos-table" }, h("thead", {}, h("tr", {}, ["État", "Reçue", "Chauffeur", "Plaque", "Position", "Déclenchement", "Prise en charge", ""].map((x) => h("th", {}, x)))), h("tbody", {}, data.sos.map((s) => sosRow(s, refresh)))))
        : h("p", { class: "note" }, "Aucune alerte."),
      h("h2", {}, "Files et voyages en cours"),
      ...(data.lines.length ? data.lines.map(lineBlock) : [h("p", { class: "note" }, "Aucun louage dans une file ni en route.")]));
    schedule();
  }

  /** Actualisation automatique toutes les 15 s tant que l'onglet est affiché. */
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!$("view-ops").hidden && !document.hidden) render(); else schedule(); }, 15000);
  }

  /** Bannière rouge visible sur TOUS les onglets tant qu'une alerte n'est pas prise en charge. */
  async function pollBanner(openTab) {
    if (unavailable) return;
    const data = await load().catch(() => ({ error: 0 }));
    const banner = $("sos-banner");
    const open = data.error ? [] : data.sos.filter((s) => s.status === "open");
    if (!open.length) { banner.hidden = true; document.title = "Administration — Louage Express"; return; }
    banner.hidden = false;
    banner.replaceChildren(h("strong", {}, `🆘 ${open.length} alerte${open.length > 1 ? "s" : ""} SOS à prendre en charge`), " ", h("button", { type: "button", class: "btn small", onclick: openTab }, "Voir"));
    document.title = `🆘 (${open.length}) Administration — Louage Express`;
  }

  return { render, pollBanner };
}
