import { Router } from "express";
import crypto from "node:crypto";
import { pool } from "../db.js";
import {
  googleConfigured,
  getAuthUrl,
  exchangeCodeForTokens,
  buildClientWithTokens,
  fetchConnectedEmail,
  getCalendarClient,
  fetchSyncTokenBaseline,
  pushItemToGoogle,
} from "../lib/google.js";

export const googleAuthRouter = Router();

googleAuthRouter.get("/auth/google/status", async (req, res) => {
  if (!googleConfigured) return res.json({ configured: false, connected: false });
  try {
    const { rows } = await pool.query(`SELECT email, connected_at FROM google_account WHERE user_id = $1`, [
      req.userId,
    ]);
    const account = rows[0];
    res.json({
      configured: true,
      connected: Boolean(account),
      email: account?.email || null,
      connectedAt: account?.connected_at || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load google account status" });
  }
});

googleAuthRouter.get("/auth/google/start", (req, res) => {
  if (!googleConfigured) {
    return res.status(503).json({ error: "Google Calendar linking is not configured on this server" });
  }
  // `state` is a random anti-CSRF nonce, bound to this session, and
  // verified (not trusted as an identity) on the way back in
  // /auth/google/callback below. It is never used to decide *whose*
  // account the tokens get attached to - that always comes from the
  // authenticated session (req.userId), which requireAuth already
  // guarantees is present for this route.
  const nonce = crypto.randomUUID();
  req.session.googleOAuthState = nonce;
  res.redirect(getAuthUrl(nonce));
});

googleAuthRouter.get("/auth/google/callback", async (req, res) => {
  const frontendUrl = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
  // &tab=settings is safe to hardcode here (rather than round-tripping
  // the tab the user actually started from) because Connect/Disconnect
  // only ever appears in Settings - there's no other page this flow can
  // begin from. Without it, App.jsx's initial-tab logic defaults back to
  // "today", so a successful connect looked like it silently did nothing
  // since the confirmation lives on a tab the user was no longer on.
  const redirectTo = (status) => res.redirect(`${frontendUrl}/?googleAuth=${status}&tab=settings`);

  if (!googleConfigured) return res.status(503).send("Google Calendar linking is not configured");
  const { code, error, state } = req.query;
  if (error) return redirectTo("error");
  if (!code) return res.status(400).send("missing code");

  // Verify `state` against the nonce this same session generated in
  // /auth/google/start - this is what actually defends against CSRF on
  // the callback. It is deliberately NOT used to pick whose account the
  // tokens get saved to; that identity always comes from req.userId
  // (the authenticated session), never from a request-controllable
  // param. Consuming it here (delete, single-use) also stops replay of
  // an old callback URL.
  const expectedState = req.session.googleOAuthState;
  delete req.session.googleOAuthState;
  if (!expectedState || state !== expectedState) {
    return redirectTo("error");
  }
  const userId = req.userId;

  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      // Google only re-issues a refresh_token when there isn't already
      // one on file for this app+account, even with prompt=consent, in
      // some edge cases. Without one the connection can't survive the
      // ~1h access-token expiry, so this is treated as a failed connect
      // rather than silently storing something that breaks later - // disconnecting any existing grant at https://myaccount.google.com/permissions
      // before retrying forces a fresh one.
      return redirectTo("error");
    }

    const authClient = buildClientWithTokens(tokens);
    const email = await fetchConnectedEmail(authClient).catch(() => null);

    await pool.query(
      `INSERT INTO google_account (email, access_token, refresh_token, token_expiry, connected_at, updated_at, user_id)
       VALUES ($1, $2, $3, $4, now(), now(), $5)
       ON CONFLICT (user_id) DO UPDATE SET
         email = $1, access_token = $2, refresh_token = $3, token_expiry = $4,
         connected_at = now(), updated_at = now()`,
      [email, tokens.access_token, tokens.refresh_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null, userId]
    );

    // Backfill: mirror everything currently active/pending out to the
    // newly-connected calendar, so it has immediate parity with the app
    // instead of only showing things created/edited from now on. Scoped
    // to this one user's own items only - without the user_id filter
    // here, every other user's deadlines/reminders would get pushed onto
    // this one person's calendar.
    const [{ rows: deadlines }, { rows: reminders }] = await Promise.all([
      pool.query(`SELECT * FROM deadlines WHERE user_id = $1 AND status = 'active'`, [userId]),
      pool.query(`SELECT * FROM reminders WHERE user_id = $1 AND status = 'pending'`, [userId]),
    ]);
    for (const d of deadlines) await pushItemToGoogle(userId, "deadline", d);
    for (const r of reminders) await pushItemToGoogle(userId, "reminder", r);

    // Baseline the incremental-sync cursor *after* the backfill above,
    // so the events FocusDial just created aren't immediately re-read
    // back as "remote changes" by the first poll.
    try {
      const calendar = getCalendarClient(authClient);
      const syncToken = await fetchSyncTokenBaseline(calendar, "primary");
      await pool.query(`UPDATE google_account SET sync_token = $1, updated_at = now() WHERE user_id = $2`, [
        syncToken,
        userId,
      ]);
    } catch (err) {
      console.error("failed to establish google sync token baseline:", err.message);
    }

    redirectTo("connected");
  } catch (err) {
    console.error("google oauth callback failed:", err.message);
    redirectTo("error");
  }
});

googleAuthRouter.post("/auth/google/disconnect", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT access_token, refresh_token FROM google_account WHERE user_id = $1`, [
      req.userId,
    ]);
    const account = rows[0];
    if (account) {
      // Best-effort revoke - if this fails (network blip, token already
      // invalid), the local disconnect still proceeds, since the goal is
      // "FocusDial stops touching this calendar," which the DB cleanup
      // below achieves regardless.
      const token = account.refresh_token || account.access_token;
      if (token) {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
          method: "POST",
        }).catch((err) => console.error("google token revoke failed:", err.message));
      }
    }
    await pool.query(`DELETE FROM google_account WHERE user_id = $1`, [req.userId]);
    // google_event_links has no user_id column of its own (every lookup
    // normally goes through item ownership instead) - scoped here via a
    // subquery over this user's own deadlines/reminders so disconnecting
    // only clears this one person's links, not everyone's.
    await pool.query(
      `DELETE FROM google_event_links
       WHERE (item_type = 'deadline' AND item_id IN (SELECT id FROM deadlines WHERE user_id = $1))
          OR (item_type = 'reminder' AND item_id IN (SELECT id FROM reminders WHERE user_id = $1))`,
      [req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to disconnect google account" });
  }
});
