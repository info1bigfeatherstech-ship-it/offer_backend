/**
 * Sentry instrumentation bootstrap.
 *
 * MUST be required immediately after dotenv (and before any other module that
 * Sentry should instrument: express, mongoose, redis, http, etc.). That's why
 * this lives in its own file and is wired from `index.js`, not `server.js`.
 *
 * Behaviour:
 *   - If SENTRY_DSN is not set, this module is a complete no-op. Production
 *     instances without DSN configured will boot exactly as before.
 *   - If SENTRY_DSN is set, Sentry is initialised with safe production defaults
 *     and PII collection disabled by default.
 *
 * Env vars consumed:
 *   SENTRY_DSN                    full Sentry DSN URL  (required to enable)
 *   SENTRY_ENVIRONMENT            override environment label (defaults to NODE_ENV)
 *   SENTRY_RELEASE                release tag (e.g. git SHA); optional
 *   SENTRY_TRACES_SAMPLE_RATE     0.0 - 1.0 (default 0.1 in prod, 0 in dev)
 *   SENTRY_SEND_PII               'true' to forward IP/headers/user (default: false)
 */

const Sentry = require('@sentry/node');

function parseSampleRate(value, fallback) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

const dsn = String(process.env.SENTRY_DSN || '').trim();

if (dsn) {
  const env = String(process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development').trim();
  const release = String(process.env.SENTRY_RELEASE || '').trim() || undefined;
  const defaultTracesRate = env === 'production' ? 0.1 : 0;
  const tracesSampleRate = parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, defaultTracesRate);
  const sendDefaultPii = String(process.env.SENTRY_SEND_PII || '').toLowerCase() === 'true';

  Sentry.init({
    dsn,
    environment: env,
    release,
    tracesSampleRate,
    sendDefaultPii,
    // Limit breadcrumb noise; an e-commerce API can emit a lot of HTTP logs.
    maxBreadcrumbs: 50,
    // Strip the dotenv-loaded secret values from any error payload, just in case.
    beforeSend(event) {
      if (event?.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      return event;
    }
  });

  // eslint-disable-next-line no-console
  console.log(`[Sentry] Initialized (environment=${env}, tracesSampleRate=${tracesSampleRate})`);
} else {
  // eslint-disable-next-line no-console
  console.log('[Sentry] SENTRY_DSN not set - Sentry disabled (no-op).');
}

module.exports = Sentry;
