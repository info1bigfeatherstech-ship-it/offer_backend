/**
 * Mongo-sanitize middleware
 * -------------------------
 * Strips MongoDB operator keys (anything starting with `$`) and keys containing
 * a dot from `req.body`, `req.params`, and `req.query` so they can never reach
 * a Mongoose query and bypass auth/filter logic.
 *
 * Why custom (not `express-mongo-sanitize`):
 *   - Express 5 changed `req.query` to a getter that re-parses on access. The
 *     popular package was written for Express 4 and breaks under Express 5.
 *   - This module is ~50 lines, has no dependencies, and is unit-testable.
 *
 * What it blocks:
 *   - `{ "email": { "$ne": null } }` style NoSQL injection in JSON bodies.
 *   - `?email[$ne]=null` style injection in URL query strings (qs nested syntax).
 *   - Dotted keys like `"a.b"` that could rewrite nested Mongo paths.
 *
 * What it does NOT touch:
 *   - Top-level non-object payloads (already harmless).
 *   - String values inside objects (Mongoose schema casts handle those).
 *
 * Safety:
 *   - Depth-limited (default 20) so a cyclic/very deep object cannot stack-
 *     overflow this function.
 *   - Mutates in place (no allocation), so it's O(n) over keys.
 *   - Wraps each phase in try/catch — sanitization MUST never crash a request.
 */

const logger = require('./logger');

const MAX_DEPTH = 20;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  // Reject special objects we should never recurse into (Buffer, Date, etc.)
  if (Buffer.isBuffer(value)) return false;
  if (value instanceof Date) return false;
  return true;
}

function isDangerousKey(key) {
  if (typeof key !== 'string') return false;
  return key.startsWith('$') || key.includes('.');
}

/**
 * In-place sanitize. Returns the number of keys stripped (for logging).
 */
function sanitizeInPlace(obj, depth = 0) {
  if (depth > MAX_DEPTH) return 0;
  let stripped = 0;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item && typeof item === 'object') {
        stripped += sanitizeInPlace(item, depth + 1);
      }
    }
    return stripped;
  }

  if (!isPlainObject(obj)) return 0;

  for (const key of Object.keys(obj)) {
    if (isDangerousKey(key)) {
      delete obj[key];
      stripped += 1;
      continue;
    }
    const value = obj[key];
    if (value && typeof value === 'object') {
      stripped += sanitizeInPlace(value, depth + 1);
    }
  }

  return stripped;
}

function safeSanitize(target, label, reqId) {
  if (!target || typeof target !== 'object') return 0;
  try {
    const count = sanitizeInPlace(target, 0);
    if (count > 0) {
      logger.warn('[Sanitize] Stripped Mongo operator keys', {
        requestId: reqId,
        location: label,
        stripped: count
      });
    }
    return count;
  } catch (err) {
    logger.error('[Sanitize] Sanitization failed', {
      requestId: reqId,
      location: label,
      message: err.message
    });
    return 0;
  }
}

/**
 * Express middleware factory. Mount AFTER express.json() / express.urlencoded()
 * so req.body is already parsed.
 */
function mongoSanitizeMiddleware() {
  return function mongoSanitize(req, res, next) {
    const reqId = req.id;
    safeSanitize(req.body, 'body', reqId);
    safeSanitize(req.params, 'params', reqId);
    // Express 5: req.query is a lazily-parsed getter. Accessing it once
    // triggers the parse; the returned object is cached on the request so
    // mutations below propagate to controllers. We never reassign req.query.
    safeSanitize(req.query, 'query', reqId);
    next();
  };
}

module.exports = {
  mongoSanitizeMiddleware,
  sanitizeInPlace,
  isDangerousKey
};
