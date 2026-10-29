import crypto from "node:crypto";
import { log } from "./log.js";

// Transactional email (password reset) goes through Wynmail's API:
//   POST {WYNMAIL_URL}/v1/emails   Authorization: Bearer wm_...
// The From address, sending domain (SPF/DKIM/DMARC), suppression list
// (bounces/complaints) and daily cap all live in the Wynmail workspace
// the key belongs to - nothing about them is configured here.
//
// Without WYNMAIL_URL + WYNMAIL_API_KEY: in development the message is
// logged so the flow can be tested locally; in production nothing is
// logged (it contains a live reset link) and the send is reported failed.
const BASE = (process.env.WYNMAIL_URL || "").replace(/\/+$/, "");
const KEY = process.env.WYNMAIL_API_KEY || "";

export const mailConfigured = Boolean(BASE && KEY);

if (KEY && !/^wm_[\w-]{20,60}$/.test(KEY)) {
  log.warn("WYNMAIL_API_KEY doesn't look like a Wynmail key (expected wm_...) - sends will be rejected");
}

// Wynmail on Render's free tier can take 30-50s to wake up.
const TIMEOUT_MS = 60_000;
let RETRY_DELAYS_MS = [2_000, 10_000];
export function _setRetryDelaysForTests(delays) {
  RETRY_DELAYS_MS = delays;
}

let testTransport = null;
// Tests capture outgoing mail instead of sending it.
export function _setTestMailTransport(fn) {
  testTransport = fn;
}

async function postOnce(body, idempotencyKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/v1/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        // Same key on every retry: if an attempt reached Wynmail but the
        // response was lost, the retry replays it instead of sending a
        // second email.
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// Returns { sent, id?, reason? }. Never throws.
export async function sendMail({ to, subject, text, html, idempotencyKey }) {
  if (testTransport) return testTransport({ to, subject, text, html, idempotencyKey });
  if (!mailConfigured) {
    if (process.env.NODE_ENV !== "production") {
      log.info("mail (dev, not sent)", { to, subject, body: text });
      return { sent: false, dev: true };
    }
    log.error("mail not configured (WYNMAIL_URL / WYNMAIL_API_KEY) - cannot send", { subject });
    return { sent: false, reason: "not_configured" };
  }

  const key = idempotencyKey || `fd-${crypto.randomUUID()}`;
  const body = { to, subject, text, ...(html ? { html } : {}) };

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let outcome;
    try {
      outcome = await postOnce(body, key);
    } catch (err) {
      outcome = { status: 0, data: { error: err.name === "AbortError" ? "timed out" : err.message } };
    }
    const { status, data } = outcome;
    if (status >= 200 && status < 300) {
      log.info("mail sent", { subject, wynmailId: data.id ?? null, replayed: false });
      return { sent: true, id: data.id };
    }
    // 409: an earlier attempt with this key is still in flight on
    // Wynmail's side - worth waiting and asking again.
    const retryable = status === 0 || status === 409 || status >= 500;
    if (!retryable || attempt === RETRY_DELAYS_MS.length) {
      // 422 = suppressed (address bounced / reported spam), 429 = daily
      // cap or rate limit, 400 = sender not approved in Wynmail, 401 =
      // bad key. The recipient address isn't logged.
      log.error("mail send failed", { subject, status, error: String(data?.error || "").slice(0, 300), attempts: attempt + 1 });
      return { sent: false, reason: `status_${status}` };
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
  return { sent: false, reason: "unreachable" };
}
