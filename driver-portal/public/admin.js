// Console d'administration (français). Aucune donnée utilisateur n'est insérée via innerHTML : tout passe par textContent.
import { GOVERNORATES } from "/i18n.js";
import { createAccounts } from "/admin-accounts.js";
import { createOps } from "/admin-ops.js";
const $ = (id) => document.getElementById(id);
const STATUS_LABEL = { pending: "En attente", interview: "Entretien", approved: "Accepté", rejected: "Refusé" };
const IV_LABEL = { booked: "réservé", done: "terminé", cancelled: "annulé" };
const SMS_KIND_LABEL = { status_approved: "dossier accepté", status_rejected: "dossier examiné (refus)", status_interview: "entretien proposé", interview_booked: "entretien confirmé", interview_reminder: "rappel d'entretien" };
const SMS_STATE_LABEL = { queued: "en attente d'envoi", sent: "envoyé", failed: "échec", skipped: "annulé (plus d'actualité)" };
const KIND_LABEL = { cin_front: "CIN recto", cin_back: "CIN verso", permis: "Permis", licence: "Licence", selfie_1: "Selfie 1", selfie_2: "Selfie 2", selfie_3: "Selfie 3" };
const KYC_LABEL = { queued: "En file", processing: "En cours", verified: "Vérifiée", review: "À examiner", skipped: "Non exécutée", error: "Erreur" };
const KYC_BADGE = { queued: "interview", processing: "interview", verified: "approved", review: "pending", skipped: "pending", error: "rejected" };
const REASON_LABEL = {
  moteur_biometrique_indisponible_fallback_non_fiable: "Moteur biométrique indisponible : le score visage ne prouve rien",
  face_match_score_insuffisant: "Correspondance du visage insuffisante",
  mouvement_insuffisant_entre_frames: "Vivacité non démontrée (pas de mouvement entre les photos)",
  frames_insuffisantes_pour_detecter_le_mouvement: "Vivacité non démontrée (pas assez de photos)",
  liveness_echec: "Vivacité non démontrée",
  cin_illisible_ou_absente: "Numéro de CIN illisible sur la photo",
  cin_ocr_ne_correspond_pas_a_la_saisie: "Le numéro lu sur la CIN ne correspond pas à celui saisi",
  cin_recto_non_image: "CIN recto envoyée en PDF : vérification automatique impossible",
  selfie_absent_ou_purge: "Selfies absents ou déjà supprimés",
};
const ERROR_LABEL = {
  backend_unreachable: "Backend KYC injoignable", backend_auth: "Clé de service refusée par le backend (KYC_SERVICE_KEY)",
  backend_rejected: "Requête refusée par le backend", internal_error: "Erreur interne du portail",
};

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) el.append(c instanceof Node ? c : document.createTextNode(String(c ?? "")));
  return el;
}

let token = sessionStorage.getItem("admin_token") || "";
let me = null; // { user: { username, display_name, role }, scope, needs, legacy }
let accountMode = false; // true dès qu'un compte existe : connexion par identifiant, mot de passe et code
const isOwner = () => me?.user?.role === "owner";

async function call(path, opts = {}) {
  const res = await fetch(`/api/admin${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (res.status === 401) { logout("Session expirée ou fermée : reconnectez-vous."); throw new Error("unauthorized"); }
  return res;
}

function logout(message = "") {
  token = "";
  me = null;
  sessionStorage.removeItem("admin_token");
  $("app").hidden = true;
  $("setup").hidden = true;
  $("gate").hidden = false;
  $("gate-err").textContent = message;
  showGateMode();
}

/** Le formulaire de connexion dépend de l'installation : jeton partagé tant qu'aucun compte n'existe, ensuite identifiant + mot de passe + code. */
async function showGateMode() {
  try {
    accountMode = (await (await fetch("/api/admin/mode")).json()).accounts === true;
  } catch { /* serveur injoignable : on garde l'état précédent */ }
  $("gate-token").hidden = accountMode;
  $("gate-account").hidden = !accountMode;
  $("token").required = !accountMode;
  $("username").required = accountMode;
  $("password").required = accountMode;
}


const fmtDate = (iso) => new Date(iso).toLocaleString("fr-FR", { timeZone: "Africa/Tunis", dateStyle: "short", timeStyle: "short" });
const ops = createOps({ $, h, call, fmtDate });
const accounts = createAccounts({ $, h, call, fmtDate, onReady: () => resume(), onFirstAccount: (message) => logout(message) });
const fmtSlot = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}`;

const LINE_LABEL = { regional: "Régional", interregional: "Interrégional", rural: "Rural", national: "National" };
const KYC_FILTER_LABEL = { review: "À examiner", verified: "Vérifiée", error: "Erreur", queued: "En file", processing: "En cours", skipped: "Non exécutée", none: "Aucune vérification" };
const DEFAULT_FILTERS = { status: "", governorate: "", line_type: "", kyc: "", sort: "created_desc", q: "", page: 1 };
let filters = { ...DEFAULT_FILTERS };
try { filters = { ...DEFAULT_FILTERS, ...JSON.parse(sessionStorage.getItem("admin_filters") || "{}"), q: "", page: 1 }; } catch { /* filtres illisibles : valeurs par défaut */ }
let currentRefs = []; // références de la page affichée, dans l'ordre : sert à passer au dossier suivant

function saveFilters() {
  try { sessionStorage.setItem("admin_filters", JSON.stringify({ ...filters, q: "" })); } catch { /* stockage indisponible */ }
}

function fillSelect(select, options, value) {
  select.replaceChildren(...options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
}

function renderControls({ counts, total, page, pages }) {
  const statusTotal = Object.values(counts.status).reduce((a, b) => a + b, 0);
  const chip = (value, label, n) =>
    h("button", {
      type: "button", class: "chip", "aria-pressed": String(filters.status === value),
      onclick: () => { filters.status = value; filters.page = 1; reload(); },
    }, label, h("span", { class: "chip-n" }, String(n)));
  $("status-chips").replaceChildren(chip("", "Tous", statusTotal), ...Object.entries(STATUS_LABEL).map(([v, l]) => chip(v, l, counts.status[v] ?? 0)));

  fillSelect($("f-kyc"), [["", "Toutes les identités"], ...Object.entries(KYC_FILTER_LABEL).map(([v, l]) => [v, counts.kyc[v] ? `${l} (${counts.kyc[v]})` : l])], filters.kyc);
  $("f-sort").value = filters.sort;
  $("f-line").value = filters.line_type;
  $("f-gov").value = filters.governorate;

  const active = ["status", "governorate", "line_type", "kyc", "q"].filter((k) => filters[k]).length;
  $("apps-summary").textContent = `${total} dossier${total > 1 ? "s" : ""}${active ? ` avec ${active} filtre${active > 1 ? "s" : ""}` : ""}`;
  $("f-reset").hidden = active === 0;
  $("pager").hidden = pages <= 1;
  $("pg-info").textContent = `Page ${page} sur ${pages}`;
  $("pg-prev").disabled = page <= 1;
  $("pg-next").disabled = page >= pages;
}

async function loadApps() {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v !== "" && v != null && !(k === "page" && v === 1)) params.set(k, String(v));
  const res = await call(`/applications?${params}`);
  if (res.status === 400) { filters = { ...DEFAULT_FILTERS }; saveFilters(); return loadApps(); }
  const data = await res.json();
  if (filters.page > data.pages) { filters.page = data.pages; return loadApps(); } // la page demandée n'existe plus (dossiers supprimés)
  renderControls(data);
  currentRefs = data.applications.map((a) => a.ref);
  const body = $("apps").querySelector("tbody");
  body.replaceChildren(
    ...data.applications.map((a) =>
      h("tr", { "data-ref": a.ref, tabindex: "0", onclick: () => openDetail(a.ref), onkeydown: (e) => { if (e.key === "Enter") openDetail(a.ref); } },
        h("td", { class: "mono" }, a.ref), h("td", {}, a.full_name), h("td", { class: "mono" }, a.phone),
        h("td", {}, a.governorate),
        h("td", {}, a.line_type ? h("span", { class: "tag" }, LINE_LABEL[a.line_type]) : null, a.line_type ? " " : "", a.route),
        h("td", {}, h("span", { class: `badge ${a.status}` }, STATUS_LABEL[a.status])),
        h("td", {}, a.kyc_status ? h("span", { class: `badge ${KYC_BADGE[a.kyc_status]}` }, KYC_LABEL[a.kyc_status]) : "—"),
        h("td", {}, fmtDate(a.created_at))))
  );
  $("apps-empty").hidden = data.applications.length > 0;
}

/** Applique un changement de filtre : retour à la première page, mémorisation, rechargement. */
function reload() {
  saveFilters();
  loadApps().catch(() => {});
}

/** Dossier voisin dans la liste affichée (delta = +1 suivant, -1 précédent), ou null. */
const neighbour = (ref, delta) => currentRefs[currentRefs.indexOf(ref) + delta] ?? null;

function kycBlock(ref, k, msg) {
  if (!k) return null;
  const rows = [["Statut", h("span", { class: `badge ${KYC_BADGE[k.status]}` }, KYC_LABEL[k.status])]];
  if (k.face_score != null) {
    rows.push(["Correspondance du visage", `${(k.face_score * 100).toFixed(1)} % — moteur : ${k.face_provider}${k.real_biometric ? "" : " (PAS une vraie biométrie)"}`]);
  }
  if (k.liveness_passed != null) rows.push(["Vivacité", k.liveness_passed ? "Mouvement détecté entre les photos" : "Non démontrée"]);
  if (k.cin_match != null) rows.push(["CIN lue = CIN saisie", k.cin_match ? "Oui" : "Non"]);
  if (k.error) rows.push(["Erreur", `${ERROR_LABEL[k.error] || k.error} (tentatives : ${k.attempts})`]);
  return h("div", {},
    h("div", { class: "label" }, "Vérification d'identité"),
    h("dl", {}, rows.flatMap(([a, b]) => [h("dt", {}, a), h("dd", {}, b)])),
    k.reasons.length ? h("ul", {}, k.reasons.map((r) => h("li", {}, REASON_LABEL[r] || r))) : null,
    k.status === "verified" ? h("p", { class: "note" }, "Recommandation : identité cohérente. La décision d'accepter reste la vôtre (licence, véhicule, entretien).") : null,
    h("p", { class: "note" }, "Aide à la décision uniquement : l'acceptation n'est jamais automatique."),
    h("button", {
      type: "button", class: "btn secondary small", onclick: async () => {
        const r = await call(`/applications/${encodeURIComponent(ref)}/kyc/retry`, { method: "POST" });
        if (r.status === 409) msg.textContent = "Relance impossible : les selfies ont déjà été supprimés.";
        else if (r.ok) { msg.textContent = "Vérification relancée."; setTimeout(() => openDetail(ref), 2500); }
      },
    }, "Relancer la vérification"));
}

async function openDoc(id) {
  const res = await call(`/files/${id}`);
  if (!res.ok) return;
  const blob = await res.blob();
  window.open(URL.createObjectURL(blob), "_blank", "noopener");
}

async function openDetail(ref) {
  const res = await call(`/applications/${encodeURIComponent(ref)}`);
  if (!res.ok) return;
  const { application: a, files, interviews, kyc, notifications = [] } = await res.json();
  document.querySelectorAll("#apps tbody tr").forEach((tr) => tr.setAttribute("aria-selected", String(tr.dataset.ref === ref)));

  const status = h("select", { id: "d-status" }, Object.entries(STATUS_LABEL).map(([v, l]) => h("option", { value: v, selected: v === a.status }, l)));
  const pub = h("textarea", { id: "d-public", maxlength: "300" }, a.public_note || "");
  const priv = h("textarea", { id: "d-admin", maxlength: "1000" }, a.admin_note || "");
  const msg = h("div", { class: "note", role: "status" });
  const ended = h("input", { type: "checkbox", id: "d-ended", checked: Boolean(a.ended_at) });
  const notify = h("input", { type: "checkbox", id: "d-notify", checked: true });

  const info = [
    ["Référence", a.ref], ["Nom", a.full_name], ["Téléphone", a.phone], ["CIN", a.cin],
    ["Immatriculation", a.plate], ["Gouvernorat", a.governorate], ["Station", a.station], ["Ligne", a.route],
    ["Prend des passagers en route", a.pickup_en_route ? "Oui" : "Non"], ["Part parfois incomplet", a.leaves_partial ? "Oui" : "Non"],
    ["Consentement", fmtDate(a.consent_at)], ["Langue", a.lang],
  ];
  const idx = currentRefs.indexOf(ref);
  const nav = idx < 0 ? null : h("div", { class: "detail-nav" },
    h("button", { type: "button", class: "btn secondary small", disabled: !neighbour(ref, -1), onclick: () => openDetail(neighbour(ref, -1)) }, "← Précédent"),
    h("span", { class: "note" }, `Dossier ${idx + 1} sur ${currentRefs.length} (cette page)`),
    h("button", { type: "button", class: "btn secondary small", disabled: !neighbour(ref, 1), onclick: () => openDetail(neighbour(ref, 1)) }, "Suivant →"));
  const save = async (andNext) => {
    const next = andNext ? neighbour(ref, 1) ?? neighbour(ref, -1) : null;
    const r = await call(`/applications/${encodeURIComponent(ref)}`, { method: "PATCH", body: JSON.stringify({ status: status.value, public_note: pub.value, admin_note: priv.value, notify: notify.checked, ...(status.value === "approved" ? { ended: ended.checked } : {}) }) });
    const out = r.ok ? await r.json() : null;
    msg.textContent = !r.ok ? "Échec de l'enregistrement." : out.notified ? "Enregistré. SMS mis en file pour le chauffeur." : "Enregistré.";
    if (!r.ok) return;
    await loadApps();
    if (next && currentRefs.includes(next)) openDetail(next);
    else if (andNext) $("detail").hidden = true; // plus de dossier suivant dans cette liste
  };
  $("detail").replaceChildren(
    nav,
    h("h2", {}, a.full_name),
    h("dl", {}, info.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    h("div", {}, h("div", { class: "label" }, "Documents"),
      h("div", { class: "doc-actions" },
        files.length ? files.map((f) => h("button", { type: "button", class: "btn secondary small", onclick: () => openDoc(f.id) }, KIND_LABEL[f.kind] || f.kind)) : "Aucun")),
    kycBlock(ref, kyc, msg),
    notifications.length
      ? h("div", {}, h("div", { class: "label" }, "SMS au chauffeur"),
          notifications.map((n) => h("div", {}, `${SMS_KIND_LABEL[n.kind] || n.kind} — ${SMS_STATE_LABEL[n.status] || n.status}${n.sent_at ? ` (${fmtDate(n.sent_at)})` : ""}`)))
      : null,
    interviews.length
      ? h("div", {}, h("div", { class: "label" }, "Entretiens"),
          interviews.map((i) => h("div", {}, `${fmtSlot(i.slot_start)} — ${IV_LABEL[i.status] || i.status}${i.question ? ` — « ${i.question} »` : ""}`)))
      : null,
    h("div", { class: "row" },
      h("label", { for: "d-status" }, "Statut"), status,
      h("label", { for: "d-notify", class: "check" }, notify, " Prévenir le chauffeur par SMS si le statut change (à décocher pour corriger une erreur)"),
      h("label", { for: "d-ended", class: "check" }, ended, " Collaboration terminée (chauffeur accepté : lance le délai de suppression de ses données)"),
      h("label", { for: "d-public" }, "Message visible par le chauffeur"), pub,
      h("label", { for: "d-admin" }, "Note interne (jamais affichée au chauffeur)"), priv,
      h("div", { class: "doc-actions" },
        h("button", { type: "button", class: "btn small", onclick: () => save(false) }, "Enregistrer"),
        idx >= 0 ? h("button", { type: "button", class: "btn small", onclick: () => save(true) }, "Enregistrer et passer au suivant") : null,
        !isOwner() ? null : h("button", {
          type: "button", class: "btn secondary small danger", onclick: async () => {
            if (!confirm(`Supprimer définitivement la demande ${ref} et ses documents ?`)) return;
            const r = await call(`/applications/${encodeURIComponent(ref)}`, { method: "DELETE" });
            if (r.ok) { $("detail").hidden = true; loadApps(); }
          },
        }, "Supprimer (données + documents)")),
      msg)
  );
  $("detail").hidden = false;
  $("detail").scrollIntoView({ block: "nearest" });
}

async function loadInterviews() {
  const res = await call("/interviews");
  const { interviews } = await res.json();
  $("ivs").querySelector("tbody").replaceChildren(
    ...interviews.map((i) =>
      h("tr", {},
        h("td", {}, fmtSlot(i.slot_start)), h("td", {}, i.name), h("td", { class: "mono" }, i.phone), h("td", {}, i.question || "—"),
        h("td", {}, h("a", { href: i.room_url, target: "_blank", rel: "noopener noreferrer" }, "Ouvrir")),
        h("td", { class: "doc-actions" },
          ["done", "cancelled"].map((s) =>
            h("button", {
              type: "button", class: "btn secondary small", onclick: async () => {
                await call(`/interviews/${i.id}`, { method: "PATCH", body: JSON.stringify({ status: s }) });
                loadInterviews();
              },
            }, s === "done" ? "Terminé" : "Annuler"))))));
  $("ivs-empty").hidden = interviews.length > 0;
}

const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;
const nameWithArabic = (fr, ar) => (ar ? `${fr} (${ar})` : fr);
const lineItem = (l) => {
  const bits = [plural(l.drivers, "chauffeur")];
  if (l.approved) bits.push(plural(l.approved, "accepté"));
  if (l.pickup) bits.push(`${l.pickup} ${l.pickup > 1 ? "prennent" : "prend"} des passagers en route`);
  if (l.partial) bits.push(`${l.partial} ${l.partial > 1 ? "partent" : "part"} parfois incomplet${l.partial > 1 ? "s" : ""}`);
  const origin = nameWithArabic(l.from, l.from_ar);
  return h("li", {}, l.type === "national" ? `${origin} → tous les gouvernorats` : `${origin} → ${l.to_gov}`,
    l.recognized ? null : h("span", { class: "tag warn", title: "Cette ville n'est pas dans la liste des délégations : orthographe à vérifier, ou village / quartier" }, "non reconnue"),
    h("span", { class: "note" }, ` — ${bits.join(", ")}`),
    l.via.length ? h("div", { class: "note" }, `Arrêts en route : ${l.via.map((v) => `${nameWithArabic(v.city, v.city_ar)}${v.recognized ? "" : " ?"} (${v.drivers})`).join(", ")}`) : null);
};

async function loadNetwork() {
  const res = await call("/network");
  const { governorates, unclassified } = await res.json();
  const withLines = governorates.filter((g) => g.drivers > 0).length;
  const unknown = governorates.flatMap((g) => [...g.regional, ...g.interregional, ...g.national, ...g.rural]).filter((l) => !l.recognized).length;
  $("net-note").textContent = `${withLines} gouvernorat${withLines > 1 ? "s" : ""} sur 24 ont au moins un circuit déclaré.${unclassified ? ` ${unclassified} ancienne${unclassified > 1 ? "s" : ""} demande${unclassified > 1 ? "s" : ""} sans circuit structuré.` : ""}${unknown ? ` ${unknown} ville${unknown > 1 ? "s" : ""} de départ non reconnue${unknown > 1 ? "s" : ""} (repère « non reconnue »).` : ""}`;
  const list = (lines) => (lines.length ? h("ul", { class: "lines" }, lines.map((l) => lineItem(l))) : h("span", { class: "note" }, "—"));
  $("net").querySelector("tbody").replaceChildren(
    ...governorates.map((g) =>
      h("tr", { class: g.drivers ? "" : "empty-row" }, h("td", {}, g.governorate), h("td", {}, String(g.drivers)), h("td", {}, list(g.regional)), h("td", {}, list(g.interregional)), h("td", {}, list(g.national)), h("td", {}, list(g.rural)))));
}

async function downloadNetworkCsv() {
  const res = await call("/network.csv");
  if (!res.ok) return;
  const url = URL.createObjectURL(await res.blob());
  const a = h("a", { href: url, download: "reseau-louage.csv" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function tab(which) {
  const views = { apps: loadApps, ivs: loadInterviews, net: loadNetwork, acc: () => accounts.renderView(me), ops: () => ops.render() };
  for (const name of Object.keys(views)) {
    $(`tab-${name}`).setAttribute("aria-selected", String(name === which));
    $(`view-${name}`).hidden = name !== which;
  }
  views[which]().catch(() => {});
}

async function enter() {
  $("gate").hidden = true;
  $("setup").hidden = true;
  $("app").hidden = false;
  $("whoami").textContent = me.legacy ? "Jeton partagé (installation initiale)" : `${me.user.display_name} — ${me.user.role === "owner" ? "propriétaire" : "relecteur"}`;
  tab("apps");
  startSosWatch();
}

/** Alerte SOS non prise en charge : bannière rouge sur tous les onglets, vérifiée toutes les 20 s. */
let sosWatch = null;
let sosCheck = null;
function startSosWatch() {
  clearInterval(sosWatch);
  document.removeEventListener("lx-sos-changed", sosCheck);
  sosCheck = () => (token ? ops.pollBanner(() => tab("ops")).catch(() => {}) : clearInterval(sosWatch));
  sosCheck();
  sosWatch = setInterval(sosCheck, 20_000);
  document.addEventListener("lx-sos-changed", sosCheck);
}

/** Reprend une session existante : l'état du compte décide de l'écran (connexion, première connexion, console). */
async function resume() {
  if (!token) return showGateMode();
  const res = await fetch("/api/admin/me", { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) return logout();
  if (!res.ok) return;
  me = await res.json();
  if (me.scope === "setup") return accounts.showSetup(me.needs);
  enter();
}

$("gate").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (accountMode) {
    const res = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: $("username").value, password: $("password").value, code: $("code").value }) });
    if (res.status === 401) { $("gate-err").textContent = "Identifiants invalides (identifiant, mot de passe ou code)."; return; }
    if (res.status === 403) { $("gate-err").textContent = "Accès refusé depuis cette adresse."; return; }
    if (res.status === 429) { $("gate-err").textContent = "Trop d'essais. Réessayez dans 15 minutes."; return; }
    if (!res.ok) { $("gate-err").textContent = "Erreur serveur."; return; }
    token = (await res.json()).token;
    sessionStorage.setItem("admin_token", token);
    $("gate-err").textContent = "";
    for (const id of ["password", "code"]) $(id).value = "";
    resume();
    return;
  }
  token = $("token").value.trim();
  const res = await fetch("/api/admin/applications", { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { $("gate-err").textContent = "Jeton invalide."; return; }
  if (res.status === 403) { $("gate-err").textContent = "Accès refusé depuis cette adresse."; return; }
  if (res.status === 429) { $("gate-err").textContent = "Trop d'essais. Réessayez dans 15 minutes."; return; }
  if (!res.ok) { $("gate-err").textContent = "Erreur serveur."; return; }
  $("gate-err").textContent = "";
  sessionStorage.setItem("admin_token", token);
  $("token").value = "";
  resume();
});
$("logout").addEventListener("click", async () => {
  if (token) await fetch("/api/admin/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  logout();
});
$("tab-apps").addEventListener("click", () => tab("apps"));
$("tab-ivs").addEventListener("click", () => tab("ivs"));
$("tab-net").addEventListener("click", () => tab("net"));
$("tab-acc").addEventListener("click", () => tab("acc"));
$("tab-ops").addEventListener("click", () => tab("ops"));
$("net-csv").addEventListener("click", () => downloadNetworkCsv().catch(() => {}));
fillSelect($("f-gov"), [["", "Tous les gouvernorats"], ...GOVERNORATES.map((g) => [g, g])], filters.governorate);
for (const [id, key] of [["f-gov", "governorate"], ["f-line", "line_type"], ["f-kyc", "kyc"], ["f-sort", "sort"]]) {
  $(id).addEventListener("change", (e) => { filters[key] = e.target.value; filters.page = 1; reload(); });
}
let debounce;
$("f-q").addEventListener("input", (e) => { clearTimeout(debounce); debounce = setTimeout(() => { filters.q = e.target.value; filters.page = 1; reload(); }, 250); });
$("f-reset").addEventListener("click", () => { filters = { ...DEFAULT_FILTERS }; $("f-q").value = ""; reload(); });
$("pg-prev").addEventListener("click", () => { filters.page = Math.max(1, filters.page - 1); reload(); });
$("pg-next").addEventListener("click", () => { filters.page += 1; reload(); });

resume();
