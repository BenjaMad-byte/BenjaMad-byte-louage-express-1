// Page de DÉMONSTRATION de la réservation passager (français seulement). Tout texte passe par textContent.
const $ = (id) => document.getElementById(id);
const STATUS = {
  pending_sva: "En attente du paiement…", confirmed: "Réservation confirmée. Montrez ce code au chauffeur.", boarded: "Vous êtes monté. Bon voyage !",
  cancelled: "Réservation annulée.", refunded: "Réservation annulée et acompte remboursé.", no_show: "Vous n'êtes pas monté à temps.", displaced: "Votre place n'est plus disponible : acompte remboursé.",
};
const ERRORS = { invalid_phone: "Numéro de téléphone incorrect.", no_trip_available: "Plus de place sur ce trajet pour le moment.", too_many_active: "Vous avez déjà deux réservations en cours.", sva_unavailable: "Paiement indisponible, réessayez.", reservations_disabled: "Les réservations ne sont pas ouvertes.", rate_limited: "Trop de demandes, patientez un instant." };
let lines = [];
let current = null; // { code, phone, reservationId }
let timer = null;

const post = async (url, body) => {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
};
const options = (select, items) => select.replaceChildren(...items.map(([value, label]) => Object.assign(document.createElement("option"), { value, textContent: label })));

function fillStops() {
  const line = lines.find((l) => String(l.id) === $("line").value);
  if (!line) return;
  options($("from"), line.stops.slice(0, -1).map((s) => [s, s]));
  options($("to"), line.stops.slice(1).map((s) => [s, s]));
}

async function showStatus() {
  if (!current) return;
  const { ok, data } = await post("/api/passenger/reservations/status", { code: current.code, phone: current.phone });
  if (!ok) return;
  const r = data.reservation;
  $("status").textContent = STATUS[r.status] ?? r.status;
  $("plate").textContent = r.plate ? `Louage ${r.plate} · gare de ${r.station}` : "";
  $("settle").hidden = r.status !== "pending_sva" || !current.canSettle;
  $("cancel").hidden = !["pending_sva", "confirmed"].includes(r.status);
  if (!["pending_sva", "confirmed"].includes(r.status)) clearInterval(timer);
}

async function boot() {
  const res = await fetch("/api/passenger/lines");
  if (!res.ok) { $("empty").hidden = false; $("empty").textContent = res.status === 503 ? "Les réservations ne sont pas ouvertes." : "Service indisponible."; return; }
  lines = (await res.json()).lines;
  if (!lines.length) { $("empty").hidden = false; return; }
  options($("line"), lines.map((l) => [l.id, `${l.from} → ${l.toGov ?? "destination libre"}`]));
  fillStops();
  $("form").hidden = false;
  $("line").addEventListener("change", fillStops);
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("error").textContent = "";
  const phone = $("phone").value;
  const { ok, data } = await post("/api/passenger/reservations", { lineId: Number($("line").value), from: $("from").value, to: $("to").value, phone, operator: $("operator").value, deposit: Number($("deposit").value), lang: "fr" });
  if (!ok) { $("error").textContent = ERRORS[data.error] ?? "Réservation impossible."; return; }
  current = { code: data.reservation.code, phone, canSettle: true };
  $("form").hidden = true;
  $("ticket").hidden = false;
  $("code").textContent = data.reservation.code;
  await showStatus();
  timer = setInterval(showStatus, 3000);
});

$("settle").addEventListener("click", async () => {
  // Démonstration seulement : la route n'existe qu'avec l'opérateur simulé ; l'identifiant interne n'est pas connu du passager, on passe par le code.
  const res = await post("/api/demo/sva/settle-by-code", { code: current.code, phone: current.phone });
  if (res.status === 404) current.canSettle = false;
  await showStatus();
});

$("cancel").addEventListener("click", async () => {
  await post("/api/passenger/reservations/cancel", { code: current.code, phone: current.phone });
  await showStatus();
});

boot();
