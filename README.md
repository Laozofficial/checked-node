# checkd-node

Check’d production monitoring for Node.js 18+ (uses the global `fetch`). Zero runtime dependencies. Same wire protocol as `checkd-browser`, see `../README.md`.

```ts
import { Checked, expressErrorHandler, fastifyErrorHook, adonisReport } from 'checkd-node'

Checked.init({ key: 'ck_pub_...', environment: 'production', release: process.env.GIT_SHA })

Checked.captureError(err, { tags: { job: 'sync' }, extra: { id: 3 }, user: { id: 42 } })
Checked.captureMessage('cache cold', 'warning')
Checked.track('invoice_paid', { amount: 100 })
await Checked.flush(2000)   // resolves false on timeout
```

## Options

`key` (required), `environment` (`"production"`), `release`, `endpoint` (full URL or bare origin), `sampleRate` (errors only), `beforeSend`, `captureUncaught` (true), `captureUnhandledRejections` (true), `exitOnFatal` (true), `captureQueryStrings` (false), `sendEmail` (false), `sendHostname` (true), `maxBreadcrumbs` (30), `flushIntervalMs` (5000), `debug`.

`exitOnFatal`: registering a listener stops Node from crashing on an uncaught exception or unhandled rejection. To keep Node's default behaviour, after capturing a fatal error the SDK flushes (up to 2s), prints the error and exits with code 1, but only when no other listener for that event is registered. Set `exitOnFatal: false` to keep the process alive.

`identify({ id, email })` sets a process wide default user. In a server, pass `user` per capture instead. Emails are trimmed, lowercased and SHA-256 hashed.

## Framework helpers

Each helper skips errors with a 4xx `status`/`statusCode` unless `{ capture4xx: true }` is passed, records the request URL (query stripped) and `tags["http.method"]`, and never changes your error handling.

```ts
// Express 4 and 5: after your routes, before your own error handler. Always calls next(err).
app.use(expressErrorHandler())

// Fastify
fastifyErrorHook(app)            // or app.addHook('onError', fastifyOnError())

// AdonisJS: app/exceptions/handler.ts
async report(error: unknown, ctx: HttpContext) {
  adonisReport(error, ctx)       // also picks up ctx.auth.user.id when present
  return super.report(error, ctx)
}
```
