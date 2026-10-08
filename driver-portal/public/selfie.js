// Capture du « selfie dynamique » : 3 photos prises pendant que la personne tourne légèrement la tête
// (le backend vérifie qu'il y a du mouvement entre les images). Repli : choisir des photos sur l'appareil.
import { h, applyI18n } from "/common.js";

const STEPS = ["selfie_step1", "selfie_step2", "selfie_step3"];
const STEP_MS = 1800;
const MAX_DIM = 960; // 3 photos de 12 Mpx sur la 4G d'un chauffeur : on réduit avant l'envoi

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toJpeg(drawable, w, hgt) {
  const scale = Math.min(1, MAX_DIM / Math.max(w, hgt));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(hgt * scale);
  canvas.getContext("2d").drawImage(drawable, 0, 0, canvas.width, canvas.height);
  return new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
}

async function fileToJpeg(file) {
  const bmp = await createImageBitmap(file);
  const blob = await toJpeg(bmp, bmp.width, bmp.height);
  bmp.close?.();
  return blob;
}

export function createSelfieCapture(mount, onChange = () => {}) {
  let stream = null;
  let frames = [];
  let urls = [];
  const picked = [null, null, null];

  const video = h("video", { playsinline: true, muted: true, autoplay: true, class: "selfie-video", "aria-hidden": "true" });
  video.muted = true; // l'attribut seul ne suffit pas à autoriser l'autoplay sur iOS
  const instr = h("p", { class: "selfie-instr", "data-i18n": "selfie_step1", "aria-live": "polite" });
  const takeBtn = h("button", { type: "button", class: "btn", "data-i18n": "selfie_take", disabled: true });
  const camError = h("div", { class: "err", role: "alert", "data-i18n": "e_camera_denied", hidden: true });
  const thumbs = h("div", { class: "thumbs" });

  const panels = {
    idle: h("div", { class: "actions" },
      h("button", { type: "button", class: "btn", "data-i18n": "selfie_open", onclick: openCamera }),
      h("button", { type: "button", class: "btn secondary", "data-i18n": "selfie_gallery", onclick: () => show("files") })),
    camera: h("div", { class: "selfie-cam" }, video, instr,
      h("div", { class: "actions" }, takeBtn, h("button", { type: "button", class: "btn secondary", "data-i18n": "selfie_cancel", onclick: cancel }))),
    done: h("div", { class: "selfie-done" }, thumbs,
      h("p", { class: "ok-text", "data-i18n": "selfie_ready" }),
      h("button", { type: "button", class: "btn secondary small", "data-i18n": "selfie_retake", onclick: reset })),
    files: h("div", { class: "selfie-files" },
      [0, 1, 2].map((i) =>
        h("label", { class: "file" }, h("span", { "data-i18n": "selfie_file" }), ` ${i + 1}`,
          h("input", { type: "file", accept: "image/*", capture: "user", onchange: (e) => pickFile(i, e.target.files[0]) }))),
      h("button", { type: "button", class: "btn secondary small", "data-i18n": "selfie_back", onclick: () => show("idle") })),
  };
  takeBtn.addEventListener("click", capture);
  mount.replaceChildren(...Object.values(panels), camError);
  show("idle");

  function show(name) {
    for (const [k, el] of Object.entries(panels)) el.hidden = k !== name;
    applyI18n(mount);
  }

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  }

  async function openCamera() {
    camError.hidden = true;
    if (!navigator.mediaDevices?.getUserMedia) { camError.hidden = false; return show("files"); }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 960 } }, audio: false });
    } catch {
      camError.hidden = false; // refus de permission, pas de caméra, ou contexte non sécurisé (HTTP)
      return show("files");
    }
    takeBtn.disabled = true;
    video.srcObject = stream;
    video.onloadedmetadata = () => { video.play().catch(() => {}); takeBtn.disabled = false; };
    instr.dataset.i18n = "selfie_step1";
    show("camera");
  }

  function cancel() {
    stopStream();
    show("idle");
  }

  async function capture() {
    takeBtn.disabled = true;
    const shots = [];
    for (const key of STEPS) {
      instr.dataset.i18n = key;
      applyI18n(mount);
      await sleep(STEP_MS);
      shots.push(await toJpeg(video, video.videoWidth, video.videoHeight));
    }
    stopStream();
    setFrames(shots.filter(Boolean));
  }

  async function pickFile(i, file) {
    picked[i] = file ? await fileToJpeg(file).catch(() => null) : null;
    setFrames(picked.filter(Boolean), false);
  }

  function setFrames(list, showDone = true) {
    urls.forEach((u) => URL.revokeObjectURL(u));
    frames = list;
    urls = list.map((b) => URL.createObjectURL(b));
    thumbs.replaceChildren(...urls.map((src) => h("img", { src, alt: "", width: 96, height: 96 })));
    if (showDone) show("done");
    onChange();
  }

  function reset() {
    picked.fill(null);
    setFrames([], false);
    show("idle");
  }

  return { getFrames: () => [...frames], reset, destroy: stopStream };
}
