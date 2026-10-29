import { Router } from "express";

// Express 4 ignores the promise an async handler returns. Anything thrown
// inside one (e.g. calling .trim() on a number someone sent as a "name")
// became an unhandled rejection, which on Node 15+ terminates the whole
// process - one malformed request from any signed-up user took the API
// down for everyone. Every router in this app is built with asyncRouter()
// so a thrown error (sync or async) is forwarded to the error handler in
// app.js and becomes a 500 for that one request instead.
function wrap(fn) {
  if (typeof fn !== "function" || fn.length === 4) return fn; // error middleware: leave alone
  return function wrapped(req, res, next) {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.catch === "function") result.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

export function asyncRouter() {
  const router = Router();
  for (const method of ["get", "post", "put", "patch", "delete", "use"]) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map((a) => (Array.isArray(a) ? a.map(wrap) : wrap(a))));
  }
  return router;
}

export { wrap as asyncHandler };
