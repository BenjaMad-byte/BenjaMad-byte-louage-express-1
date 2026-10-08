import { DICT, GOVERNORATES, GOVERNORATES_AR } from "./i18n.js";

const safeStorage = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible : on continue sans */ } },
};

export const getLang = () => (safeStorage.get("lang") === "fr" ? "fr" : "ar");
export const t = (key) => DICT[getLang()][key] ?? key;

/** Création DOM sans innerHTML : tout texte passe par textContent. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export function applyI18n(root = document) {
  const lang = getLang();
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  root.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  const govNames = lang === "ar" ? GOVERNORATES_AR : GOVERNORATES;
  root.querySelectorAll("[data-i18n-gov]").forEach((el) => { el.textContent = govNames[Number(el.dataset.i18nGov)] ?? ""; });
  root.querySelectorAll("[data-i18n-alt]").forEach((el) => { el.alt = t(el.dataset.i18nAlt); });
  root.querySelectorAll("[data-i18n-label]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nLabel)); });
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  const titleKey = document.documentElement.dataset.title;
  if (titleKey) document.title = t(titleKey);
}

const NAV = [
  ["/", "nav_home"],
  ["/register", "nav_register"],
  ["/interview", "nav_interview"],
  ["/status", "nav_status"],
];

const LEGAL_LINKS = [["/privacy", "foot_privacy"], ["/terms", "foot_terms"], ["/legal", "foot_legal"]];

function renderHeader() {
  const host = document.getElementById("site-header");
  if (!host) return;
  host.replaceChildren(
    h("div", { class: "livery", "aria-hidden": "true" }),
    h("div", { class: "bar" },
      h("a", { class: "brand", href: "/" }, "Louage Express"),
      h("nav", { "aria-label": "Navigation" },
        NAV.map(([href, key]) =>
          h("a", { href, "aria-current": location.pathname.replace(/\.html$/, "").replace(/\/$/, "") === href.replace(/\/$/, "") ? "page" : false }, t(key)))),
      h("button", {
        type: "button", class: "lang", onclick: () => {
          safeStorage.set("lang", getLang() === "ar" ? "fr" : "ar");
          init();
        },
      }, t("lang_other"))));
}

/** Pied de page : texte + liens vers les pages légales. */
function renderFooter() {
  const footer = document.querySelector("body > footer");
  if (!footer) return;
  footer.append(h("p", { class: "foot-links", "aria-label": t("foot_links") },
    LEGAL_LINKS.map(([href, key]) => h("a", { href }, t(key)))));
}

export function init() {
  renderHeader();
  applyI18n();
  renderFooter();
  document.dispatchEvent(new CustomEvent("langchange"));
}

/** fetch JSON avec gestion réseau ; retourne toujours { ok, status, data }. */
export async function api(path, opts = {}) {
  try {
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch { /* corps vide */ }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "network" } };
  }
}

/** Affiche les erreurs sous les champs [data-err=nom]. Retourne le premier champ en erreur. */
export function showErrors(form, fields = {}) {
  form.querySelectorAll("[data-err]").forEach((el) => { el.textContent = ""; });
  form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
  let first = null;
  for (const [name, code] of Object.entries(fields)) {
    const slot = form.querySelector(`[data-err="${name}"]`);
    if (slot) slot.textContent = t(`e_${code}`);
    const input = form.querySelector(`[name="${name}"]`);
    if (input) { input.setAttribute("aria-invalid", "true"); first ??= input; }
  }
  return first;
}

export function banner(el, message, kind = "error") {
  el.textContent = message || "";
  el.hidden = !message;
  el.className = `banner ${kind}`;
}

export function formatDay(isoDate) {
  const lang = getLang() === "ar" ? "ar-TN" : "fr-TN";
  return new Intl.DateTimeFormat(lang, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(`${isoDate}T12:00:00Z`));
}

export function formatSlot(iso) {
  // iso est déjà à l'heure de Tunis (+01:00) : on lit la date et l'heure directement.
  return `${formatDay(iso.slice(0, 10))} — ${iso.slice(11, 16)}`;
}

export function savedContact() {
  try { return JSON.parse(sessionStorage.getItem("contact") || "{}"); } catch { return {}; }
}
export function saveContact(v) {
  try { sessionStorage.setItem("contact", JSON.stringify(v)); } catch { /* ignoré */ }
}

document.addEventListener("DOMContentLoaded", init);
