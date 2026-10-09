import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, UPLOAD_DIR } from "./db.js";
import { validateApplication, newRef, normalizeRef, normalizePhone, sniffMime, EXT, clean, GOVERNORATES } from "./validate.js";
import { listSlots } from "./slots.js";
import { buildNetwork, networkCsv } from "./network.js";
import { parseListQuery, queryApplications } from "./adminList.js";
import { createOtpService } from "./otp.js";
import { createSmsProvider } from "./sms.js";
import { createKycWorker, purgeSelfies } from "./kyc.js";
import { parseDataKeys, assertProductionConfig, sameOriginGuard, isAllowedAdminIp } from "./security.js";
import { createUploadStore, inspectKeys } from "./uploads.js";
import { legalValues } from "./legal.js";
import { eraseApplication, purgeExpired } from "./retention.js";
import { createNotifier } from "./notifications.js";
import { createAdminAuth, LIMITS as ADMIN_LIMITS } from "./admin-auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const STATUSES = ["pending", "interview", "approved", "rejected"];
const SELFIE_FIELDS = ["selfie_1", "selfie_2", "selfie_3"];
const FILE_FIELDS = ["cin_front", "cin_back", "permis", "licence", ...SELFIE_FIELDS];
const MIN_SELFIES = 2; // la vivacité compare au moins deux images
const MAX_SELFIE_BYTES = 2 * 1024 * 1024; // le navigateur les réduit à ~100 Ko ; au-delà, c'est anormal
const MAX_REQUEST_BYTES = FILE_FIELDS.length * MAX_FILE_BYTES + 1024 * 1024; // refus dès l'en-tête Content-Length, avant de charger le corps en mémoire
const MIN_ADMIN_TOKEN = 8; // 32 exigés en production (assertProductionConfig)
// Pages servies avec leur adresse publique insérée (voir baseUrlFor).
const PAGE_ROUTES = {
  "/": "index.html", "/index.html": "index.html", "/register": "register.html", "/register.html": "register.html",
  "/interview": "interview.html", "/interview.html": "interview.html", "/status": "status.html", "/status.html": "status.html",
  "/privacy": "privacy.html", "/privacy.html": "privacy.html", "/terms": "terms.html", "/terms.html": "terms.html", "/legal": "legal.html", "/legal.html": "legal.html",
};
const SITEMAP_PATHS = ["/", "/register", "/interview", "/status", "/privacy", "/terms", "/legal"];
const HOST_PATTERN = /^(?:(?:[a-z0-9-]+\.)*[a-z0-9-]+|\[[0-9a-f:]+\])(?::\d{1,5})?$/i;

/** PUBLIC_URL : adresse du site (ex. https://inscription.exemple.tn). Retourne son origine, ou null si absente. */
function parsePublicUrl(raw) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("PUBLIC_URL invalide (attendu : https://domaine)");
  }
  if (!["http:", "https:"].includes(u.protocol) || !HOST_PATTERN.test(u.host)) throw new Error("PUBLIC_URL invalide (attendu : https://domaine)");
  return `${u.protocol}//${u.host}`;
}
const csvList = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();

export function createApp({
  adminToken = process.env.ADMIN_TOKEN, rateLimits = true, sms, otpSecret = process.env.OTP_SECRET, now, kycFetch,
  dataKey = process.env.DATA_KEY, previousDataKeys = process.env.DATA_KEY_PREVIOUS, strictKeys = process.env.NODE_ENV === "production", forceHttps = process.env.NODE_ENV === "production", trustProxy = process.env.TRUST_PROXY,
  adminAllowedIps = csvList(process.env.ADMIN_ALLOWED_IPS), allowedOrigins = csvList(process.env.ALLOWED_ORIGINS),
  publicUrl = process.env.PUBLIC_URL, legalEnv = process.env, appServiceKey = process.env.APP_SERVICE_KEY,
  // Application chauffeur (service séparé) : l'onglet « Exploitation » de la console l'interroge avec cette clé (OPS_SERVICE_KEY de son côté).
  appOps = { url: process.env.APP_URL, key: process.env.APP_OPS_KEY, fetchImpl: fetch },
  // Durées de conservation annoncées par la politique de confidentialité ; absentes (développement) : aucune purge automatique.
  // SMS de notification : désactivés tant que SMS_NOTIFICATIONS=on n'est pas posé (coût, et le numéro part chez le prestataire SMS).
  notifications = { enabled: process.env.SMS_NOTIFICATIONS === "on", dailyCap: Number(process.env.NOTIFY_DAILY_CAP || 300), reminderHours: Number(process.env.NOTIFY_REMINDER_HOURS || 3) },
  retention = { rejectedMonths: legalValues(legalEnv).retention_rejected, approvedMonths: legalValues(legalEnv).retention_approved },
} = {}) {
  if (!adminToken) throw new Error("ADMIN_TOKEN requis");
  if (String(adminToken).length < MIN_ADMIN_TOKEN) throw new Error(`ADMIN_TOKEN trop court (${MIN_ADMIN_TOKEN} caractères minimum, 32 en production)`);
  const publicBase = parsePublicUrl(publicUrl);
  const { current: key, previous: previousKeys } = parseDataKeys(dataKey, previousDataKeys);
  if (!key) console.warn("[securite] DATA_KEY non défini : les pièces d'identité et les selfies sont stockés EN CLAIR (développement uniquement)");
  const uploads = createUploadStore({ dir: UPLOAD_DIR, key, previousKeys });
  // Garde-fou : une clé erronée ou oubliée rendrait les pièces illisibles. On le découvre ICI, pas le jour où un dossier doit être examiné.
  const keyStatus = inspectKeys({ db, store: uploads });
  if (key && !keyStatus.readable) {
    const missing = keyStatus.unreadable_key_ids.length ? ` Empreintes de clés manquantes : ${keyStatus.unreadable_key_ids.join(", ")}.` : "";
    const message = `Des pièces chiffrées ne peuvent pas être lus avec les clés fournies (DATA_KEY${previousKeys.length ? " et DATA_KEY_PREVIOUS" : ""}).${missing} Renseigner l'ancienne clé dans DATA_KEY_PREVIOUS.`;
    if (strictKeys) throw new Error(message);
    console.warn(`[securite] ${message}`);
  }
  if (key && (keyStatus.files.other || keyStatus.files.plaintext || keyStatus.files.unknown_fingerprint)) {
    console.warn(`[securite] ${keyStatus.files.other + keyStatus.files.plaintext + keyStatus.files.unknown_fingerprint} fichier(s) ne sont pas encore sur la clé courante : lancer « npm run rotate-key ».`);
  }
  // Sans OTP_SECRET, un secret aléatoire par processus : les codes en attente sont perdus au redémarrage (5 min de validité).
  const smsProvider = sms ?? createSmsProvider();
  const otp = createOtpService({ db, sms: smsProvider, secret: otpSecret || crypto.randomBytes(32).toString("hex"), now });
  const kyc = createKycWorker({
    db, uploadDir: UPLOAD_DIR, now, fetchImpl: kycFetch, readUpload: (f) => uploads.read(f),
    backendUrl: process.env.KYC_BACKEND_URL || "http://localhost:4000",
    serviceKey: process.env.KYC_SERVICE_KEY,
  });
  const app = express();
  app.locals.kyc = kyc;
  const adminAuth = createAdminAuth({ db, keys: { current: key, previous: previousKeys }, now });
  app.locals.adminAuth = adminAuth;
  const notifier = createNotifier({ db, sms: smsProvider, now, baseUrl: publicBase, ...notifications });
  app.locals.notifier = notifier;

  /** Supprime un dossier en entier (base, pièces, entretiens) et prévient le backend KYC. */
  const erase = (appId) => {
    const done = eraseApplication({ db, uploads }, appId);
    if (done) kyc.forget(done.ref);
    return done;
  };
  // Purge automatique : au démarrage puis une fois par jour. `run({ dryRun })` sert aussi à la commande « npm run purge ».
  const runRetention = (opts = {}) => purgeExpired({ db, uploads, onErase: (ref) => kyc.forget(ref) }, { ...retention, ...opts });
  let retentionTimer = null;
  app.locals.retention = {
    run: runRetention,
    enabled: Boolean(retention.rejectedMonths || retention.approvedMonths),
    start({ intervalMs = 24 * 3600 * 1000, firstDelayMs = 60_000 } = {}) {
      if (!this.enabled || retentionTimer) return;
      const tick = () => {
        try {
          const r = runRetention();
          const n = r.rejected + r.abandoned + r.ended;
          if (n) console.log(`[conservation] ${n} dossier(s) supprimé(s) : ${r.rejected} refusés, ${r.abandoned} abandonnés, ${r.ended} fins de collaboration`);
        } catch (e) {
          console.error("[conservation] échec de la purge :", e.message);
        }
      };
      retentionTimer = setInterval(tick, intervalMs);
      retentionTimer.unref?.();
      setTimeout(tick, firstDelayMs).unref?.();
    },
  };
  app.disable("x-powered-by");
  if (trustProxy !== undefined && trustProxy !== "") app.set("trust proxy", Number(trustProxy));

  // Point de santé pour la supervision : aucune donnée, déclaré avant le contrôle HTTPS (une sonde locale n'envoie pas X-Forwarded-Proto).
  app.get("/healthz", (_req, res) => {
    try {
      db.prepare("SELECT 1").get();
      res.set("Cache-Control", "no-store").json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // HTTPS obligatoire en production : lecture redirigée, écriture refusée (les mots de passe, CIN et visages ne doivent jamais circuler en clair).
  if (forceHttps) {
    app.use((req, res, next) => {
      if (req.secure) return next();
      if (req.method === "GET" || req.method === "HEAD") return res.redirect(308, `https://${req.get("host")}${req.originalUrl}`);
      res.status(400).json({ error: "https_required" });
    });
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "style-src": ["'self'"],
          "img-src": ["'self'", "data:", "blob:"],
          "connect-src": ["'self'"],
          "form-action": ["'self'"],
          "frame-ancestors": ["'none'"],
          "base-uri": ["'self'"],
          "object-src": ["'none'"],
          ...(forceHttps ? { "upgrade-insecure-requests": [] } : {}),
        },
      },
    })
  );
  // La caméra n'est autorisée que pour ce site (selfie) ; micro et géolocalisation jamais.
  app.use((_req, res, next) => { res.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()"); next(); });
  app.use("/api", sameOriginGuard({ allowed: allowedOrigins })); // avant tout traitement du corps
  app.use(express.json({ limit: "20kb" }));
  // Données personnelles : jamais en cache navigateur ou proxy, jamais indexées.
  app.use(["/api", "/admin"], (_req, res, next) => { res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }); next(); });

  const limiter = (windowMs, max) =>
    rateLimits
      ? rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: "rate_limited" } })
      : (_req, _res, next) => next();
  app.use("/api", limiter(15 * 60 * 1000, 300));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: FILE_FIELDS.length, fields: 20, fieldSize: 10 * 1024, parts: 40 },
  }).fields(FILE_FIELDS.map((name) => ({ name, maxCount: 1 })));

  // ---------------------------------------------------------------- pages publiques
  // Les aperçus de lien (WhatsApp, Facebook) lisent le HTML sans exécuter de JavaScript et exigent des adresses ABSOLUES :
  // les pages portent donc le marqueur %PUBLIC_URL%, remplacé ici. Sans PUBLIC_URL (développement), l'adresse vient de la requête,
  // mais seulement si l'hôte a une forme valide : un en-tête Host piégé ne doit jamais atterrir dans le HTML.
  const baseUrlFor = (req) => {
    if (publicBase) return publicBase;
    const host = req.get("host") ?? "";
    return HOST_PATTERN.test(host) ? `${req.protocol}://${host}` : "http://localhost";
  };
  const pageCache = new Map();
  const readPage = (file) => {
    if (process.env.NODE_ENV === "production" && pageCache.has(file)) return pageCache.get(file);
    const html = fs.readFileSync(path.join(here, "public", file), "utf8");
    pageCache.set(file, html);
    return html;
  };
  const sendPage = (req, res, file, status = 200) =>
    res.status(status).set("Cache-Control", status === 200 ? "no-cache" : "no-store").type("html").send(readPage(file).replaceAll("%PUBLIC_URL%", baseUrlFor(req)));
  for (const [route, file] of Object.entries(PAGE_ROUTES)) app.get(route, (req, res) => sendPage(req, res, file));
  app.get(["/404", "/404.html"], (req, res) => sendPage(req, res, "404.html", 404));

  app.get("/robots.txt", (req, res) => res.type("text/plain").send(`User-agent: *\nDisallow: /api/\n\nSitemap: ${baseUrlFor(req)}/sitemap.xml\n`));
  app.get("/sitemap.xml", (req, res) => {
    const base = baseUrlFor(req);
    const urls = SITEMAP_PATHS.map((p) => `  <url><loc>${base}${p}</loc></url>`).join("\n");
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });

  // ---------------------------------------------------------------- service à service (application chauffeur)
  // L'application chauffeur (service séparé) demande ici qui est un chauffeur ACCEPTÉ. Champs minimaux : jamais de CIN, de photo ni de consentement.
  // Désactivé (503) tant que APP_SERVICE_KEY n'est pas défini. Clé comparée en temps constant.
  const serviceDigest = appServiceKey && String(appServiceKey).length >= 16 ? sha(appServiceKey) : null;
  const requireServiceKey = (req, res, next) => {
    if (!serviceDigest) return res.status(503).json({ error: "service_disabled" });
    if (!crypto.timingSafeEqual(sha(req.get("x-service-key") ?? ""), serviceDigest)) return res.status(401).json({ error: "unauthorized" });
    next();
  };
  const SERVICE_FIELDS = "ref, full_name, phone, plate, governorate, station, line_type, line_from, line_to_gov, line_via, pickup_en_route, leaves_partial, decided_at, lang";
  const serviceDriver = (r) => {
    let via = [];
    try { via = JSON.parse(r.line_via ?? "[]"); } catch { /* ancienne demande sans circuit structuré */ }
    return {
      ref: r.ref, full_name: r.full_name, phone: r.phone, plate: r.plate, governorate: r.governorate, station: r.station,
      line_type: r.line_type, line_from: r.line_from, line_to_gov: r.line_to_gov, line_via: Array.isArray(via) ? via : [],
      pickup_en_route: Boolean(r.pickup_en_route), leaves_partial: Boolean(r.leaves_partial), approved_at: r.decided_at ?? null,
      lang: r.lang === "fr" ? "fr" : "ar",
    };
  };
  // Un chauffeur « accepté » dont la collaboration n'est pas terminée. POST : le téléphone ne doit jamais apparaître dans une URL.
  app.post("/api/service/drivers/lookup", requireServiceKey, (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    const row = phone ? db.prepare(`SELECT ${SERVICE_FIELDS} FROM applications WHERE phone = ? AND status = 'approved' AND ended_at IS NULL AND role = 'driver'`).get(phone) : null;
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json({ driver: serviceDriver(row) });
  });
  app.post("/api/service/drivers/approved", requireServiceKey, (_req, res) => {
    const rows = db.prepare(`SELECT ${SERVICE_FIELDS} FROM applications WHERE status = 'approved' AND ended_at IS NULL AND role = 'driver' ORDER BY id`).all();
    res.json({ drivers: rows.map(serviceDriver) });
  });

  // ---------------------------------------------------------------- public
  // Identité de l'éditeur, durées de conservation : informations PUBLIQUES, lues par les pages légales.
  app.get("/api/legal", (_req, res) => res.json(legalValues(legalEnv)));
  app.get("/api/config", (_req, res) => {
    res.json({ whatsapp: process.env.WHATSAPP_NUMBER || null });
  });

  // ------------------------------------------------- vérification du téléphone
  const OTP_STATUS = { otp_cooldown: 429, otp_limit: 429, sms_unavailable: 503, sms_failed: 503 };

  app.post("/api/otp/send", limiter(60 * 60 * 1000, 10), async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: "validation", fields: { phone: "invalid_phone" } });
    const r = await otp.send(phone, req.body?.lang === "fr" ? "fr" : "ar");
    if (r.error) return res.status(OTP_STATUS[r.error] ?? 500).json(r);
    res.json(r);
  });

  app.post("/api/otp/verify", limiter(15 * 60 * 1000, 30), (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: "validation", fields: { phone: "invalid_phone" } });
    const r = otp.verify(phone, req.body?.code);
    res.status(r.error ? 400 : 200).json(r);
  });

  app.post(
    "/api/applications",
    limiter(60 * 60 * 1000, 10),
    (req, res, next) => {
      if (Number(req.headers["content-length"]) > MAX_REQUEST_BYTES) return res.set("Connection", "close").status(413).json({ error: "too_large" });
      next();
    },
    (req, res, next) =>
      upload(req, res, (err) => {
        if (!err) return next();
        if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "validation", fields: { [err.field]: "file_too_large" } });
        return res.status(400).json({ error: "validation", fields: { files: "file_type" } });
      }),
    (req, res) => {
      const { ok, values, errors } = validateApplication(req.body);
      const fields = { ...errors };
      const files = req.files || {};
      const required = ["cin_front", "cin_back", "permis"]; // la licence d'exploitation reste facultative (chauffeur propriétaire de son louage)
      const prepared = [];
      for (const kind of FILE_FIELDS) {
        const f = files[kind]?.[0];
        if (!f) {
          if (required.includes(kind)) fields[kind] = "file_required";
          continue;
        }
        const mime = sniffMime(f.buffer);
        const isSelfie = SELFIE_FIELDS.includes(kind);
        if (!mime || (isSelfie && mime === "application/pdf")) fields[isSelfie ? "selfies" : kind] = "file_type";
        else if (isSelfie && f.buffer.length > MAX_SELFIE_BYTES) fields.selfies = "selfie_too_large";
        else prepared.push({ kind, mime, buffer: f.buffer });
      }
      if (!fields.selfies && prepared.filter((p) => SELFIE_FIELDS.includes(p.kind)).length < MIN_SELFIES) fields.selfies = "selfie_required";
      const otpToken = String(req.body.otp_token ?? "");
      if (values.phone && !otp.peek(otpToken, values.phone)) fields.phone = "otp_required";
      if (!ok || Object.keys(fields).length) return res.status(400).json({ error: "validation", fields });

      const exists = db
        .prepare("SELECT 1 FROM applications WHERE (phone = ? OR cin = ?) AND status <> 'rejected'")
        .get(values.phone, values.cin);
      if (exists) return res.status(409).json({ error: "duplicate" });

      const written = [];
      try {
        db.exec("BEGIN");
        // Consommation atomique : un jeton ne sert qu'une fois, même si deux requêtes arrivent en même temps.
        if (!otp.consume(otpToken, values.phone)) {
          db.exec("ROLLBACK");
          return res.status(400).json({ error: "validation", fields: { phone: "otp_required" } });
        }
        let ref;
        do ref = newRef(); while (db.prepare("SELECT 1 FROM applications WHERE ref = ?").get(ref));
        const info = db
          .prepare(
            `INSERT INTO applications (ref, full_name, phone, cin, role, plate, governorate, station, route, line_type, line_from, line_to_gov, line_via, pickup_en_route, leaves_partial, lang, consent_at, consent_biometric_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .run(ref, values.full_name, values.phone, values.cin, values.role, values.plate, values.governorate, values.station, values.route, values.line_type, values.line_from, values.line_to_gov || null, JSON.stringify(values.line_via), values.pickup_en_route ? 1 : 0, values.leaves_partial ? 1 : 0, values.lang, new Date().toISOString(), new Date().toISOString());
        const appId = Number(info.lastInsertRowid);
        db.prepare("INSERT INTO kyc_checks (application_id) VALUES (?)").run(appId);
        const insertFile = db.prepare("INSERT INTO files (application_id, kind, stored_name, mime, size, enc, key_id) VALUES (?,?,?,?,?,?,?)");
        for (const p of prepared) {
          const saved = uploads.save(p.buffer, EXT[p.mime]);
          written.push(saved.stored_name);
          insertFile.run(appId, p.kind, saved.stored_name, p.mime, p.buffer.length, saved.enc, saved.key_id);
        }
        db.exec("COMMIT");
        kyc.kick();
        res.status(201).json({ ref, status: "pending" });
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* transaction déjà fermée */ }
        for (const w of written) uploads.remove(w);
        if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "duplicate" });
        console.error("[applications] échec insertion:", e.message);
        res.status(500).json({ error: "server" });
      }
    }
  );

  // POST et non GET : le téléphone et la référence ne doivent jamais apparaître dans une URL (journaux, historique, en-tête Referer).
  app.post("/api/status", limiter(15 * 60 * 1000, 30), (req, res) => {
    const ref = normalizeRef(req.body?.ref);
    const phone = normalizePhone(req.body?.phone);
    const row = ref && phone ? db.prepare("SELECT ref, status, public_note, created_at FROM applications WHERE ref = ? AND phone = ?").get(ref, phone) : null;
    if (!row) return res.status(404).json({ error: "not_found" });
    const interview = db
      .prepare("SELECT slot_start, room_url FROM interviews WHERE phone = ? AND status = 'booked' ORDER BY slot_start DESC LIMIT 1")
      .get(phone);
    res.json({ ...row, interview: interview || null });
  });

  // Droit à l'effacement : le chauffeur supprime lui-même sa demande. Référence + téléphone ne suffisent pas pour un acte irréversible :
  // il faut en plus le code reçu par SMS sur ce téléphone (même vérification que l'inscription).
  app.post("/api/applications/delete", limiter(60 * 60 * 1000, 10), (req, res) => {
    const ref = normalizeRef(req.body?.ref);
    const phone = normalizePhone(req.body?.phone);
    const row = ref && phone ? db.prepare("SELECT id, ref FROM applications WHERE ref = ? AND phone = ?").get(ref, phone) : null;
    if (!row) return res.status(404).json({ error: "not_found" });
    if (!otp.consume(String(req.body?.otp_token ?? ""), phone)) return res.status(400).json({ error: "otp_required" });
    erase(row.id);
    db.prepare("INSERT INTO admin_audit (ip, action, ref) VALUES ('self', 'application_self_delete', ?)").run(row.ref); // ni IP du chauffeur, ni données
    res.json({ ok: true });
  });

  const takenSlots = () => new Set(db.prepare("SELECT slot_start FROM interviews WHERE status = 'booked'").all().map((r) => r.slot_start));

  app.get("/api/slots", (_req, res) => res.json({ slots: listSlots(takenSlots()) }));

  // Circuits déjà déclarés par d'autres chauffeurs du même gouvernorat, pour pré-remplir le formulaire d'un coup plutôt que
  // tout retaper (et pour que les orthographes se regroupent : buildNetwork() les ramène déjà au nom officiel reconnu).
  // Jamais de nom ni de téléphone : seulement type de circuit, villes et nombre de chauffeurs.
  app.get("/api/circuits", limiter(60_000, 60), (req, res) => {
    const governorate = String(req.query.governorate ?? "");
    if (!GOVERNORATES.includes(governorate)) return res.status(400).json({ error: "invalid_governorate" });
    const entry = buildNetwork(networkRows()).find((g) => g.governorate === governorate);
    const circuits = [...(entry?.regional ?? []), ...(entry?.interregional ?? []), ...(entry?.rural ?? []), ...(entry?.national ?? [])]
      .sort((a, b) => b.drivers - a.drivers)
      .slice(0, 6)
      .map((l) => ({ type: l.type, from: l.from, to_gov: l.to_gov, via: l.via.map((v) => v.city), drivers: l.drivers }));
    res.json({ circuits });
  });

  app.post("/api/interviews", limiter(60 * 60 * 1000, 10), (req, res) => {
    const name = clean(req.body?.name, 80);
    const phone = normalizePhone(req.body?.phone);
    const question = clean(req.body?.question, 500) || null;
    const slot = String(req.body?.slot ?? "");
    const fields = {};
    if (name.length < 3) fields.name = "invalid_name";
    if (!phone) fields.phone = "invalid_phone";
    let appId = null;
    if (req.body?.ref) {
      const ref = normalizeRef(req.body.ref);
      const row = ref && phone ? db.prepare("SELECT id FROM applications WHERE ref = ? AND phone = ?").get(ref, phone) : null;
      if (!row) fields.ref = "invalid_ref";
      else appId = row.id;
    }
    if (Object.keys(fields).length) return res.status(400).json({ error: "validation", fields });

    if (!listSlots(takenSlots()).includes(slot)) return res.status(409).json({ error: "slot_unavailable" });
    const active = db.prepare("SELECT 1 FROM interviews WHERE phone = ? AND status = 'booked' AND slot_start > ?").get(phone, new Date().toISOString());
    if (active) return res.status(409).json({ error: "already_booked" });

    const base = process.env.JITSI_BASE || "https://meet.jit.si";
    const room_url = `${base}/LouageExpress-${crypto.randomBytes(9).toString("hex")}`;
    try {
      const info = db.prepare("INSERT INTO interviews (application_id, name, phone, slot_start, room_url, question) VALUES (?,?,?,?,?,?)").run(appId, name, phone, slot, room_url, question);
      // Confirmation par SMS SEULEMENT si le dossier a été retrouvé (référence + téléphone) : sinon n'importe qui ferait envoyer un SMS à n'importe quel numéro.
      if (appId) {
        const interviewId = Number(info.lastInsertRowid);
        const { lang } = db.prepare("SELECT lang FROM applications WHERE id = ?").get(appId);
        if (notifier.enqueue({ appId, phone, lang, kind: "interview_booked", params: { interview_id: interviewId, slot }, key: `booked:${interviewId}` })) notifier.kick();
      }
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "slot_unavailable" });
      console.error("[interviews] échec insertion:", e.message);
      return res.status(500).json({ error: "server" });
    }
    res.status(201).json({ slot_start: slot, room_url });
  });

  // ----------------------------------------------------------------- admin
  const adminLimiter = limiter(15 * 60 * 1000, 100);
  const adminDigest = sha(adminToken);
  const bearer = (req) => (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  // Qui fait la requête : un COMPTE nominatif dès qu'il en existe un ; avant cela (installation initiale), le jeton partagé ADMIN_TOKEN.
  // Une fois le premier compte créé, le jeton ne donne plus aucun accès : il ne reste qu'un moyen d'entrer, nominatif et à double authentification.
  const requireAdmin = (req, res, next) => {
    const presented = bearer(req);
    if (adminAuth.hasUsers()) {
      const s = adminAuth.authenticate(presented);
      if (!s) return res.status(401).json({ error: "unauthorized" });
      req.admin = { id: s.user.id, username: s.user.username, role: s.user.role, scope: s.scope, hash: s.hash, row: s.user };
      return next();
    }
    if (!crypto.timingSafeEqual(sha(presented), adminDigest)) return res.status(401).json({ error: "unauthorized" });
    req.admin = { id: null, username: "jeton-admin", role: "owner", scope: "full", legacy: true };
    next();
  };
  const requireFull = (req, res, next) => (req.admin.scope === "full" ? next() : res.status(403).json({ error: "setup_required", needs: adminAuth.needs(req.admin.row) }));
  const requireOwner = (req, res, next) => (req.admin.role === "owner" ? next() : res.status(403).json({ error: "forbidden_role" }));
  const admin = express.Router();
  // Journal d'accès : qui (IP) a consulté quoi (référence de dossier). Aucune donnée personnelle.
  const audit = (req, action, ref = null, actor = req.admin?.username ?? null) => db.prepare("INSERT INTO admin_audit (ip, action, ref, actor) VALUES (?,?,?,?)").run(req.ip ?? "", action, ref, actor);
  const ipGuard = (req, res, next) => (isAllowedAdminIp(req.ip, adminAllowedIps) ? next() : res.status(403).json({ error: "forbidden" }));
  // Seuls les ÉCHECS comptent : 10 mauvais jetons en 15 minutes bloquent l'IP, les requêtes réussies ne consomment rien.
  const failedAuthLimiter = rateLimits
    ? rateLimit({ windowMs: 15 * 60 * 1000, max: 10, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { error: "rate_limited" } })
    : (_req, _res, next) => next();
  admin.use(ipGuard, failedAuthLimiter, adminLimiter);

  // ---- Connexion (publique) : l'interface choisit entre le jeton (installation initiale) et les comptes
  admin.get("/mode", (_req, res) => res.json({ accounts: adminAuth.hasUsers() }));
  admin.post("/login", async (req, res) => {
    if (!adminAuth.hasUsers()) return res.status(409).json({ error: "no_accounts" });
    const body = req.body ?? {};
    let r;
    try {
      r = await adminAuth.login({ username: String(body.username ?? "").slice(0, 64), password: String(body.password ?? "").slice(0, 300), code: String(body.code ?? "").slice(0, 32) });
    } catch (e) {
      console.error("[admin] connexion impossible :", e.message); // ex. secret 2FA illisible (mauvaise DATA_KEY) : erreur franche, jamais une requête qui reste suspendue
      return res.status(500).json({ error: "server" });
    }
    if (r.error) {
      audit(req, "login_failed", null, r.actor ?? "(inconnu)"); // un nom saisi qui n'est pas un compte n'est jamais enregistré (c'est souvent un mot de passe mal placé)
      return res.status(401).json({ error: "invalid_credentials" });
    }
    audit(req, "login", null, r.user.username);
    res.json({ token: r.token, scope: r.scope, needs: r.needs, expires_at: r.expires_at, user: { username: r.user.username, display_name: r.user.display_name, role: r.user.role } });
  });

  admin.use(requireAdmin);

  // ---- Routes ouvertes aussi à une session « setup » (première connexion : mot de passe à changer, double authentification à activer)
  const accountsOnly = (req, res, next) => (req.admin.legacy ? res.status(409).json({ error: "legacy_token" }) : next());
  const setupState = (req) => {
    const row = db.prepare("SELECT * FROM admin_users WHERE id = ?").get(req.admin.id);
    const upgraded = adminAuth.upgradeIfDone(req.admin.hash);
    return { scope: upgraded ? "full" : req.admin.scope, needs: adminAuth.needs(row) };
  };
  admin.get("/me", (req, res) => {
    if (req.admin.legacy) return res.json({ user: { username: req.admin.username, role: "owner" }, scope: "full", needs: [], legacy: true });
    res.json({ user: adminAuth.publicUser(req.admin.row), scope: req.admin.scope, needs: adminAuth.needs(req.admin.row), recovery_codes_left: adminAuth.recoveryLeft(req.admin.id) });
  });
  admin.post("/logout", (req, res) => {
    if (!req.admin.legacy) adminAuth.logout(bearer(req));
    audit(req, "logout");
    res.json({ ok: true });
  });
  admin.post("/me/password", accountsOnly, async (req, res) => {
    const r = await adminAuth.changePassword(req.admin.id, req.body?.current, req.body?.next, req.admin.hash);
    if (r.error) return res.status(400).json(r);
    audit(req, "password_change");
    res.json({ ok: true, ...setupState(req) });
  });
  admin.post("/2fa/setup", accountsOnly, (req, res) => {
    const r = adminAuth.totpSetup(req.admin.id);
    if (r.error) return res.status(409).json(r);
    res.json(r);
  });
  admin.post("/2fa/confirm", accountsOnly, (req, res) => {
    const r = adminAuth.totpConfirm(req.admin.id, req.body?.code);
    if (r.error) return res.status(400).json(r);
    audit(req, "2fa_enabled");
    res.json({ ...r, ...setupState(req) });
  });

  admin.use(requireFull);

  // ---- Exploitation : file des louages, voyages, alertes SOS de l'application chauffeur (service séparé, appelé avec une clé de service)
  const opsBase = String(appOps.url ?? "").replace(/\/+$/, "");
  async function opsCall(path, { method = "GET", body } = {}) {
    if (!opsBase || !appOps.key) return { status: 503, body: { error: "ops_unavailable" } };
    try {
      const r = await (appOps.fetchImpl ?? fetch)(`${opsBase}/api/ops${path}`, {
        method, headers: { "X-Service-Key": appOps.key, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(6000),
      });
      return { status: r.status === 401 || r.status >= 500 ? 502 : r.status, body: await r.json().catch(() => ({})) };
    } catch {
      return { status: 503, body: { error: "ops_unavailable" } };
    }
  }
  const relay = (res, r) => res.status(r.status).json(r.body);
  admin.get("/ops/overview", async (req, res) => { audit(req, "ops_view"); relay(res, await opsCall("/overview")); });
  // « by » est TOUJOURS le compte connecté, jamais une valeur envoyée par le navigateur : l'accusé de réception porte le nom de la personne.
  admin.post("/ops/sos/:id/ack", async (req, res) => { audit(req, "sos_ack", req.params.id); relay(res, await opsCall(`/sos/${encodeURIComponent(req.params.id)}/ack`, { method: "POST", body: { by: req.admin.username } })); });
  admin.post("/ops/sos/:id/resolve", async (req, res) => { audit(req, "sos_resolve", req.params.id); relay(res, await opsCall(`/sos/${encodeURIComponent(req.params.id)}/resolve`, { method: "POST", body: { by: req.admin.username, note: String(req.body?.note ?? "").slice(0, 300) } })); });
  admin.post("/ops/drivers/sync", requireOwner, async (req, res) => { audit(req, "ops_drivers_sync"); relay(res, await opsCall("/drivers/sync", { method: "POST", body: {} })); });

  // ---- Gestion des comptes (propriétaires)
  const userId = (req) => Number(req.params.id);
  const usernameOf = (req) => adminAuth.listUsers().find((u) => u.id === userId(req))?.username ?? null;
  admin.get("/users", requireOwner, (_req, res) => res.json({ users: adminAuth.listUsers(), session: { idle_minutes: ADMIN_LIMITS.idleMs / 60_000, max_hours: ADMIN_LIMITS.sessionMs / 3_600_000 } }));
  admin.post("/users", requireOwner, async (req, res) => {
    const role = req.body?.role ?? "reviewer";
    if (!adminAuth.hasUsers() && role !== "owner") return res.status(400).json({ error: "first_must_be_owner" }); // sinon plus personne ne pourrait gérer les comptes
    const r = await adminAuth.createUser({ username: req.body?.username, displayName: req.body?.display_name, role });
    if (r.error) return res.status(r.error === "username_taken" ? 409 : 400).json(r);
    audit(req, "user_create", r.user.username);
    res.status(201).json(r);
  });
  admin.patch("/users/:id", requireOwner, (req, res) => {
    const r = adminAuth.updateUser(userId(req), { role: req.body?.role, active: req.body?.active }, req.admin.id);
    if (r.error) return res.status(r.error === "not_found" ? 404 : ["last_owner", "cannot_disable_self"].includes(r.error) ? 409 : 400).json(r);
    audit(req, "user_update", r.user.username);
    res.json(r);
  });
  admin.post("/users/:id/reset-password", requireOwner, async (req, res) => {
    const name = usernameOf(req);
    const r = await adminAuth.resetPassword(userId(req));
    if (r.error) return res.status(404).json(r);
    audit(req, "user_reset_password", name);
    res.json(r);
  });
  admin.post("/users/:id/reset-2fa", requireOwner, (req, res) => {
    const name = usernameOf(req);
    const r = adminAuth.resetTotp(userId(req));
    if (r.error) return res.status(404).json(r);
    audit(req, "user_reset_2fa", name);
    res.json(r);
  });
  admin.post("/users/:id/unlock", requireOwner, (req, res) => {
    const name = usernameOf(req);
    if (!adminAuth.unlock(userId(req))) return res.status(404).json({ error: "not_found" });
    audit(req, "user_unlock", name);
    res.json({ ok: true });
  });

  // État du chiffrement des pièces (empreintes de clés, fichiers à rechiffrer). Aucune clé n'y figure.
  admin.get("/security", requireOwner, (req, res) => {
    audit(req, "security_view");
    res.json(inspectKeys({ db, store: uploads }));
  });

  admin.get("/audit", requireOwner, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json({ entries: db.prepare("SELECT id, at, ip, action, ref, actor FROM admin_audit ORDER BY id DESC LIMIT ?").all(limit) });
  });

  admin.get("/applications", (req, res) => {
    const parsed = parseListQuery(req.query);
    if (parsed.error) return res.status(400).json({ error: "invalid_filter", field: parsed.error });
    audit(req, "applications_list"); // le texte recherché n'est jamais journalisé (il peut être un nom, un téléphone ou une CIN)
    res.json(queryApplications(db, parsed.filters));
  });

  // Réseau déclaré, classé par gouvernorat de départ (les 24 sont toujours listés, pour voir les trous).
  const networkRows = () => db.prepare("SELECT governorate, line_type, line_from, line_to_gov, line_via, pickup_en_route, leaves_partial, status FROM applications").all();
  admin.get("/network", (req, res) => {
    audit(req, "network_view");
    const network = buildNetwork(networkRows());
    const unclassified = db.prepare("SELECT COUNT(*) AS n FROM applications WHERE line_type IS NULL AND status <> 'rejected'").get().n;
    res.json({ governorates: network, unclassified });
  });
  admin.get("/network.csv", (req, res) => {
    audit(req, "network_export");
    res.type("text/csv; charset=utf-8").set("Content-Disposition", 'attachment; filename="reseau-louage.csv"').send(networkCsv(buildNetwork(networkRows())));
  });

  admin.get("/applications/:ref", (req, res) => {
    const a = db.prepare("SELECT * FROM applications WHERE ref = ?").get(req.params.ref);
    if (!a) return res.status(404).json({ error: "not_found" });
    audit(req, "application_view", a.ref);
    const files = db.prepare("SELECT id, kind, mime, size FROM files WHERE application_id = ?").all(a.id);
    const interviews = db.prepare("SELECT id, slot_start, room_url, question, status FROM interviews WHERE phone = ? ORDER BY slot_start DESC").all(a.phone);
    const k = db.prepare("SELECT * FROM kyc_checks WHERE application_id = ?").get(a.id);
    const kycOut = k && { ...k, reasons: JSON.parse(k.reasons) };
    const notifications = db.prepare("SELECT kind, status, created_at, sent_at FROM notifications WHERE application_id = ? ORDER BY id DESC LIMIT 10").all(a.id);
    res.json({ application: a, files, interviews, kyc: kycOut ?? null, notifications });
  });

  admin.patch("/applications/:ref", (req, res) => {
    const { status, public_note, admin_note } = req.body ?? {};
    if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: "invalid_status" });
    const ended = req.body?.ended;
    if (ended !== undefined && typeof ended !== "boolean") return res.status(400).json({ error: "invalid_ended" });
    const notify = req.body?.notify;
    if (notify !== undefined && typeof notify !== "boolean") return res.status(400).json({ error: "invalid_notify" });
    const cur = db.prepare("SELECT id, phone, lang, status, public_note, admin_note, decided_at, ended_at FROM applications WHERE ref = ?").get(req.params.ref);
    if (!cur) return res.status(404).json({ error: "not_found" });
    const next = status ?? cur.status;
    if (ended === true && next !== "approved") return res.status(409).json({ error: "not_approved" }); // la fin de collaboration ne concerne qu'un chauffeur accepté
    audit(req, "application_update", req.params.ref);
    const nowIso = new Date().toISOString();
    // Date de décision : posée quand le statut devient « accepté » ou « refusé », effacée si le dossier repasse en étude.
    const decided = next === "approved" || next === "rejected" ? (status !== undefined && status !== cur.status ? nowIso : cur.decided_at ?? nowIso) : null;
    const endedAt = next !== "approved" ? null : ended === undefined ? cur.ended_at : ended ? cur.ended_at ?? nowIso : null;
    db.prepare("UPDATE applications SET status = ?, public_note = ?, admin_note = ?, decided_at = ?, ended_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ref = ?").run(
      next,
      public_note === undefined ? cur.public_note : clean(public_note, 300) || null,
      admin_note === undefined ? cur.admin_note : clean(admin_note, 1000) || null,
      decided,
      endedAt,
      req.params.ref
    );
    // SMS au chauffeur quand le statut change vraiment (sauf si l'admin décoche « prévenir par SMS », par exemple pour corriger une erreur).
    const statusChanged = status !== undefined && status !== cur.status;
    const notified = statusChanged && notify !== false && ["approved", "rejected", "interview"].includes(next)
      && notifier.enqueue({ appId: cur.id, phone: cur.phone, lang: cur.lang, kind: `status_${next}` });
    if (notified) notifier.kick();
    // Décision finale prise : plus besoin de garder le visage du chauffeur (minimisation des données biométriques).
    if (status === "approved" || status === "rejected") {
      purgeSelfies(db, UPLOAD_DIR, db.prepare("SELECT id FROM applications WHERE ref = ?").get(req.params.ref).id);
    }
    res.json({ ok: true, notified });
  });

  admin.post("/applications/:ref/kyc/retry", (req, res) => {
    const a = db.prepare("SELECT id FROM applications WHERE ref = ?").get(req.params.ref);
    if (!a) return res.status(404).json({ error: "not_found" });
    audit(req, "kyc_retry", req.params.ref);
    if (!kyc.requeue(a.id)) return res.status(409).json({ error: "selfies_purged" });
    kyc.kick();
    res.json({ ok: true });
  });

  admin.delete("/applications/:ref", requireOwner, (req, res) => {
    const a = db.prepare("SELECT id FROM applications WHERE ref = ?").get(req.params.ref);
    if (!a) return res.status(404).json({ error: "not_found" });
    audit(req, "application_delete", req.params.ref);
    erase(a.id); // inclut les entretiens du même téléphone (autrefois conservés avec le nom et le téléphone)
    res.json({ ok: true });
  });

  admin.get("/files/:id", (req, res) => {
    const f = db
      .prepare("SELECT f.stored_name, f.mime, f.enc, f.key_id, a.ref FROM files f JOIN applications a ON a.id = f.application_id WHERE f.id = ?")
      .get(Number(req.params.id));
    if (!f) return res.status(404).json({ error: "not_found" });
    let bytes;
    try {
      bytes = uploads.read(f);
    } catch (e) {
      console.error("[files] lecture impossible:", e.message);
      return res.status(500).json({ error: "server" });
    }
    audit(req, "file_view", f.ref);
    // « sandbox » : même si un fichier piégé était ouvert directement, aucun script ne s'exécuterait.
    res.type(f.mime).set({ "Content-Disposition": "inline", "Content-Security-Policy": "default-src 'none'; sandbox" }).send(bytes);
  });

  admin.get("/interviews", (req, res) => {
    audit(req, "interviews_list");
    res.json({
      interviews: db.prepare("SELECT id, name, phone, slot_start, room_url, question, status FROM interviews WHERE status = 'booked' ORDER BY slot_start").all(),
    });
  });

  admin.patch("/interviews/:id", (req, res) => {
    const status = req.body?.status;
    if (!["booked", "done", "cancelled"].includes(status)) return res.status(400).json({ error: "invalid_status" });
    const info = db.prepare("UPDATE interviews SET status = ? WHERE id = ?").run(status, Number(req.params.id));
    if (!info.changes) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  });

  app.use("/api/admin", admin);
  app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

  // Revalidation ETag à chaque visite : un correctif déployé est visible tout de suite, et un 304 coûte quelques octets.
  app.use(express.static(path.join(here, "public"), { extensions: ["html"], maxAge: 0 }));

  // Page inconnue : vraie page 404 du site pour un navigateur, JSON pour le reste (clients d'API, écritures).
  app.use((req, res) => {
    if (req.method === "GET" && req.accepts(["html", "json"]) === "html") return sendPage(req, res, "404.html", 404);
    res.status(404).json({ error: "not_found" });
  });

  // Dernier filet : jamais de trace d'appel ni de détail interne dans les réponses.
  app.use((err, _req, res, _next) => {
    if (err.type === "entity.too.large") return res.status(413).json({ error: "too_large" });
    if (err.type === "entity.parse.failed" || (err.status >= 400 && err.status < 500)) return res.status(err.status ?? 400).json({ error: "bad_request" });
    console.error("[server] erreur inattendue:", err.message);
    res.status(500).json({ error: "server" });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertProductionConfig(process.env); // refuse de démarrer en production avec une configuration faible
  let token = process.env.ADMIN_TOKEN;
  if (!token) {
    token = crypto.randomBytes(24).toString("base64url");
    console.log(`[admin] ADMIN_TOKEN non défini — jeton temporaire pour cette exécution :\n        ${token}`);
  }
  const port = Number(process.env.PORT || 4100);
  if (!process.env.KYC_SERVICE_KEY) console.warn("[kyc] KYC_SERVICE_KEY non défini : le backend KYC doit accepter les appels sans clé (développement uniquement)");
  const app = createApp({ adminToken: token });
  app.locals.kyc.start();
  app.locals.retention.start();
  app.locals.notifier.start();
  // HOST=127.0.0.1 en production : seul le proxy local (Caddy / nginx) peut joindre l'application.
  const host = process.env.HOST || undefined;
  app.listen(port, host, () => console.log(`Portail chauffeurs — http://${host ?? "localhost"}:${port} (backend KYC : ${process.env.KYC_BACKEND_URL || "http://localhost:4000"})`));
}
