import { Router } from "express";
import { pool } from "../db.js";
import { hashPassword, verifyPassword, isValidPassword } from "../lib/auth.js";
import { googleLoginConfigured, getLoginAuthUrl, exchangeLoginCode } from "../lib/google.js";
import { loginRateLimit, registerRateLimit } from "../lib/rateLimit.js";

export const authRouter = Router();

function publicUser(row) {
  return { id: row.id, email: row.email, displayName: row.display_name };
}

authRouter.get("/auth/config", (req, res) => {
  res.json({ googleLoginEnabled: googleLoginConfigured });
});

authRouter.post("/auth/register", registerRateLimit, async (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ error: "a valid email is required" });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }
  const client = await pool.connect();
  try {
    const passwordHash = await hashPassword(password);
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING *`,
      [email.trim().toLowerCase(), passwordHash, displayName || null]
    );
    await client.query(`INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [rows[0].id]);
    await client.query("COMMIT");
    req.session.userId = rows[0].id;
    res.status(201).json(publicUser(rows[0]));
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") {
      // unique_violation on users.email
      return res.status(409).json({ error: "an account with that email already exists" });
    }
    console.error(err);
    res.status(500).json({ error: "failed to register" });
  } finally {
    client.release();
  }
});

authRouter.post("/auth/login", loginRateLimit, async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "email and password are required" });
  }
  try {
    const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email.trim().toLowerCase()]);
    const user = rows[0];
    // Same generic error whether the email doesn't exist, has no
    // password set (Google-only account), or the password is wrong - // distinguishing those in the response would let someone probe
    // which emails have accounts.
    if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: "incorrect email or password" });
    }
    req.session.userId = user.id;
    res.json(publicUser(user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to log in" });
  }
});

authRouter.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("focusdial.sid");
    res.json({ ok: true });
  });
});

authRouter.get("/auth/me", async (req, res) => {
  if (!req.session?.userId) return res.json({ user: null });
  try {
    const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [req.session.userId]);
    if (rows.length === 0) return res.json({ user: null });
    res.json({ user: publicUser(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load account" });
  }
});

// Not mounted behind requireAuth (this whole router isn't - see
// index.js), so it checks the session itself, same as /auth/me above.
authRouter.patch("/auth/me", async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: "not signed in" });
  const { displayName } = req.body || {};
  if (typeof displayName !== "string" || displayName.trim().length === 0) {
    return res.status(400).json({ error: "a name is required" });
  }
  if (displayName.trim().length > 80) {
    return res.status(400).json({ error: "name must be 80 characters or fewer" });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE users SET display_name = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [displayName.trim(), req.session.userId]
    );
    if (rows.length === 0) return res.status(401).json({ error: "not signed in" });
    res.json(publicUser(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to update account" });
  }
});

authRouter.get("/auth/google/login/start", (req, res) => {
  if (!googleLoginConfigured) {
    return res.status(503).json({ error: "Google sign-in is not configured on this server" });
  }
  res.redirect(getLoginAuthUrl());
});

authRouter.get("/auth/google/login/callback", async (req, res) => {
  const frontendUrl = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
  const redirectTo = (status) => res.redirect(`${frontendUrl}/?authResult=${status}`);

  if (!googleLoginConfigured) return res.status(503).send("Google sign-in is not configured");
  const { code, error } = req.query;
  if (error) return redirectTo("error");
  if (!code) return res.status(400).send("missing code");

  try {
    const { googleSub, email, name } = await exchangeLoginCode(code);

    // Recognize the same person by google_sub first (stable across
    // email changes), then fall back to matching an existing
    // email/password account and linking it - so someone who registered
    // with a password can start using "Sign in with Google" later
    // without ending up with two separate accounts.
    let { rows } = await pool.query(`SELECT * FROM users WHERE google_sub = $1`, [googleSub]);
    if (rows.length === 0) {
      const byEmail = await pool.query(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
      if (byEmail.rows.length > 0) {
        const linked = await pool.query(`UPDATE users SET google_sub = $1, updated_at = now() WHERE id = $2 RETURNING *`, [
          googleSub,
          byEmail.rows[0].id,
        ]);
        rows = linked.rows;
      } else {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const created = await client.query(
            `INSERT INTO users (email, google_sub, display_name) VALUES ($1, $2, $3) RETURNING *`,
            [email.toLowerCase(), googleSub, name]
          );
          await client.query(`INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [
            created.rows[0].id,
          ]);
          await client.query("COMMIT");
          rows = created.rows;
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      }
    }

    req.session.userId = rows[0].id;
    redirectTo("success");
  } catch (err) {
    console.error("google login callback failed:", err.message);
    redirectTo("error");
  }
});
