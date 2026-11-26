// Section "moment" de l'accueil : une phrase qui se révèle mot par mot au défilement (jamais sur les autres pages).
// Séparé de common.js : applyI18n() écrase le textContent à chaque rendu (changement de langue inclus), donc ce texte
// passe par data-i18n-words plutôt que data-i18n pour ne jamais perdre les <span> ajoutés ici.
import { t } from "./common.js";

function wrapWords(p, text) {
  p.replaceChildren();
  text.trim().split(/\s+/).forEach((word, i) => {
    if (i > 0) p.append(" ");
    const span = document.createElement("span");
    span.className = "word";
    span.textContent = word;
    p.append(span);
  });
}

function revealWords(p) {
  const words = [...p.querySelectorAll(".word")];
  words.forEach((w, i) => { w.style.transitionDelay = `${i * 45}ms`; });
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    words.forEach((w) => w.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      words.forEach((w) => w.classList.add("in"));
      io.unobserve(entry.target);
    }
  }, { threshold: 0.4 });
  io.observe(p);
}

function setup() {
  const p = document.querySelector(".tagline-text[data-i18n-words]");
  if (!p) return;
  wrapWords(p, t(p.dataset.i18nWords));
  revealWords(p);
}

// common.js dispatche "langchange" une fois après son propre DOMContentLoaded (chargement initial inclus)
// et à chaque bascule de langue : un seul écouteur couvre donc les deux cas.
document.addEventListener("langchange", setup);
