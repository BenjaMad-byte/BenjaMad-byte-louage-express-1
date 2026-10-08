import { t, api, banner, formatSlot, savedContact, saveContact, h } from "/common.js";

const form = document.getElementById("st");
const bannerEl = document.getElementById("banner");
const result = document.getElementById("result");
let last = null; // dernier résultat, pour re-rendu au changement de langue

function render() {
  if (!last) return;
  const badge = document.getElementById("badge");
  badge.className = `badge ${last.status}`;
  badge.textContent = t(`st_${last.status}`);
  document.getElementById("detail").textContent = t(`st_${last.status}_d`);
  document.getElementById("note-box").hidden = !last.public_note;
  document.getElementById("note").textContent = last.public_note || "";
  document.getElementById("iv-box").hidden = !last.interview;
  if (last.interview) {
    document.getElementById("iv-when").textContent = formatSlot(last.interview.slot_start);
    const link = document.getElementById("iv-link");
    link.href = last.interview.room_url;
    link.textContent = last.interview.room_url;
  }
  document.getElementById("book").hidden = last.status !== "interview" || Boolean(last.interview);
  result.hidden = false;
}
document.addEventListener("langchange", render);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  banner(bannerEl, "");
  result.hidden = true;
  const { ok, status, data } = await api("/api/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: form.elements.ref.value, phone: form.elements.phone.value }),
  });
  if (ok) { last = data; render(); return; }
  last = null;
  const key = status === 0 ? "network" : status === 404 ? "not_found" : data?.error === "rate_limited" ? "rate_limited" : "server";
  banner(bannerEl, t(`e_${key}`));
});

// ---------------------------------------------------------------- suppression de la demande (droit à l'effacement)
const $ = (id) => document.getElementById(id);
const erase = { phone: null, sent: false };
const eraseErr = (key) => { $("erase-err").textContent = key ? t(`e_${key}`) : ""; };
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

$("erase-open").addEventListener("click", () => {
  const open = $("erase-panel").hidden;
  $("erase-panel").hidden = !open;
  $("erase-open").setAttribute("aria-expanded", String(open));
});

$("erase-send").addEventListener("click", async () => {
  eraseErr(null);
  $("erase-send").disabled = true;
  const phone = form.elements.phone.value;
  const { ok, status, data } = await post("/api/otp/send", { phone, lang: document.documentElement.lang === "fr" ? "fr" : "ar" });
  $("erase-send").disabled = false;
  if (ok || data?.error === "otp_cooldown") {
    Object.assign(erase, { phone, sent: true });
    $("erase-step").hidden = false;
    $("erase-hint").replaceChildren(`${t("otp_sent")} `, h("bdi", { class: "ltr" }, phone));
    $("erase_code").focus();
    return;
  }
  const known = ["otp_limit", "sms_failed", "sms_unavailable"];
  eraseErr(status === 0 ? "network" : known.includes(data?.error) ? data.error : data?.error === "rate_limited" ? "rate_limited" : "server");
});

$("erase-confirm").addEventListener("click", async () => {
  const code = $("erase_code").value.trim();
  if (!/^\d{6}$/.test(code) || !erase.sent) return eraseErr("otp_invalid");
  eraseErr(null);
  $("erase-confirm").disabled = true;
  const verified = await post("/api/otp/verify", { phone: erase.phone, code });
  if (!verified.ok) {
    $("erase-confirm").disabled = false;
    const known = ["otp_invalid", "otp_expired", "otp_locked"];
    return eraseErr(verified.status === 0 ? "network" : known.includes(verified.data?.error) ? verified.data.error : "server");
  }
  const done = await post("/api/applications/delete", { ref: form.elements.ref.value, phone: erase.phone, otp_token: verified.data.token });
  $("erase-confirm").disabled = false;
  if (!done.ok) return eraseErr(done.status === 0 ? "network" : done.status === 404 ? "not_found" : done.data?.error === "otp_required" ? "otp_required" : "server");
  last = null;
  result.hidden = true;
  form.hidden = true;
  saveContact({});
  try { localStorage.removeItem("lx_draft_v1"); sessionStorage.removeItem("lx_otp_v1"); } catch { /* stockage indisponible */ }
  banner(bannerEl, t("er_done"), "ok");
  bannerEl.setAttribute("role", "status");
});

const saved = savedContact();
if (saved.ref) form.elements.ref.value = saved.ref;
if (saved.phone) form.elements.phone.value = saved.phone;
