// Pages légales : le texte vient de legal-text.js, les valeurs propres à l'éditeur de /api/legal. Tout texte passe par textContent.
import { h, api, getLang, t } from "/common.js";
import { DOCS, UPDATED } from "/legal-text.js";
import { segments, visibleBlocks, hasMissingValues } from "/legal-render.js";

const doc = document.getElementById("main")?.dataset.doc;
let values = {};

// Les valeurs insérées sont isolées (<bdi>) : une adresse latine dans une phrase arabe ne bouscule pas la ponctuation.
const fill = (template) => segments(template, values).map((s) => (s.todo ? h("mark", { class: "todo" }, t("legal_todo")) : s.value ? h("bdi", {}, s.text) : s.text));

function render() {
  const lang = getLang();
  const content = DOCS[doc]?.[lang];
  if (!content) return;
  document.getElementById("legal-title").textContent = content.title;
  document.getElementById("legal-intro").textContent = content.intro;
  const date = new Intl.DateTimeFormat(lang === "ar" ? "ar-TN" : "fr-TN", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${UPDATED}T12:00:00Z`));
  document.getElementById("legal-updated").textContent = `${t("legal_updated")} ${date}`;
  const draft = document.getElementById("legal-draft");
  draft.textContent = t("legal_draft");
  draft.hidden = !hasMissingValues(values);
  document.getElementById("legal-body").replaceChildren(
    ...content.sections.flatMap((section) => [
      h("h2", {}, section.h),
      ...visibleBlocks(section.blocks, values).map((b) => (b.ul ? h("ul", {}, b.ul.map((li) => h("li", {}, fill(li)))) : h("p", {}, fill(b.p)))),
    ]),
    h("p", { class: "legal-links" }, ...[["/privacy", "foot_privacy"], ["/terms", "foot_terms"], ["/legal", "foot_legal"]].filter(([href]) => href !== `/${doc}`).map(([href, key]) => h("a", { href }, t(key)))));
}

const response = await api("/api/legal");
values = response.ok ? response.data : {};
render();
document.addEventListener("langchange", render);
