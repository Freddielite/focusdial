import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { asyncRouter } from "../src/lib/asyncRouter.js";

// The guarantee every router relies on: an exception inside a handler,
// sync or async, becomes an error response for that request - it never
// becomes an unhandled rejection that takes the whole process down.
test("thrown and rejected errors in handlers reach the error handler", async () => {
  const router = asyncRouter();
  router.get("/sync", () => {
    throw new TypeError("boom");
  });
  router.get("/async", async (req) => req.body.name.trim()); // the original crash shape
  const app = express();
  app.use(router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ["/sync", "/async"]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 500);
    }
    assert.equal((await fetch(base + "/sync")).status, 500, "still serving after errors");
  } finally {
    server.close();
  }
});
