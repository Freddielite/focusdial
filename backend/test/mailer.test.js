import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// A fake Wynmail that records requests and answers from a script.
const calls = [];
let script = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls.push({ path: req.url, headers: req.headers, body: JSON.parse(body || "{}") });
    const [status, json] = script.shift() || [200, { id: 1, status: "sent" }];
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(json));
  });
});

let mailer;
before(async () => {
  await new Promise((r) => fake.listen(0, r));
  process.env.WYNMAIL_URL = `http://127.0.0.1:${fake.address().port}/`;
  process.env.WYNMAIL_API_KEY = "wm_" + "x".repeat(32);
  mailer = await import("../src/lib/mailer.js");
  mailer._setRetryDelaysForTests([10, 10]);
});
after(() => fake.close());

test("sends to Wynmail's /v1/emails with the API key and an idempotency key", async () => {
  calls.length = 0;
  script = [[200, { id: 42, status: "sent" }]];
  const r = await mailer.sendMail({ to: "ann+focus@example.com", subject: "Hi", text: "body", html: "<p>body</p>", idempotencyKey: "fd-reset-abc12345" });
  assert.deepEqual(r, { sent: true, id: 42 });
  assert.equal(calls[0].path, "/v1/emails");
  assert.equal(calls[0].headers.authorization, `Bearer ${process.env.WYNMAIL_API_KEY}`);
  assert.equal(calls[0].headers["idempotency-key"], "fd-reset-abc12345");
  assert.deepEqual(calls[0].body, { to: "ann+focus@example.com", subject: "Hi", text: "body", html: "<p>body</p>" });
});

test("retries 5xx and 'still processing' with the same idempotency key", async () => {
  calls.length = 0;
  script = [[502, { error: "Delivery failed" }], [409, { error: "still processing" }], [200, { id: 7 }]];
  const r = await mailer.sendMail({ to: "a@example.com", subject: "S", text: "t", idempotencyKey: "fd-reset-retry0001" });
  assert.equal(r.sent, true);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.headers["idempotency-key"] === "fd-reset-retry0001"));
});

test("does not retry a suppressed address, the daily cap, or a bad key", async () => {
  for (const status of [422, 429, 400, 401]) {
    calls.length = 0;
    script = [[status, { error: "nope" }]];
    const r = await mailer.sendMail({ to: "a@example.com", subject: "S", text: "t" });
    assert.equal(r.sent, false);
    assert.equal(calls.length, 1, `status ${status} must not be retried`);
  }
});

test("gives up after the retry budget and reports failure instead of throwing", async () => {
  calls.length = 0;
  script = [[503, {}], [503, {}], [503, {}]];
  const r = await mailer.sendMail({ to: "a@example.com", subject: "S", text: "t" });
  assert.equal(r.sent, false);
  assert.equal(calls.length, 3);
});
