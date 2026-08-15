import "dotenv/config";
import express from "express";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { initSchema, pool } from "./db.js";
import { requireAuth } from "./lib/auth.js";
import { authRouter } from "./routes/auth.js";
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

if (!process.env.SESSION_SECRET) {
  throw new Error(
    "SESSION_SECRET is not set. Required now that this app has real user accounts - see .env.example."
  );
}

const app = express();

// Behind Render (and most PaaS) there's a reverse proxy in front of the
// app - without this, Express never sees the connection as "secure" even
// when the original request really was HTTPS, which breaks
// secure-cookie sessions in production.
app.set("trust proxy", 1);

app.use(express.json());

const corsOrigin = process.env.CORS_ORIGIN || "*";
if (corsOrigin === "*" && process.env.NODE_ENV === "production") {
  // Reflecting any Origin (origin: true) while credentials: true is set
  // means any website can make cookie-authenticated requests to this API
  // from a victim's browser - effectively CSRF against the whole API.
  // That's only safe-ish for local dev, so refuse to boot with it in
  // production rather than silently falling back to it.
  throw new Error(
    "CORS_ORIGIN must be set to your real frontend origin(s) in production (comma-separated for multiple) " +
      " - refusing to start with a wildcard origin + credentialed cookies. See .env.example."
  );
}
// credentials: true is required for the session cookie to actually be
// sent/accepted cross-origin (frontend on Vercel, backend on Render) - // origin: true (reflecting the request's actual Origin header) is
// required alongside it, since credentialed requests can't use a
// literal "*" origin. Outside production this still defaults to "*" for
// local-dev convenience (see the guard above for why that's only OK there).
app.use(cors({ origin: corsOrigin === "*" ? true : corsOrigin.split(","), credentials: true }));

const PgSession = connectPgSimple(session);
app.use(
  session({
    store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
    name: "focusdial.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // "none" is required for a cross-origin frontend/backend split
      // (Vercel + Render) to actually receive the cookie, but that in
      // turn requires secure: true (HTTPS-only) - not satisfiable over
      // plain http://localhost during local dev, hence the NODE_ENV
      // branch below.
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  })
);

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Unauthenticated by design: this is how a session is obtained in the
// first place (register/login/Google sign-in), so it can't itself
// require one.
app.use("/api", authRouter);

// Also unauthenticated by design, and registered here - BEFORE any of
// the requireAuth-gated routers below - deliberately, not incidentally.
// app.use('/api', requireAuth, someRouter) applies requireAuth to every
// request matching the '/api' prefix that reaches that point in the
// stack, not just someRouter's own paths - Express doesn't peek ahead to
// see whether someRouter would've actually matched before running the
// middleware in front of it. Registering cronRouter after those routers
// (as this once was) meant the very first requireAuth in the chain
// intercepted every unauthenticated /api/* request, including this one,
// before cronRouter ever got a turn - a real bug that shipped once and
// broke the external cron trigger. This is hit by an external scheduler
// (e.g. cron-job.org), not a logged-in browser, so it uses its own
// CRON_SECRET query-param check instead (see routes/cron.js) - it must
// stay above the requireAuth block below to actually take effect.
app.use("/api", cronRouter);

// Every other data route requires a signed-in user from here down.
app.use("/api", requireAuth, tagsRouter);
app.use("/api", requireAuth, sessionsRouter);
app.use("/api", requireAuth, budgetsRouter);
app.use("/api", requireAuth, deadlinesRouter);
app.use("/api", requireAuth, pushRouter);
app.use("/api", requireAuth, remindersRouter);
app.use("/api", requireAuth, tasksRouter);
app.use("/api", requireAuth, settingsRouter);
app.use("/api", requireAuth, notifyRouter);
app.use("/api", requireAuth, dataRouter);
// Calendar *linking* (as opposed to /auth/google/login/* in authRouter
// above, which is how you sign in at all) still requires an existing
// FocusDial session - you have to already be logged in to connect a
// calendar to your account.
app.use("/api", requireAuth, googleAuthRouter);

async function main() {
  await initSchema();
  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`focus tracker API listening on :${port}`);
  });
}

main().catch((err) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});
