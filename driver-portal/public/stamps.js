// Tampons de gares : une section du formulaire complétée = un tampon posé. Purement visuel : rien ne bloque l'envoi.
import { h, t } from "/common.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Les six gares du formulaire, du nord au sud. */
export const STAMPS = [
  { id: "sec-you", city: "tunis", label: "sec_you" },
  { id: "sec-vehicle", city: "nabeul", label: "sec_vehicle" },
  { id: "sec-line", city: "sousse", label: "sec_line" },
  { id: "sec-docs", city: "kairouan", label: "sec_docs" },
  { id: "sec-selfie", city: "gafsa", label: "sec_selfie" },
  { id: "sec-consent", city: "tozeur", label: "sec_consent" },
];

function emblem(city) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `em ${city}`);
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `/emblems.svg#${city}`);
  svg.append(use);
  return svg;
}

/**
 * Pose les tampons dans `host`.
 * @param {HTMLElement} host
 * @param {(sectionId: string) => boolean} isDone
 * @param {{linked?: boolean, showCount?: boolean, appear?: boolean}} opts linked : chaque tampon mène à sa section ; showCount : « 3 / 6 » annoncé aux lecteurs d'écran ; appear : les tampons déjà posés arrivent avec l'animation.
 * @returns {{refresh: () => void}}
 */
export function createStamps(host, isDone, { linked = true, showCount = true, appear = false } = {}) {
  const items = STAMPS.map((s, i) => {
    const el = linked ? h("a", { class: "stamp", href: `#${s.id}` }) : h("span", { class: "stamp" });
    el.style.setProperty("--i", String(i)); // délai d'apparition en cascade (CSSOM : compatible avec la CSP stricte)
    const name = h("span", { class: "stamp-name" });
    el.append(emblem(s.city), name);
    el.addEventListener("animationend", () => el.classList.remove("just"));
    return { ...s, el, name, done: appear ? false : null };
  });
  const count = showCount ? h("p", { class: "stamps-count", role: "status" }) : null;
  host.replaceChildren(...[h("ol", { class: "stamp-row" }, items.map((i) => h("li", {}, i.el))), count].filter(Boolean));

  function refresh() {
    let total = 0;
    for (const item of items) {
      const done = Boolean(isDone(item.id));
      if (done) total += 1;
      if (done && item.done === false) item.el.classList.add("just");
      item.done = done;
      item.el.classList.toggle("done", done);
      item.name.textContent = t(item.label);
      if (linked) item.el.setAttribute("aria-label", `${t(item.label)} — ${t(done ? "stamp_done" : "stamp_todo")}`);
    }
    if (count) {
      const all = total === items.length;
      count.textContent = all ? t("stamps_all") : `${total} / ${items.length}`;
      count.dir = all ? "auto" : "ltr"; // « 0 / 6 » reste lisible dans une page arabe (sinon : « 6 / 0 »)
    }
  }
  refresh();
  return { refresh };
}
