import express from "express";
import helmet from "helmet";
import cors from "cors";
import crypto from "node:crypto";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db.js";
import { log, safePath } from "./lib/log.js";
import { requireAuth, IDLE_MS } from "./lib/auth.js";
import { requireOwnedReferences } from "./lib/ownership.js";
import { validateInput } from "./lib/validate.js";
import { idempotency } from "./lib/idempotency.js";
import { authRouter } from "./routes/auth.js";
import { accountRouter } from "./routes/account.js";
import { tagsRouter } from "./routes/tags.js";
import { sessionsRouter } from "./routes/sessions.js";
import { budgetsRouter } from "./routes/budgets.js";
import { deadlinesRouter } from "./routes/deadlines.js";
import { pushRouter } from "./routes/push.js";
import { remindersRouter } from "./routes/reminders.js";
import { tasksRouter } from "./routes/tasks.js";
import { settingsRouter } from "./routes/settings.js";
import { cronRouter } from "./routes/cron.js";
import { notifyRouter } from "./routes/notify.js";
import { dataRouter } from "./routes/data.js";
import { googleAuthRouter } from "./routes/googleAuth.js";
import { qualityModelRouter } from "./routes/qualityModel.js";

export function allowedOrigins() {
  const raw = process.env.CORS_ORIGIN || "*";
  return raw === "*" ? null : raw.split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
}

export function createApp() {
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is not set - see .env.example.");
  }
  if (process.env.SESSION_SECRET.split(",")[0].length < 32) {
    log.warn("SESSION_SECRET is shorter than 32 characters - generate a longer random value");
  }
  const isProd = process.env.NODE_ENV === "production";
  const origins = allowedOrigins();
  if (!origins && isProd) {
    throw new Error(
      "CORS_ORIGIN must be set to your real frontend origin(s) in production (comma-separated) - refusing to start with a wildcard origin + credentialed cookies."
    );
  }

  const app = express();
  app.disable("x-powered-by");
  // Render puts exactly one proxy in front of the app; req.ip is then the
  // real client address (used by rate limiting and the audit log).
  app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 1));

  // Request id + one structured log line per request (method, redacted
  // path, status, duration, user) - searchable at 3am.
  app.use((req, res, next) => {
    req.id = req.get("x-request-id") || crypto.randomUUID();
    res.set("X-Request-Id", req.id);
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      if (req.path === "/health") return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      log[res.statusCode >= 500 ? "error" : "info"]("request", {
        id: req.id,
        method: req.method,
        path: safePath(req.originalUrl),
        status: res.statusCode,
        ms: Math.round(ms),
        user: req.userId || req.session?.userId || null,
      });
    });
    next();
  });

  // Pure JSON API: lock everything down, including a CSP that forbids
  // any content at all (nothing here is meant to render as a page).
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: "same-site" },
    })
  );
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    next();
  });

  app.use(express.json({ limit: "100kb" }));

  app.use(cors({ origin: origins || true, credentials: true }));

  // CSRF: the session cookie is SameSite=None in production (needed for a
  // Vercel/Render split), so the browser would attach it to a request
  // forged by any other site. Browsers always send Origin on cross-site
  // state-changing requests; reject any whose Origin isn't ours. Requests
  // with no Origin (curl, the external cron) are unaffected - they don't
  // carry a victim's cookie.
  app.use((req, res, next) => {
    if (!origins || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("origin");
    if (origin && !origins.includes(origin.replace(/\/$/, ""))) {
      return res.status(403).json({ error: "cross-origin request rejected" });
    }
    next();
  });

  const PgSession = connectPgSimple(session);
  app.use(
    session({
      store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true, pruneSessionInterval: 15 * 60 }),
      name: "focusdial.sid",
      secret: process.env.SESSION_SECRET.split(","), // comma-separated: newest first, older ones still verify (rotation)
      resave: false,
      saveUninitialized: false,
      rolling: true, // idle timeout: each request pushes expiry out by IDLE_MS
      cookie: {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? "none" : "lax",
        maxAge: IDLE_MS,
      },
    })
  );

  app.get("/health", (req, res) => res.json({ status: "ok" }));
  // Readiness: also proves the database answers. Point uptime checks here.
  app.get("/health/ready", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", db: "ok" });
    } catch {
      res.status(503).json({ status: "degraded", db: "unreachable" });
    }
  });

  // Unauthenticated: how a session is obtained (and password reset /
  // MFA verification for a half-finished login).
  app.use("/api", authRouter);
  // Unauthenticated, CRON_SECRET-protected. Must stay above requireAuth -
  // see the history in HANDOVER.md ("cron endpoint was unreachable").
  app.use("/api", cronRouter);

  // Everything below requires a signed-in user.
  app.use("/api", requireAuth, validateInput, requireOwnedReferences, idempotency);
  for (const router of [
    accountRouter,
    tagsRouter,
    sessionsRouter,
    budgetsRouter,
    deadlinesRouter,
    pushRouter,
    remindersRouter,
    tasksRouter,
    settingsRouter,
    notifyRouter,
    dataRouter,
    qualityModelRouter,
    googleAuthRouter,
  ]) {
    app.use("/api", router);
  }

  app.use("/api", (req, res) => res.status(404).json({ error: "not found" }));

  // Last-resort error handler: every thrown/rejected error lands here (see
  // lib/asyncRouter.js) and becomes a response for that one request
  // instead of a crashed process.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "request body is not valid JSON" });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "request body is too large" });
    if (err.code === "23514") return res.status(400).json({ error: "that value isn't allowed" }); // CHECK violation
    if (err.code === "22P02" || err.code === "22007" || err.code === "22008") return res.status(400).json({ error: "invalid value" });
    log.error("unhandled request error", { id: req.id, path: safePath(req.originalUrl), err });
    if (res.headersSent) return;
    res.status(500).json({ error: "something went wrong on our side - please try again", requestId: req.id });
  });

  return app;
}
