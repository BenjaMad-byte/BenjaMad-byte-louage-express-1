// Service d'application chauffeur : connexion, état du voyage, synchronisation hors ligne, SOS, exploitation.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { db } from "./db.js";
import { createOtpService } from "../driver-portal/otp.js";
import { createSmsProvider } from "../driver-portal/sms.js";
import { normalizePhone } from "../driver-portal/validate.js";
import { sameOriginGuard } from "../driver-portal/security.js";
import { assertAppConfig, parseEmergency, parsePhones } from "./config.js";
import { createPortalClient } from "./portal-client.js";
import { createDriverAuth } from "./auth.js";
import { createSosService } from "./sos.js";
import { createActionService, buildState, MAX_BATCH } from "./actions.js";
import { tripsOfLine } from "./trips.js";
import { createReservations } from "./reservations.js";
import { createSva, signCallback, verifyCallbackSignature, OPERATORS, DEPOSITS_MILLIMES } from "./sva.js";
import * as E from "./public/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const csvList = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

export function createApp({
  portal, sms, otpSecret = process.env.OTP_SECRET, now = Date.now,
  sosPhones = parsePhones(process.env.SOS_ALERT_PHONES), emergency = parseEmergency(process.env.EMERGENCY_NUMBERS),
  opsKey = process.env.OPS_SERVICE_KEY, rateLimits = true, sva, svaSecret = process.env.SVA_CALLBACK_SECRET, reservationsEnabled = process.env.RESERVATIONS === "on",
  holdMs = 3 * 60_000, appUrl = process.env.PUBLIC_URL,
  forceHttps = process.env.NODE_ENV === "production", trustProxy = process.env.TRUST_PROXY, allowedOrigins = csvList(process.env.ALLOWED_ORIGINS),
} = {}) {
  const portalClient = portal ?? createPortalClient({ url: process.env.PORTAL_URL, key: process.env.APP_SERVICE_KEY });
  const smsProvider = sms ?? createSmsProvider();
  const otp = createOtpService({ db, sms: smsProvider, secret: otpSecret || crypto.randomBytes(32).toString("hex"), now });
  const auth = createDriverAuth({ db, portal: portalClient, otp, sms: smsProvider, appUrl, now });
  const sos = createSosService({ db, sms: smsProvider, alertPhones: sosPhones, now });
  const svaProvider = sva ?? (reservationsEnabled ? createSva() : null);
  const reservations = createReservations({ db, sva: svaProvider, sms: smsProvider, now, holdMs });
  const hooks = reservations.hooks;
  const actions = createActionService({ db, sos, hooks, now });
  const opsDigest = opsKey && String(opsKey).length >= 16 ? sha(opsKey) : null;

  const app = express();
  Object.assign(app.locals, { auth, sos, actions, otp, hooks, reservations, sva: svaProvider });
  app.disable("x-powered-by");
  if (trustProxy !== undefined && trustProxy !== "") app.set("trust proxy", Number(trustProxy));

  app.get("/healthz", (_req, res) => {
    try {
      db.prepare("SELECT 1").get();
      res.set("Cache-Control", "no-store").json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

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
          "img-src": ["'self'", "data:"],
          "connect-src": ["'self'"],
          "manifest-src": ["'self'"],
          "worker-src": ["'self'"],
          "form-action": ["'self'"],
          "frame-ancestors": ["'none'"],
          "base-uri": ["'self'"],
          "object-src": ["'none'"],
          ...(forceHttps ? { "upgrade-insecure-requests": [] } : {}),
        },
      },
    })
  );
  // Position : seulement pour ce site (SOS). Caméra et micro jamais.
  app.use((_req, res, next) => { res.set("Permissions-Policy", "geolocation=(self), camera=(), microphone=()"); next(); });
  app.use("/api", sameOriginGuard({ allowed: allowedOrigins }));
  // Corps brut conservé : la signature des callbacks de l'opérateur se calcule sur les octets exacts reçus.
  app.use(express.json({ limit: "256kb", verify: (req, _res, buf) => { req.rawBody = buf; } })); // un lot de 200 actions tient largement
  app.use("/api", (_req, res, next) => { res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }); next(); });

  const bearer = (req) => (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  /** Limite par APPAREIL (jeton) quand il est connu : des chauffeurs derrière la même adresse de l'opérateur ne doivent pas se bloquer entre eux. */
  const limiter = (windowMs, max, byToken = false) =>
    rateLimits
      ? rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: "rate_limited" }, validate: { keyGeneratorIpFallback: false }, keyGenerator: (req) => (byToken && bearer(req) ? `t:${sha(bearer(req)).toString("hex")}` : `ip:${req.ip}`) })
      : (_req, _res, next) => next();

  // ---------------------------------------------------------------- connexion : matricule + mot de passe au quotidien
  const OTP_STATUS = { otp_cooldown: 429, otp_limit: 429, sms_unavailable: 503, sms_failed: 503 };
  const sessionReply = (r) => ({ token: r.token, expires_at: r.expires_at, name: r.driver.full_name, plate: r.driver.plate });

  app.post("/api/auth/login", limiter(15 * 60_000, 20, false), async (req, res) => {
    const r = await auth.login({ plate: req.body?.plate, password: req.body?.password, device: req.body?.device });
    if (r.error) return res.status(r.error === "not_activated" ? 409 : 401).json({ error: r.error });
    res.json(sessionReply(r));
  });

  // ---- Activation (lien personnel reçu par SMS à l'acceptation) : voir auth.js (sendActivationSms)
  app.post("/api/auth/activation", limiter(60_000, 30), (req, res) => {
    const info = auth.activationInfo(req.body?.token);
    if (info.error) return res.status(410).json(info);
    res.json({ name: info.driver.full_name, plate: info.driver.plate });
  });
  app.post("/api/auth/activation/finish", limiter(15 * 60_000, 20), async (req, res) => {
    const r = await auth.finishActivation({ token: req.body?.token, password: req.body?.password, device: req.body?.device });
    if (r.error) return res.status(r.error === "token_invalid" ? 410 : 400).json(r);
    res.json(sessionReply(r));
  });

  // ---- Mot de passe oublié : code SMS (même service que le site d'inscription) puis nouveau mot de passe.
  // Le code part pour n'importe quel numéro (comme /api/otp/send du portail) : l'existence d'un compte ne se confirme qu'à l'étape suivante.
  app.post("/api/auth/recover/send-code", limiter(60 * 60_000, 10), async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: "invalid_phone" });
    const r = await otp.send(phone, req.body?.lang === "fr" ? "fr" : "ar");
    if (r.error) return res.status(OTP_STATUS[r.error] ?? 500).json(r);
    res.json(r);
  });
  const RECOVER_STATUS = { otp_invalid: 400, otp_expired: 400, otp_locked: 400, otp_required: 400, not_found: 404 };
  app.post("/api/auth/recover/reset", limiter(15 * 60_000, 20), async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: "invalid_phone" });
    const r = await auth.recoverReset({ phone, code: req.body?.code, password: req.body?.password, device: req.body?.device });
    if (r.error) return res.status(RECOVER_STATUS[r.error] ?? 400).json(r);
    res.json(sessionReply(r));
  });

  const requireDriver = (req, res, next) => {
    const driver = auth.authenticate(bearer(req));
    if (!driver) return res.status(401).json({ error: "unauthorized" });
    req.driver = driver;
    next();
  };

  app.post("/api/auth/logout", requireDriver, (req, res) => res.json({ ok: auth.logout(bearer(req)) }));

  // ---------------------------------------------------------------- chauffeur
  const state = (driver) => buildState(db, driver, { now, emergency, codeOf: reservations.codeOfBoarding });
  app.get("/api/driver/state", limiter(60_000, 120, true), requireDriver, (req, res) => res.json(state(req.driver)));

  // Rejeu des actions faites hors ligne (et envoi de chaque action en ligne) : voir actions.js pour les règles.
  app.post("/api/driver/sync", limiter(60_000, 120, true), requireDriver, (req, res) => {
    const list = req.body?.actions;
    if (!Array.isArray(list)) return res.status(400).json({ error: "actions_required" });
    if (list.length > MAX_BATCH) return res.status(413).json({ error: "too_many_actions", max: MAX_BATCH });
    const results = actions.applyBatch(req.driver, list);
    res.json({ results, state: state(req.driver) });
  });

  // ---------------------------------------------------------------- passagers (réservations en ligne)
  // Désactivé (503) tant que RESERVATIONS=on n'est pas posé : en production il faut en plus un vrai fournisseur SVA, qui n'existe pas encore.
  const passenger = express.Router();
  passenger.use((_req, res, next) => (reservationsEnabled ? next() : res.status(503).json({ error: "reservations_disabled" })));
  passenger.get("/lines", limiter(60_000, 60), (_req, res) => res.json({ lines: reservations.publicLines(), operators: OPERATORS, deposits: DEPOSITS_MILLIMES }));
  const RES_ERRORS = { invalid_phone: 400, invalid_operator: 400, invalid_deposit: 400, invalid_stops: 400, unknown_line: 404, too_many_active: 429, no_trip_available: 409, sva_unavailable: 503 };
  passenger.post("/reservations", limiter(60 * 60_000, 20), async (req, res) => {
    const b = req.body ?? {};
    const r = await reservations.create({ lineId: b.lineId, fromName: b.from, toName: b.to, phone: normalizePhone(b.phone), operator: b.operator, depositMillimes: b.deposit, lang: b.lang });
    if (r.error) return res.status(RES_ERRORS[r.error] ?? 400).json(r);
    res.status(201).json(r);
  });
  passenger.post("/reservations/status", limiter(15 * 60_000, 60), (req, res) => {
    const v = reservations.status({ code: req.body?.code, phone: normalizePhone(req.body?.phone) });
    v ? res.json({ reservation: v }) : res.status(404).json({ error: "not_found" });
  });
  passenger.post("/reservations/cancel", limiter(15 * 60_000, 20), async (req, res) => {
    const r = await reservations.cancel({ code: req.body?.code, phone: normalizePhone(req.body?.phone) });
    res.status(r.error === "not_found" ? 404 : r.error ? 409 : 200).json(r);
  });
  app.use("/api/passenger", passenger);

  // Résultat du prélèvement, envoyé par l'opérateur. Signature HMAC du corps brut obligatoire ; sans secret configuré, la route est fermée.
  app.post("/api/sva/callback", limiter(60_000, 120), async (req, res) => {
    if (!svaSecret) return res.status(503).json({ error: "callbacks_disabled" });
    if (!verifyCallbackSignature(req.rawBody ?? Buffer.alloc(0), req.get("x-signature"), svaSecret)) return res.status(401).json({ error: "bad_signature" });
    const r = await reservations.handleCallback({ reservationId: req.body?.reservationId, status: req.body?.status, providerRef: req.body?.providerRef });
    res.status(r.error === "not_found" ? 404 : r.error ? 400 : 200).json(r);
  });

  // Démonstration : l'opérateur SIMULÉ « répond » sur demande. N'existe ni en production ni avec un vrai fournisseur.
  if (process.env.NODE_ENV !== "production" && svaProvider?.name === "simulated") {
    app.post("/api/demo/sva/settle", limiter(60_000, 60), async (req, res) => {
      const id = req.body?.reservationId;
      const charge = svaProvider.charges.get(id);
      if (!charge) return res.status(404).json({ error: "not_found" });
      res.json(await reservations.handleCallback({ reservationId: id, status: charge.willFail ? "failed" : "success", providerRef: charge.providerRef }));
    });
    // Même chose depuis la page de démonstration passager, qui ne connaît que son code et son téléphone.
    app.post("/api/demo/sva/settle-by-code", limiter(60_000, 60), async (req, res) => {
      const r = reservations.byCode(req.body?.code);
      if (!r || r.passenger_phone !== normalizePhone(req.body?.phone) || !svaProvider.charges.get(r.id)) return res.status(404).json({ error: "not_found" });
      const charge = svaProvider.charges.get(r.id);
      res.json(await reservations.handleCallback({ reservationId: r.id, status: charge.willFail ? "failed" : "success", providerRef: charge.providerRef }));
    });
  }

  // ---------------------------------------------------------------- exploitation (appelée par la console d'administration du site d'inscription)
  const requireOps = (req, res, next) => {
    if (!opsDigest) return res.status(503).json({ error: "service_disabled" });
    if (!safeEqual(req.get("x-service-key") ?? "", opsKey)) return res.status(401).json({ error: "unauthorized" });
    next();
  };
  const ops = express.Router();
  ops.use(requireOps);

  ops.get("/overview", (_req, res) => {
    const lines = db.prepare("SELECT * FROM lines ORDER BY from_gov, from_name").all().map((l) => {
      const trips = tripsOfLine(db, l.id);
      const drv = (id) => db.prepare("SELECT full_name, plate, phone FROM drivers WHERE id = ?").get(id);
      const show = (t, rank) => ({ rank, plate: drv(t.driverId).plate, driver: drv(t.driverId).full_name, status: t.status, currentStop: t.currentStop, stops: t.stops, ...E.summary(t) });
      return {
        id: l.id, from: l.from_name, fromGov: l.from_gov, toGov: l.to_gov, type: l.line_type,
        queue: E.orderQueue(trips).map((t, i) => show(t, i + 1)),
        enRoute: trips.filter((t) => t.status === "en_route").map((t) => show(t, null)),
      };
    }).filter((l) => l.queue.length || l.enRoute.length);
    const drivers = db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(active), 0) AS active FROM drivers").get();
    res.json({ now: new Date(now()).toISOString(), drivers: { total: drivers.total, active: drivers.active }, reservations: reservations.counts(), lines, sos: sos.list({ limit: 50 }) });
  });

  ops.get("/sos", (req, res) => res.json({ sos: sos.list({ limit: req.query.limit }) }));
  const opsBy = (req) => String(req.body?.by ?? "").trim().slice(0, 40) || "équipe";
  ops.post("/sos/:id/ack", (req, res) => {
    const r = sos.ack(req.params.id, opsBy(req));
    res.status(r.error === "not_found" ? 404 : r.error ? 409 : 200).json(r);
  });
  ops.post("/sos/:id/resolve", (req, res) => {
    const r = sos.resolve(req.params.id, opsBy(req), req.body?.note);
    res.status(r.error === "not_found" ? 404 : r.error ? 409 : 200).json(r);
  });
  ops.post("/drivers/sync", async (_req, res) => {
    try {
      res.json(await auth.syncApproved());
    } catch (e) {
      res.status(503).json({ error: e.code ?? "portal_unreachable" });
    }
  });
  ops.post("/drivers/:id/resend-activation", async (req, res) => {
    const r = await auth.resendActivation(Number(req.params.id));
    res.status(r.error === "not_found" ? 404 : 200).json(r);
  });
  ops.post("/drivers/:id/revoke", (req, res) => {
    const id = Number(req.params.id);
    if (!auth.byId(id)) return res.status(404).json({ error: "not_found" });
    db.prepare("UPDATE drivers SET active = 0 WHERE id = ?").run(id);
    auth.revokeAll(id);
    res.json({ ok: true });
  });
  app.use("/api/ops", ops);

  // ---------------------------------------------------------------- application (fichiers statiques)
  const publicDir = path.join(here, "public");
  // __BUILD__ du service worker = empreinte des fichiers de l'application : un fichier modifié change le service worker, donc la nouvelle version s'installe d'un bloc.
  const buildId = () => {
    const hash = crypto.createHash("sha256");
    for (const f of fs.readdirSync(publicDir).sort()) if (f !== "sw.js") hash.update(f).update(fs.readFileSync(path.join(publicDir, f)));
    return hash.digest("hex").slice(0, 16);
  };
  app.get("/sw.js", (_req, res) => {
    const source = fs.readFileSync(path.join(publicDir, "sw.js"), "utf8").replace("__BUILD__", buildId());
    res.set({ "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" }).type("js").send(source);
  });
  // Lien d'activation envoyé par SMS (voir auth.js → sendActivationSms) : même page que l'accueil, le client lit « ?jeton= ».
  app.get("/activer", (_req, res) => res.set("Cache-Control", "no-cache").sendFile(path.join(publicDir, "index.html")));
  app.use(express.static(publicDir, { index: "index.html", setHeaders: (res) => res.set("Cache-Control", "no-cache") }));

  app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((err, _req, res, _next) => {
    if (err.type === "entity.too.large") return res.status(413).json({ error: "too_large" });
    if (err.type === "entity.parse.failed" || (err.status >= 400 && err.status < 500)) return res.status(err.status ?? 400).json({ error: "bad_request" });
    console.error("[server] erreur inattendue:", err.message);
    res.status(500).json({ error: "server" });
  });

  /** Tâches de fond : synchronisation des chauffeurs acceptés, relance des SOS sans accusé de réception. */
  app.locals.start = ({ syncEveryMs = 10 * 60_000 } = {}) => {
    sos.start();
    const minute = setInterval(() => { try { reservations.expire(); } catch (e) { console.error(`[reservations] expiration impossible : ${e.message}`); } }, 30_000);
    minute.unref?.();
    const daily = setInterval(() => { try { reservations.purgeOld(); } catch (e) { console.error(`[reservations] purge impossible : ${e.message}`); } }, 24 * 3_600_000);
    daily.unref?.();
    const sync = () => auth.syncApproved().catch((e) => console.error(`[chauffeurs] synchronisation impossible : ${e.message}`));
    const timer = setInterval(sync, syncEveryMs);
    timer.unref?.();
    setTimeout(sync, 5000).unref?.();
  };
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertAppConfig(process.env);
  const app = createApp();
  app.locals.start();
  const port = Number(process.env.PORT || 4200);
  const host = process.env.HOST || undefined;
  app.listen(port, host, () => console.log(`Application chauffeur — http://${host ?? "localhost"}:${port}`));
}
