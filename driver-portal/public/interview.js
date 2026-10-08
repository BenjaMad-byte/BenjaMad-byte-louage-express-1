import { t, h, api, showErrors, banner, formatDay, formatSlot, savedContact } from "/common.js";

const form = document.getElementById("iv");
const slotsEl = document.getElementById("slots");
const bannerEl = document.getElementById("banner");
const submitBtn = document.getElementById("submit");
let slots = null; // null = pas encore chargé
let selected = null;

function renderSlots() {
  if (slots === null) return slotsEl.replaceChildren(h("p", { class: "note" }, t("iv_loading")));
  if (!slots.length) return slotsEl.replaceChildren(h("p", { class: "note" }, t("iv_none")));
  const byDay = new Map();
  for (const iso of slots) {
    const day = iso.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(iso);
  }
  slotsEl.replaceChildren(
    ...[...byDay].map(([day, list]) =>
      h("div", { class: "day" },
        h("h3", {}, formatDay(day)),
        h("div", { class: "times" },
          list.map((iso) =>
            h("button", {
              type: "button", class: "slot", "aria-pressed": String(iso === selected),
              onclick: () => { selected = iso; renderSlots(); },
            }, iso.slice(11, 16))))))
  );
}

async function loadSlots() {
  const { ok, data } = await api("/api/slots");
  slots = ok ? data.slots : [];
  renderSlots();
}

document.addEventListener("langchange", renderSlots);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  banner(bannerEl, "");
  if (!selected) {
    showErrors(form, {});
    form.querySelector('[data-err="slot"]').textContent = t("iv_pick_first");
    return;
  }
  form.querySelector('[data-err="slot"]').textContent = "";
  submitBtn.disabled = true;
  const body = {
    name: form.elements.name.value, phone: form.elements.phone.value,
    ref: form.elements.ref.value.trim() || undefined,
    question: form.elements.question.value, slot: selected,
  };
  const { ok, status, data } = await api("/api/interviews", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  submitBtn.disabled = false;

  if (ok) {
    document.getElementById("done-when").textContent = formatSlot(data.slot_start);
    const link = document.getElementById("done-link");
    link.href = data.room_url;
    link.textContent = data.room_url;
    document.getElementById("form-view").hidden = true;
    document.getElementById("done-view").hidden = false;
    window.scrollTo({ top: 0 });
    return;
  }
  if (data?.error === "validation") {
    banner(bannerEl, t("e_validation"));
    showErrors(form, data.fields)?.focus();
  } else if (data?.error === "slot_unavailable") {
    banner(bannerEl, t("e_slot_unavailable"));
    selected = null;
    await loadSlots();
  } else {
    const key = status === 0 ? "network" : data?.error;
    banner(bannerEl, t(`e_${["already_booked", "rate_limited", "network"].includes(key) ? key : "server"}`));
  }
});

const saved = savedContact();
if (saved.phone) form.elements.phone.value = saved.phone;
if (saved.name) form.elements.name.value = saved.name;
if (saved.ref) form.elements.ref.value = saved.ref;

api("/api/config").then(({ ok, data }) => {
  if (!ok || !data.whatsapp) return;
  document.getElementById("wa-link").href = `https://wa.me/${String(data.whatsapp).replace(/\D/g, "")}`;
  document.getElementById("wa").hidden = false;
});
loadSlots();
