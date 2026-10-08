import { t, h, api, showErrors, banner, getLang, saveContact } from "/common.js";
import { GOVERNORATES, GOVERNORATES_AR } from "/i18n.js";
import { createSelfieCapture } from "/selfie.js";
import { createStamps } from "/stamps.js";
import { places } from "/places.js";
import { DRAFT_KEY, OTP_KEY, buildDraft, readDraft, buildOtpState, readOtpState } from "/draft.js";

const MAX_BYTES = 5 * 1024 * 1024;
const COMPRESS_ABOVE = 1.2 * 1024 * 1024;
/** Stockage du navigateur, jamais bloquant : en navigation privée ou stockage plein, le formulaire fonctionne simplement sans brouillon. */
const storage = {
  get: (area, key) => { try { return area.getItem(key); } catch { return null; } },
  set: (area, key, value) => { try { area.setItem(key, value); } catch { /* plein ou interdit : pas de brouillon */ } },
  remove: (area, key) => { try { area.removeItem(key); } catch { /* idem */ } },
};
const form = document.getElementById("reg");
const submitBtn = document.getElementById("submit");
const bannerEl = document.getElementById("banner");
const FILE_KINDS = ["cin_front", "cin_back", "permis", "licence"];
const selfie = createSelfieCapture(document.getElementById("selfie-box"), () => {
  form.querySelector('[data-err="selfies"]').replaceChildren();
  stamps.refresh();
});

function renderGovernorates() {
  const select = document.getElementById("governorate");
  const current = select.value;
  const labels = getLang() === "ar" ? GOVERNORATES_AR : GOVERNORATES;
  select.replaceChildren(
    h("option", { value: "" }, t("f_gov_ph")),
    ...GOVERNORATES.map((value, i) => h("option", { value }, labels[i]))
  );
  select.value = current;
  renderLineTo();
}

/** Arrivée du circuit : régional = le gouvernorat de la station (verrouillé) ; interrégional = n'importe quel autre. */
/** Villes proposées pour la ville de départ : celles du gouvernorat de la station, dans la langue de l'interface (la saisie libre reste permise). */
function renderPlaceSuggestions() {
  const names = places.suggestions(form.elements.governorate.value, getLang());
  document.getElementById("line-from-list").replaceChildren(...names.map((name) => h("option", { value: name })));
}

function renderLineTo() {
  renderPlaceSuggestions();
  const select = document.getElementById("line_to_gov");
  const type = form.elements.line_type.value;
  const home = form.elements.governorate.value;
  const labels = getLang() === "ar" ? GOVERNORATES_AR : GOVERNORATES;
  const previous = select.value;
  const options = GOVERNORATES.map((value, i) => ({ value, label: labels[i] })).filter((o) => type !== "interregional" || o.value !== home);
  select.replaceChildren(h("option", { value: "" }, t("f_line_to_ph")), ...options.map((o) => h("option", { value: o.value }, o.label)));
  const regional = type === "regional" || type === "rural"; // même règle : l'arrivée reste dans le gouvernorat de la station
  const national = type === "national";
  select.disabled = regional || national;
  select.required = !national;
  select.value = regional ? home : national ? "" : options.some((o) => o.value === previous) ? previous : "";
  stamps.refresh();
  document.getElementById("line-to-hint").hidden = !regional;
  document.getElementById("line-to-field").hidden = national; // le louage national n'a pas de gouvernorat d'arrivée
  document.getElementById("line-national-hint").hidden = !national;
}

// ---------------------------------------------------------------------------
// Vérification du téléphone par SMS
// ---------------------------------------------------------------------------
const otp = { token: null, phone: null, sent: false, until: 0, timer: null };
const $ = (id) => document.getElementById(id);

const latinDigits = (s) => String(s ?? "").replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660).replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x06f0);
const normPhone = (raw) => {
  const d = latinDigits(raw).replace(/[\s.\-()]/g, "").replace(/^(\+216|00216)/, "");
  return /^[2459]\d{7}$/.test(d) ? d : null;
};
const setErr = (name, code) => { form.querySelector(`[data-err="${name}"]`).textContent = code ? t(`e_${code}`) : ""; };

function renderOtp() {
  const left = Math.max(0, Math.ceil((otp.until - Date.now()) / 1000));
  $("otp-ok").hidden = !otp.token;
  $("otp-send").hidden = Boolean(otp.token);
  $("otp-step").hidden = Boolean(otp.token) || !otp.sent;
  const send = $("otp-send");
  send.disabled = left > 0;
  send.textContent = left > 0 ? `${t("otp_wait")} ${left} ${t("sec")}` : t(otp.sent ? "otp_resend" : "otp_send");
  if (otp.sent && otp.phone) $("otp-hint").replaceChildren(`${t("otp_sent")} `, h("bdi", { class: "ltr" }, otp.phone));
  if (left === 0 && otp.timer) { clearInterval(otp.timer); otp.timer = null; }
  stamps?.refresh();
}

function startCountdown(seconds) {
  otp.until = Date.now() + seconds * 1000;
  clearInterval(otp.timer);
  otp.timer = setInterval(renderOtp, 1000);
  renderOtp();
}

function resetOtp() {
  storage.remove(sessionStorage, OTP_KEY);
  Object.assign(otp, { token: null, phone: null, sent: false, until: 0 });
  clearInterval(otp.timer);
  otp.timer = null;
  $("otp_code").value = "";
  renderOtp();
}

// Chiffres indo-arabes → chiffres latins dès la saisie (le serveur les accepte aussi, mais l'affichage reste lisible).
for (const name of ["phone", "cin"]) {
  form.elements[name].addEventListener("input", (e) => { e.target.value = latinDigits(e.target.value); });
}

// Changer de numéro après vérification invalide la vérification.
form.elements.phone.addEventListener("input", () => {
  if ((otp.token || otp.sent) && normPhone(form.elements.phone.value) !== otp.phone) resetOtp();
});

$("otp-send").addEventListener("click", async () => {
  setErr("phone", null); setErr("otp_code", null);
  const phone = normPhone(form.elements.phone.value);
  if (!phone) { showErrors(form, { phone: "invalid_phone" })?.focus(); return; }
  $("otp-send").disabled = true;
  const { ok, status, data } = await api("/api/otp/send", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, lang: getLang() }),
  });
  if (ok) {
    Object.assign(otp, { phone, sent: true });
    startCountdown(data.retry_after);
    $("otp_code").focus();
    return;
  }
  if (data?.error === "otp_cooldown") Object.assign(otp, { phone, sent: true }), startCountdown(data.retry_after);
  else renderOtp();
  const known = ["otp_cooldown", "otp_limit", "sms_failed", "sms_unavailable"];
  setErr("otp_code", status === 0 ? "network" : known.includes(data?.error) ? data.error : data?.error === "rate_limited" ? "rate_limited" : "server");
});

async function verifyCode() {
  const code = $("otp_code").value.trim();
  if (!/^\d{6}$/.test(code) || !otp.phone) return;
  $("otp-verify").disabled = true;
  const { ok, status, data } = await api("/api/otp/verify", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: otp.phone, code }),
  });
  $("otp-verify").disabled = false;
  if (ok) {
    otp.token = data.token;
    const kept = buildOtpState({ token: data.token, phone: otp.phone, expiresInSeconds: data.expires_in });
    if (kept) storage.set(sessionStorage, OTP_KEY, JSON.stringify(kept));
    setErr("phone", null); setErr("otp_code", null);
    renderOtp();
    return;
  }
  const known = ["otp_invalid", "otp_expired", "otp_locked"];
  setErr("otp_code", status === 0 ? "network" : known.includes(data?.error) ? data.error : "server");
  if (data?.error === "otp_locked" || data?.error === "otp_expired") { $("otp_code").value = ""; }
}
$("otp-verify").addEventListener("click", verifyCode);
$("otp_code").addEventListener("input", (e) => {
  e.target.value = latinDigits(e.target.value).replace(/\D/g, "").slice(0, 6);
  if (e.target.value.length === 6) verifyCode();
});

// ---------------------------------------------------------------------------
// Tampons de gares : une section complète = un tampon (purement visuel, n'empêche jamais l'envoi)
// ---------------------------------------------------------------------------
const field = (name) => form.elements[name].value.trim();
const longer = (name, min) => field(name).length >= min;
const hasFile = (name) => form.elements[name].files.length > 0;
const sectionDone = {
  "sec-you": () => longer("full_name", 3) && /^\d{8}$/.test(latinDigits(field("cin"))) && Boolean(otp.token),
  "sec-vehicle": () => longer("plate", 4) && Boolean(field("governorate")) && longer("station", 2),
  "sec-line": () => {
    const type = form.elements.line_type.value;
    if (!type || !longer("line_from", 2)) return false;
    if (type !== "national" && !form.elements.line_to_gov.value) return false;
    return !form.elements.pickup_en_route.checked || longer("line_via", 2);
  },
  "sec-docs": () => ["cin_front", "cin_back", "permis"].every(hasFile),
  "sec-selfie": () => selfie.getFrames().length >= 2,
  "sec-consent": () => form.elements.consent.checked && form.elements.consent_biometric.checked,
};
const stamps = createStamps(document.getElementById("stamps"), (id) => sectionDone[id]());
form.addEventListener("input", () => stamps.refresh());
form.addEventListener("change", () => stamps.refresh());

// ---------------------------------------------------------------------------
// Brouillon sur le téléphone (voir draft.js pour ce qui est gardé et ce qui ne l'est jamais)
// ---------------------------------------------------------------------------
const draftNotice = document.getElementById("draft-notice");
let restoredAt = null;

function currentValues() {
  const type = form.elements.line_type.value;
  return {
    full_name: form.elements.full_name.value, phone: form.elements.phone.value, plate: form.elements.plate.value,
    governorate: form.elements.governorate.value, station: form.elements.station.value,
    line_type: type, line_from: form.elements.line_from.value,
    line_to_gov: type === "interregional" ? form.elements.line_to_gov.value : "", // régional / rural : déduit de la station ; national : sans arrivée
    line_via: form.elements.line_via.value,
    pickup_en_route: form.elements.pickup_en_route.checked, leaves_partial: form.elements.leaves_partial.checked,
  };
}

function saveDraft() {
  const draft = buildDraft(currentValues());
  if (draft) storage.set(localStorage, DRAFT_KEY, JSON.stringify(draft));
  else storage.remove(localStorage, DRAFT_KEY);
}

let saveTimer = null;
const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 400); };
/** Enregistre tout de suite si la page se ferme ou passe en arrière-plan (le navigateur d'un téléphone peut tuer l'onglet sans prévenir). */
const flushSave = () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveDraft(); } };
form.addEventListener("input", scheduleSave);
form.addEventListener("change", scheduleSave);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSave(); });
window.addEventListener("pagehide", flushSave);

function clearStoredDraft() {
  clearTimeout(saveTimer);
  saveTimer = null;
  storage.remove(localStorage, DRAFT_KEY);
  storage.remove(sessionStorage, OTP_KEY);
}

function renderDraftNotice() {
  if (restoredAt === null) return;
  const locale = getLang() === "ar" ? "ar-TN-u-nu-latn" : "fr-FR"; // chiffres latins aussi en arabe
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(restoredAt);
  document.getElementById("draft-text").textContent = t("draft_restored").replace("{date}", date);
  draftNotice.hidden = false;
}

function restoreDraft() {
  renderGovernorates(); // les options ne sont rendues qu'au premier changement de langue : il faut qu'elles existent pour y remettre le choix
  const raw = storage.get(localStorage, DRAFT_KEY);
  const draft = readDraft(raw);
  if (!draft) {
    if (raw) storage.remove(localStorage, DRAFT_KEY); // périmé ou illisible : on ne le garde pas
  } else {
    const f = draft.fields;
    for (const name of ["full_name", "phone", "plate", "station", "line_from", "line_via"]) if (f[name]) form.elements[name].value = f[name];
    if (GOVERNORATES.includes(f.governorate)) form.elements.governorate.value = f.governorate;
    const radio = f.line_type && form.querySelector(`input[name="line_type"][value="${f.line_type}"]`); // valeur déjà limitée à 4 types connus
    if (radio) radio.checked = true;
    for (const name of ["pickup_en_route", "leaves_partial"]) if (typeof f[name] === "boolean") form.elements[name].checked = f[name];
    renderLineTo();
    const to = form.elements.line_to_gov;
    if (f.line_type === "interregional" && [...to.options].some((o) => o.value === f.line_to_gov)) to.value = f.line_to_gov;
    restoredAt = draft.savedAt;
    renderDraftNotice();
  }
  // Téléphone déjà vérifié dans cet onglet : inutile de renvoyer un SMS après un rechargement.
  const kept = readOtpState(storage.get(sessionStorage, OTP_KEY));
  if (kept && normPhone(form.elements.phone.value) === kept.phone) Object.assign(otp, { token: kept.token, phone: kept.phone });
  else storage.remove(sessionStorage, OTP_KEY);
  renderOtp();
  stamps.refresh();
}

document.getElementById("draft-clear").addEventListener("click", () => {
  clearStoredDraft();
  form.reset();
  selfie.reset();
  resetOtp();
  renderLineTo();
  restoredAt = null;
  draftNotice.hidden = true;
  stamps.refresh();
  form.elements.full_name.focus();
});

document.addEventListener("langchange", () => { renderGovernorates(); renderOtp(); stamps.refresh(); renderDraftNotice(); });
form.addEventListener("change", (e) => {
  if (e.target.name === "line_type" || e.target.name === "governorate") renderLineTo();
  if (FILE_KINDS.includes(e.target.name)) {
    const f = e.target.files[0];
    document.querySelector(`[data-picked="${e.target.name}"]`).textContent = f ? `${t("file_chosen")} : ${f.name}` : "";
  }
});

/** Réduit les grosses photos (économie de data mobile) ; les PDF et petites images passent tels quels. */
async function shrink(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size <= COMPRESS_ABOVE) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  banner(bannerEl, "");
  if (!otp.token) {
    showErrors(form, { phone: "otp_required" })?.focus();
    banner(bannerEl, t("e_otp_required"));
    return;
  }
  const frames = selfie.getFrames();
  if (frames.length < 2) {
    showErrors(form, { selfies: "selfie_required" });
    form.querySelector('[data-err="selfies"]').scrollIntoView({ block: "center" });
    return;
  }
  const fd = new FormData();
  fd.append("otp_token", otp.token);
  frames.forEach((blob, i) => fd.append(`selfie_${i + 1}`, new File([blob], `selfie_${i + 1}.jpg`, { type: "image/jpeg" })));
  fd.append("consent_biometric", form.elements.consent_biometric.checked ? "true" : "");
  for (const name of ["full_name", "phone", "cin", "plate", "governorate", "station", "line_type", "line_from", "line_to_gov", "line_via"]) fd.append(name, form.elements[name].value);
  fd.append("consent", form.elements.consent.checked ? "true" : "");
  for (const name of ["pickup_en_route", "leaves_partial"]) fd.append(name, form.elements[name].checked ? "true" : "");
  fd.append("lang", getLang());

  const localErrors = {};
  for (const kind of FILE_KINDS) {
    const f = form.elements[kind].files[0];
    if (!f) continue;
    if (f.size > MAX_BYTES * 4) localErrors[kind] = "file_too_large";
    else fd.append(kind, await shrink(f));
  }
  if (Object.keys(localErrors).length) {
    showErrors(form, localErrors)?.focus();
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = t("sending");
  const { ok, status, data } = await api("/api/applications", { method: "POST", body: fd });
  submitBtn.disabled = false;
  submitBtn.textContent = t("submit");

  if (ok) {
    clearStoredDraft();
    saveContact({ ref: data.ref, phone: form.elements.phone.value, name: form.elements.full_name.value });
    document.getElementById("done-ref").textContent = data.ref;
    createStamps(document.getElementById("done-stamps"), () => true, { linked: false, showCount: false, appear: true }).refresh();
    document.getElementById("form-view").hidden = true;
    document.getElementById("done-view").hidden = false;
    window.scrollTo({ top: 0 });
    return;
  }
  if (data?.error === "validation") {
    banner(bannerEl, t("e_validation"));
    if (data.fields?.phone === "otp_required") resetOtp(); // jeton expiré (30 min) ou déjà utilisé : refaire la vérification
    showErrors(form, data.fields)?.focus();
  } else {
    const key = status === 0 ? "network" : data?.error;
    banner(bannerEl, t(`e_${["duplicate", "rate_limited", "network"].includes(key) ? key : "server"}`));
    bannerEl.scrollIntoView({ block: "center" });
  }
});

document.getElementById("copy").addEventListener("click", async (e) => {
  try { await navigator.clipboard.writeText(document.getElementById("done-ref").textContent); } catch { return; }
  e.target.textContent = t("copied");
});

restoreDraft();
