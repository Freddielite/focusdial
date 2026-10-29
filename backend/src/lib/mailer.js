import { log } from "./log.js";

// Transactional email (password reset). Uses Resend's HTTP API via fetch
// when RESEND_API_KEY + MAIL_FROM are set - no SDK dependency. Without
// them, in development the message is logged so the flow can be tested
// locally; in production it is not logged (it contains a live reset
// link) and the send is reported as failed.
//
// Deliverability (SPF/DKIM/DMARC) is configured on the sending domain in
// the provider's dashboard, not here - see OPERATIONS.md.
export const mailConfigured = Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);

let testTransport = null;
// Tests capture outgoing mail instead of sending it.
export function _setTestMailTransport(fn) {
  testTransport = fn;
}

export async function sendMail({ to, subject, text }) {
  if (testTransport) return testTransport({ to, subject, text });
  if (!mailConfigured) {
    if (process.env.NODE_ENV !== "production") {
      log.info("mail (dev, not sent)", { to, subject, body: text });
      return { sent: false, dev: true };
    }
    log.error("mail not configured - cannot send", { subject });
    return { sent: false };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text }),
  });
  if (!res.ok) {
    log.error("mail send failed", { status: res.status, subject });
    return { sent: false };
  }
  return { sent: true };
}
