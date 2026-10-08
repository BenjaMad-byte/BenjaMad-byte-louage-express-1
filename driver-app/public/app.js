// Application chauffeur (PWA). Tout texte passe par textContent : aucune donnée n'est insérée comme du HTML.
import { openStore } from "./store.js";
import { createSync } from "./sync.js";
import { applyLocal, rebase, queueInfo } from "./local.js";
import * as E from "./engine.js";
import { DICT } from "./i18n.js";

const root = document.getElementById("app");
const netBar = document.getElementById("net");
const toastEl = document.getElementById("toast");

let store;
let sync;
let lang = "ar";
let server = null; // dernier état connu du serveur
let view = null; // état affiché : serveur + actions pas encore envoyées
let pendingCount = 0;
let pendingIds = new Set(); // identifiants des actions pas encore envoyées
let online = navigator.onLine;
let token = null;
let installEvent = null;
let sosPanel = null; // { id, at } : alerte déclenchée sur cet appareil
let geoGranted = false;
let lastPos = null; // { lat, lon, accuracy, at }
let authScreen = "login"; // "login" | "recover"
let loginStep = { plate: "", busy: false, error: "" };
let recoverStep = { stage: "phone", phone: "", busy: false, error: "" };
let activationStep = null; // null, ou { token, stage: "loading"|"form"|"error", name, plate, error, busy } pendant l'activation via lien SMS

export const t = (key, vars = {}) => String(DICT[lang][key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const vibrate = (ms = 25) => { try { navigator.vibrate?.(ms); } catch { /* non disponible */ } };

// ---------------------------------------------------------------- langue, messages
function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.title = t("app_title");
}
let toastTimer;
function toast(message, kind = "info") {
  toastEl.textContent = message;
  toastEl.className = `toast ${kind}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 5000);
}

// ---------------------------------------------------------------- état
async function recompute() {
  const pending = await sync.pending();
  pendingCount = pending.length;
  pendingIds = new Set(pending.map((a) => a.id)); // tout de suite : « SOS envoyé » ne doit JAMAIS s'afficher pour une alerte qui attend encore le réseau
  const rebased = server ? rebase(server, pending) : { state: null };
  view = rebased.state;
}

/**
 * Un geste du chauffeur : vérifié par le moteur local, écrit sur l'appareil, affiché tout de suite, puis envoyé dès que possible.
 * @returns {Promise<object|null>} l'action enregistrée, ou null si le moteur local la refuse (message affiché)
 */
async function act(type, payload = {}) {
  if (!view) return null;
  let refusal = null;
  const action = await sync.enqueue(type, payload, (a) => {
    const { result } = applyLocal(view, a);
    if (result.status === "rejected" || result.status === "conflict_rejected") { refusal = result.reason; return false; }
    return true;
  });
  if (!action) {
    toast(t(`r_${refusal}`) === `r_${refusal}` ? t("r_unknown") : t(`r_${refusal}`), "warn");
    vibrate([60, 40, 60]);
    return null;
  }
  vibrate();
  await recompute();
  render();
  sync.flush().then(() => {}, () => {});
  return action;
}

function onUpdate({ state }) {
  server = state;
  recompute().then(render);
}
async function onAuthLost() {
  token = null;
  server = null;
  view = null;
  authScreen = "login";
  toast(t("session_lost"), "warn");
  render();
}
function onRejected(results) {
  const reasons = [...new Set(results.map((r) => r.reason))];
  toast(`${t("sync_refused")} ${reasons.map((r) => t(`r_${r}`) === `r_${r}` ? r : t(`r_${r}`)).join(", ")}`, "warn");
}

// ---------------------------------------------------------------- réseau
function renderNet() {
  const label = online ? t("net_online") : t("net_offline");
  const parts = [label];
  if (pendingCount) parts.push(t("net_pending", { n: pendingCount }));
  netBar.className = `netbar ${online ? "on" : "off"}`;
  netBar.replaceChildren(h("span", { class: "dot", "aria-hidden": "true" }), parts.join(" · "));
}
function setOnline(v) {
  online = v;
  renderNet();
  if (v && token) sync.flush().then(() => {}, () => {});
}

// ---------------------------------------------------------------- position (SOS)
async function refreshGeoPermission() {
  try {
    const p = await navigator.permissions?.query({ name: "geolocation" });
    geoGranted = p?.state === "granted";
    if (p) p.onchange = () => { geoGranted = p.state === "granted"; render(); };
  } catch { geoGranted = false; }
}
function getPosition(timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => { lastPos = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() }; geoGranted = true; resolve(lastPos); },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 }
    );
  });
}

// ---------------------------------------------------------------- SOS : 3 appuis rapprochés
let sosTaps = [];
function onSosTap() {
  const t0 = Date.now();
  sosTaps = [...sosTaps.filter((x) => t0 - x < 1500), t0];
  vibrate(20);
  renderSosDots();
  if (sosTaps.length >= 3) { sosTaps = []; triggerSos("triple_tap"); }
}
async function triggerSos(trigger) {
  vibrate([200, 80, 200]);
  sosPanel = { id: null, at: Date.now(), waiting: true };
  render();
  const fix = (await getPosition()) ?? lastPos;
  const payload = { trigger, ...(fix ? { lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy, ageS: Math.max(0, Math.round((Date.now() - fix.at) / 1000)) } : {}) };
  const action = await sync.enqueue("sos", payload); // jamais refusé par le moteur local : le SOS passe toujours
  sosPanel = { id: action.id, at: Date.now(), waiting: false };
  await store.set("sos", sosPanel);
  await recompute();
  render();
  sync.flush().then(() => render(), () => {});
}
function renderSosDots() {
  const dots = document.querySelector(".sos-dots");
  if (dots) dots.replaceChildren(...[0, 1, 2].map((i) => h("i", { class: i < sosTaps.length ? "on" : "" })));
}

// ---------------------------------------------------------------- composants
const stopLabel = (trip, i) => trip.stops[i];
const confirmTimers = new Map();
/** Bouton à double appui : le premier appui demande confirmation (3 s), le second exécute. Évite les gestes accidentels sur une route. */
function confirmButton(id, label, confirmLabel, onConfirm, cls = "btn") {
  const armed = confirmTimers.has(id);
  return h("button", { type: "button", class: `${cls}${armed ? " armed" : ""}`, onclick: () => {
    if (confirmTimers.has(id)) { clearTimeout(confirmTimers.get(id)); confirmTimers.delete(id); vibrate(); onConfirm(); return; }
    confirmTimers.set(id, setTimeout(() => { confirmTimers.delete(id); render(); }, 3000));
    vibrate(15);
    render();
  } }, armed ? confirmLabel : label);
}

function seatsPanel(trip) {
  const s = trip.summary;
  return h("section", { class: "seats", "aria-live": "polite" },
    h("div", { class: "label" }, t("seats_taken")),
    h("div", { class: `big ${s.full ? "full" : ""}`, id: "seats" }, h("bdi", {}, `${s.onboardNow + s.reservedNow} / ${trip.capacity}`)),
    s.reservedNow ? h("div", { class: "note" }, t("seats_reserved", { n: s.reservedNow })) : null,
    s.full ? h("div", { class: "badge full" }, t("seats_full")) : null);
}

function stopsStrip(trip) {
  const free = E.freeFrom(trip);
  return h("ol", { class: "stops", "aria-label": t("stops") },
    trip.stops.map((name, i) => h("li", { class: i === trip.currentStop && trip.status === "en_route" ? "here" : i < trip.currentStop ? "past" : "" },
      h("span", { class: "name" }, name),
      i < trip.stops.length - 1 ? h("span", { class: "free" }, t("free_from", { n: free[i] })) : null)));
}

function passengerList(trip) {
  const onboard = trip.boardings.filter((b) => b.status === "onboard" || b.status === "reserved");
  if (!onboard.length) return null;
  return h("details", { class: "pax" },
    h("summary", {}, t("passengers", { n: onboard.length })),
    h("ul", {}, onboard.map((b) => h("li", { class: b.status },
      h("span", {}, `${trip.stops[b.from]} → ${trip.stops[b.to]}`, b.status === "reserved" ? ` · ${t("pax_reserved")}` : b.source === "reservation" ? ` · ${t("pax_online")}` : "", b.code ? h("strong", { class: "code" }, " ", t("pax_code"), " ", h("bdi", {}, b.code)) : null),
      b.status === "reserved"
        ? h("button", { type: "button", class: "mini", onclick: () => act("confirm_boarding", { boardingId: b.id }) }, t("pax_arrived"))
        : trip.status === "en_route" && trip.currentStop > b.from && trip.currentStop < b.to
          ? h("button", { type: "button", class: "mini", onclick: () => act("alight", { boardingId: b.id, at: trip.currentStop }) }, t("pax_leaves_here"))
          : null))));
}

/** Choisir une autre destination que le terminus pour un passager (descente en route). */
function otherDestination(trip) {
  const options = [];
  for (let to = trip.currentStop + 1; to < trip.stops.length - 1; to++) options.push(to);
  if (!options.length) return null;
  return h("details", { class: "other" },
    h("summary", {}, t("board_other")),
    h("div", { class: "row" }, options.map((to) => h("button", { type: "button", class: "mini", onclick: () => act("board", { from: trip.currentStop, to }) }, `→ ${trip.stops[to]}`))));
}

// ---------------------------------------------------------------- écrans
function header() {
  const d = view.driver;
  return h("header", { class: "top" },
    h("div", {}, h("strong", {}, d.name), h("div", { class: "note" }, h("bdi", {}, d.plate), " · ", `${d.line.from} → ${d.line.toGov ?? t("free_destination")}`)),
    h("div", { class: "top-actions" },
      h("button", { type: "button", class: "mini", onclick: toggleLang }, t("lang_other")),
      h("button", { type: "button", class: "mini", onclick: logout }, t("logout"))));
}

function homeScreen() {
  const d = view.driver;
  return [
    h("section", { class: "card" },
      h("h1", {}, t("home_title")),
      h("p", { class: "note" }, t("home_hint")),
      h("div", { class: "field" }, h("label", { for: "cap" }, t("capacity")),
        h("select", { id: "cap", onchange: (e) => act("set_capacity", { capacity: Number(e.target.value) }) }, Array.from({ length: 20 }, (_, i) => i + 1).map((n) => h("option", { value: n, selected: n === d.capacity }, n)))),
      h("p", { class: "note" }, `${t("stops")} : ${view.defaultStops.join(" → ")}`),
      h("button", { type: "button", class: "btn primary huge", id: "join", onclick: () => act("join_queue") }, t("join_queue")),
      geoGranted ? null : h("button", { type: "button", class: "btn secondary", onclick: async () => { await getPosition(8000); render(); } }, t("allow_position")),
      geoGranted ? null : h("p", { class: "note" }, t("allow_position_why"))),
  ];
}

function queueScreen(trip) {
  const info = queueInfo(view);
  const provisional = trip.provisional;
  return [
    h("section", { class: "card rank" },
      h("div", { class: "label" }, t("your_rank")),
      h("div", { class: "big", id: "rank" }, provisional || !info ? "…" : h("bdi", {}, `#${info.rank}`)),
      provisional ? h("div", { class: "note" }, t("rank_pending")) : info ? h("div", { class: "note" }, info.rank === 1 ? t("rank_first") : t("rank_ahead", { n: info.ahead })) : null),
    seatsPanel(trip),
    h("button", { type: "button", class: "btn primary huge", id: "board", onclick: () => act("board") }, t("board_one")),
    otherDestination(trip),
    stopsStrip(trip),
    passengerList(trip),
    h("div", { class: "row two" },
      confirmButton("depart", t("depart"), t("press_again"), () => act("depart"), "btn go"),
      trip.boardings.some((b) => b.status === "onboard") ? null : confirmButton("leave", t("leave_queue"), t("press_again"), () => act("leave_queue"), "btn secondary")),
  ];
}

function routeScreen(trip) {
  const next = trip.currentStop + 1;
  const last = next >= trip.stops.length;
  return [
    h("section", { class: "card rank" },
      h("div", { class: "label" }, t("en_route")),
      h("div", { class: "big small", id: "here" }, trip.stops[trip.currentStop] ?? ""),
      !last ? h("div", { class: "note" }, `${t("next_stop")} : ${stopLabel(trip, next)}`) : null),
    seatsPanel(trip),
    h("button", { type: "button", class: "btn primary huge", id: "board", onclick: () => act("board") }, t("board_one")),
    otherDestination(trip),
    !last ? h("button", { type: "button", class: "btn", id: "arrive", onclick: () => act("arrive", { stop: next }) }, t("arrived_at", { stop: stopLabel(trip, next) })) : null,
    stopsStrip(trip),
    passengerList(trip),
    confirmButton("finish", t("finish_trip"), t("press_again"), () => act("finish"), "btn secondary"),
  ];
}

function sosOverlay() {
  if (!sosPanel) return null;
  const sent = sosPanel.id && !pendingHas(sosPanel.id);
  const call = (view?.emergency ?? []).map((e) => h("a", { class: "btn call", href: `tel:${e.number}` }, t("call", { label: e.label, number: e.number })));
  return h("div", { class: "sos-overlay", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "sos-title" },
    h("h2", { id: "sos-title" }, sosPanel.waiting ? t("sos_sending") : sent ? t("sos_sent") : t("sos_queued")),
    sosPanel.waiting ? null : h("p", {}, sent ? t("sos_sent_hint") : t("sos_queued_hint")),
    h("div", { class: "calls" }, call),
    sosPanel.id ? h("button", { type: "button", class: "btn secondary", onclick: async () => { await act("sos_cancel", { target: sosPanel.id }); await closeSos(); } }, t("sos_cancel")) : null,
    h("button", { type: "button", class: "btn secondary", onclick: closeSos }, t("sos_close")));
}
const pendingHas = (id) => pendingIds.has(id);
async function closeSos() { sosPanel = null; await store.del("sos"); render(); }

function sosButton() {
  return h("footer", { class: "sosbar" },
    h("button", { type: "button", class: "sos", id: "sos", onclick: onSosTap, onkeydown: (e) => { if (e.key === "Enter") e.preventDefault(); } },
      h("span", {}, t("sos_button")), h("span", { class: "sos-dots", "aria-hidden": "true" }, [0, 1, 2].map(() => h("i")))),
    h("small", {}, t("sos_hint")));
}

// ---------------------------------------------------------------- connexion : matricule + mot de passe
function errMessage(code) { return t(`e_${code}`) === `e_${code}` ? t("e_server") : t(`e_${code}`); }

function loginScreen() {
  const s = loginStep;
  const form = h("form", { class: "card", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (s.busy) return;
    const plate = document.getElementById("plate").value; // lus AVANT de redessiner le formulaire
    const password = document.getElementById("password").value;
    s.plate = plate;
    s.busy = true; s.error = ""; renderLoginOnly();
    try {
      const r = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plate, password, device: navigator.userAgent.slice(0, 80) }) });
      const data = await r.json().catch(() => ({}));
      if (r.ok) return await onLoggedIn(data.plate, data.token);
      s.error = data.error ?? "server";
    } catch { s.error = "network"; }
    s.busy = false;
    renderLoginOnly();
  } },
    h("h1", {}, t("login_title")),
    h("div", { class: "field" }, h("label", { for: "plate" }, t("login_plate")), h("input", { id: "plate", dir: "ltr", autocomplete: "username", maxlength: "20", required: true, value: s.plate })),
    h("div", { class: "field" }, h("label", { for: "password" }, t("login_password")), h("input", { id: "password", type: "password", autocomplete: "current-password", required: true })),
    s.error ? h("div", { class: "err", role: "alert" }, errMessage(s.error)) : null,
    h("button", { type: "submit", class: "btn primary", disabled: s.busy }, t("login_go")),
    h("button", { type: "button", class: "mini", onclick: () => { recoverStep = { stage: "phone", phone: "", busy: false, error: "" }; authScreen = "recover"; render(); } }, t("login_forgot")),
    installEvent ? h("button", { type: "button", class: "btn secondary", onclick: async () => { installEvent.prompt(); await installEvent.userChoice.catch(() => {}); installEvent = null; renderLoginOnly(); } }, t("install")) : null,
    h("button", { type: "button", class: "mini", onclick: toggleLang }, t("lang_other")));
  return [form];
}
function renderLoginOnly() { render(); document.getElementById("plate")?.focus(); }

// ---------------------------------------------------------------- activation (lien personnel reçu par SMS à l'acceptation)
async function startActivation(activationToken) {
  history.replaceState(null, "", "/"); // le jeton ne doit pas rester dans l'historique ; « /activer » n'est qu'un point d'entrée, l'app vit sur « / » (seule servie hors ligne par le service worker)
  activationStep = { token: activationToken, stage: "loading", name: "", plate: "", error: "", busy: false };
  render();
  try {
    const r = await fetch("/api/auth/activation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: activationToken }) });
    const data = await r.json().catch(() => ({}));
    activationStep = r.ok ? { ...activationStep, stage: "form", name: data.name, plate: data.plate } : { ...activationStep, stage: "error", error: data.error ?? "server" };
  } catch { activationStep = { ...activationStep, stage: "error", error: "network" }; }
  render();
}
function activationScreen() {
  const s = activationStep;
  if (s.stage === "loading") return [h("section", { class: "card" }, h("p", {}, t("loading")))];
  if (s.stage === "error") {
    return [h("section", { class: "card" },
      h("h1", {}, t("activation_title")),
      h("div", { class: "err", role: "alert" }, errMessage(s.error)),
      h("button", { type: "button", class: "btn secondary", onclick: () => { activationStep = null; render(); } }, t("login_title")))];
  }
  const form = h("form", { class: "card", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (s.busy) return;
    const password = document.getElementById("newpw").value;
    s.busy = true; s.error = ""; render();
    try {
      const r = await fetch("/api/auth/activation/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: s.token, password, device: navigator.userAgent.slice(0, 80) }) });
      const data = await r.json().catch(() => ({}));
      if (r.ok) { activationStep = null; return await onLoggedIn(data.plate, data.token); }
      s.error = data.reason ?? data.error ?? "server";
    } catch { s.error = "network"; }
    s.busy = false;
    render();
  } },
    h("h1", {}, t("activation_title")),
    h("p", { class: "note" }, t("activation_hello", { name: s.name, plate: s.plate })),
    h("div", { class: "field" }, h("label", { for: "newpw" }, t("activation_password")), h("input", { id: "newpw", type: "password", autocomplete: "new-password", minlength: "6", required: true })),
    s.error ? h("div", { class: "err", role: "alert" }, errMessage(s.error)) : null,
    h("button", { type: "submit", class: "btn primary", disabled: s.busy }, t("activation_go")));
  return [form];
}

// ---------------------------------------------------------------- mot de passe oublié : code SMS puis nouveau mot de passe
function recoverScreen() {
  const s = recoverStep;
  if (s.stage === "phone") {
    const form = h("form", { class: "card", novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      if (s.busy) return;
      const phone = document.getElementById("rphone").value;
      s.phone = phone;
      s.busy = true; s.error = ""; render();
      try {
        const r = await fetch("/api/auth/recover/send-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, lang }) });
        const data = await r.json().catch(() => ({}));
        if (r.ok || data.error === "otp_cooldown") s.stage = "reset"; else s.error = data.error ?? "server";
      } catch { s.error = "network"; }
      s.busy = false;
      render();
    } },
      h("h1", {}, t("recover_title")),
      h("div", { class: "field" }, h("label", { for: "rphone" }, t("recover_phone")), h("input", { id: "rphone", type: "tel", inputmode: "numeric", autocomplete: "tel-national", dir: "ltr", maxlength: "20", required: true, value: s.phone })),
      s.error ? h("div", { class: "err", role: "alert" }, errMessage(s.error)) : null,
      h("button", { type: "submit", class: "btn primary", disabled: s.busy }, t("recover_send")),
      h("button", { type: "button", class: "mini", onclick: () => { authScreen = "login"; render(); } }, t("recover_back")));
    return [form];
  }
  const form = h("form", { class: "card", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (s.busy) return;
    const code = document.getElementById("rcode").value;
    const password = document.getElementById("rpassword").value;
    s.busy = true; s.error = ""; render();
    try {
      const r = await fetch("/api/auth/recover/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: s.phone, code, password, device: navigator.userAgent.slice(0, 80) }) });
      const data = await r.json().catch(() => ({}));
      if (r.ok) { authScreen = "login"; return await onLoggedIn(data.plate, data.token); }
      s.error = data.reason ?? data.error ?? "server";
    } catch { s.error = "network"; }
    s.busy = false;
    render();
  } },
    h("h1", {}, t("recover_title")),
    h("div", { class: "field" }, h("label", { for: "rcode" }, t("recover_code")), h("input", { id: "rcode", inputmode: "numeric", autocomplete: "one-time-code", dir: "ltr", maxlength: "6", required: true })),
    h("div", { class: "field" }, h("label", { for: "rpassword" }, t("recover_password")), h("input", { id: "rpassword", type: "password", autocomplete: "new-password", minlength: "6", required: true })),
    s.error ? h("div", { class: "err", role: "alert" }, errMessage(s.error)) : null,
    h("button", { type: "submit", class: "btn primary", disabled: s.busy }, t("recover_go")),
    h("button", { type: "button", class: "mini", onclick: () => { authScreen = "login"; render(); } }, t("recover_back")));
  return [form];
}

async function onLoggedIn(plate, newToken) {
  const owner = await store.get("owner");
  if (owner && owner !== plate) {
    // Autre chauffeur sur cet appareil : les actions en attente de l'ancien ne doivent JAMAIS partir sous le nouveau compte.
    await store.clearAll();
    await store.set("lang", lang);
  }
  await store.set("owner", plate);
  await store.set("token", newToken);
  token = newToken;
  loginStep = { plate: "", busy: false, error: "" };
  await sync.flush();
  server = await store.get("server");
  await recompute();
  render();
}

async function logout() {
  if (pendingCount && !confirm(t("logout_pending", { n: pendingCount }))) return;
  try { await fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }); } catch { /* hors ligne : la session expirera seule */ }
  await store.clearAll();
  await store.set("lang", lang);
  token = null; server = null; view = null; sosPanel = null; pendingCount = 0;
  authScreen = "login";
  render();
}

async function toggleLang() {
  lang = lang === "ar" ? "fr" : "ar";
  await store.set("lang", lang);
  applyLang();
  render();
}

// ---------------------------------------------------------------- rendu
export function render() {
  renderNet();
  if (!token) {
    if (activationStep) { root.replaceChildren(...activationScreen()); return; }
    root.replaceChildren(...(authScreen === "recover" ? recoverScreen() : loginScreen()));
    return;
  }
  if (!view) { root.replaceChildren(h("p", { class: "card" }, t("loading"))); return; }
  const trip = view.trip;
  // sosOverlay() peut renvoyer null : replaceChildren ne filtre pas ses arguments comme le fait h(), un null littéral deviendrait le texte « null ».
  root.replaceChildren(...[
    header(),
    h("div", { class: "screen", "data-screen": !trip ? "home" : trip.status === "en_route" ? "route" : "queue" }, ...(!trip ? homeScreen() : trip.status === "en_route" ? routeScreen(trip) : queueScreen(trip))),
    sosButton(),
    sosOverlay(),
  ].filter(Boolean));
}

// ---------------------------------------------------------------- démarrage
async function boot() {
  store = await openStore();
  lang = (await store.get("lang")) === "fr" ? "fr" : "ar";
  applyLang();
  sync = createSync({ store, onUpdate, onAuthLost, onRejected });
  token = await store.get("token");
  server = await store.get("server");
  sosPanel = await store.get("sos");
  await recompute();
  const jeton = new URLSearchParams(location.search).get("jeton");
  if (jeton && !token) await startActivation(jeton); else render();
  await refreshGeoPermission();

  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; if (!token) render(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && token) sync.flush().then(() => {}, () => {}); });
  setInterval(() => { if (token && !document.hidden) sync.flush().then(() => {}, () => {}); }, 20_000);
  try { await navigator.serviceWorker?.register("/sw.js"); } catch { /* sans service worker : fonctionne en ligne, pas d'ouverture hors ligne */ }
  if (token) sync.flush().then(() => {}, () => {});
  window.__lx = { act, get view() { return view; }, get pending() { return pendingCount; } }; // observé par les tests navigateur
}

boot();
