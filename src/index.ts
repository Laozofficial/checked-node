import { createHash, randomBytes } from 'node:crypto'
import { hostname, release as osRelease } from 'node:os'
import { Transport } from './transport'
import {
  LIMITS,
  cleanText,
  flatPrimitives,
  normalizeExtra,
  normalizeTags,
  safeString,
  stripQuery,
  topFrame,
  truncate,
  type Primitive,
} from './utils'

export const SDK_NAME = 'checked.node'
// Kept in sync with package.json "version"; the build script fails if they differ.
export const SDK_VERSION = '1.0.0'
export const DEFAULT_ENDPOINT = 'https://getchecked.twelveai.app/api/v1/ingest/events'
const INGEST_PATH = '/api/v1/ingest/events'
const DEDUPE_MS = 1000

export type Mechanism = 'manual' | 'uncaughtException' | 'unhandledrejection' | 'middleware'
export type MessageLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug'

export interface NodeUser {
  id?: string | number
  email?: string
}

export interface NodeBreadcrumb {
  ts: number
  type: 'custom' | 'request' | 'navigation' | 'console' | 'click'
  message: string
  data?: Record<string, Primitive>
}

export interface NodeEvent {
  id: string
  type: 'error' | 'custom'
  ts: number
  environment: string
  release: string | null
  url: string
  user: { anonymousId: string; id?: string; emailHash?: string; email?: string }
  sessionId: string
  context: {
    os: { name: string; version: string }
    runtime: { name: string; version: string }
    hostname?: string
  }
  breadcrumbs: NodeBreadcrumb[]
  tags: Record<string, string>
  extra?: Record<string, unknown>
  error?: { type: string; message: string; stack: string; handled: boolean; mechanism: Mechanism }
  custom?: { name: string; props: Record<string, Primitive> }
}

export interface NodeOptions {
  /** Project key. Required. */
  key: string
  environment?: string
  release?: string | null
  /** Full ingest URL, or a bare origin (the ingest path is appended). */
  endpoint?: string
  /** 0..1, applied per error event. Custom events are never sampled. */
  sampleRate?: number
  /** Return the event, a modified copy, or null to drop it. A throwing hook drops the event. */
  beforeSend?: (event: NodeEvent) => NodeEvent | null
  /** Listen to process 'uncaughtException'. Default true. */
  captureUncaught?: boolean
  /** Listen to process 'unhandledRejection'. Default true. */
  captureUnhandledRejections?: boolean
  /**
   * After capturing a fatal error, flush (up to 2s) and exit with code 1 when
   * no other listener is registered, which is what Node does by default.
   * Default true. Set false to keep the process alive.
   */
  exitOnFatal?: boolean
  captureQueryStrings?: boolean
  /** Send the raw email in addition to its SHA-256 hash. Default false. */
  sendEmail?: boolean
  /** Include os.hostname() in the context. Default true. */
  sendHostname?: boolean
  maxBreadcrumbs?: number
  flushIntervalMs?: number
  debug?: boolean
}

export interface CaptureContext {
  tags?: Record<string, unknown>
  extra?: Record<string, unknown>
  user?: NodeUser
  /** The request URL, used as the event url (query string stripped by default). */
  url?: string
  handled?: boolean
  mechanism?: Mechanism
}

function id(bytes = 16): string {
  return randomBytes(bytes).toString('hex')
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function resolveEndpoint(endpoint?: string): string {
  if (!endpoint) return DEFAULT_ENDPOINT
  try {
    const u = new URL(endpoint)
    const path = u.pathname === '/' || u.pathname === '' ? INGEST_PATH : u.pathname.replace(/\/+$/, '')
    return u.origin + path
  } catch {
    return stripQuery(endpoint)
  }
}

function osName(): string {
  switch (process.platform) {
    case 'win32':
      return 'Windows'
    case 'darwin':
      return 'macOS'
    case 'linux':
      return 'Linux'
    default:
      return process.platform
  }
}

class NodeClient {
  readonly endpoint: string
  readonly ingestUrl: string
  private transport: Transport<NodeEvent>
  private tags: Record<string, string> = {}
  private breadcrumbs: NodeBreadcrumb[] = []
  private user: NodeEvent['user']
  private sessionId = 's_' + id(10)
  private dedupe = new Map<string, number>()
  private listeners: Array<[string, (...a: any[]) => void]> = []
  private closed = false

  constructor(readonly opts: NodeOptions) {
    this.endpoint = resolveEndpoint(opts.endpoint)
    this.ingestUrl = this.endpoint + '?key=' + encodeURIComponent(opts.key)
    this.user = { anonymousId: 'a_' + id(10) }
    this.transport = new Transport<NodeEvent>({
      url: this.ingestUrl,
      key: opts.key,
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      flushIntervalMs: Math.max(100, opts.flushIntervalMs ?? 5000),
      log: (...a) => this.log(...a),
    })
  }

  log(...a: unknown[]): void {
    if (this.opts.debug) {
      try {
        console.warn('[checked]', ...a)
      } catch {
        /* ignore */
      }
    }
  }

  start(): void {
    if (this.opts.captureUncaught !== false) {
      const onUncaught = (err: unknown) => this.onFatal('uncaughtException', err)
      process.on('uncaughtException', onUncaught)
      this.listeners.push(['uncaughtException', onUncaught])
    }
    if (this.opts.captureUnhandledRejections !== false) {
      const onRejection = (reason: unknown) => this.onFatal('unhandledRejection', reason)
      process.on('unhandledRejection', onRejection)
      this.listeners.push(['unhandledRejection', onRejection])
    }
  }

  private onFatal(kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void {
    try {
      this.captureError(err, {
        handled: false,
        mechanism: kind === 'uncaughtException' ? 'uncaughtException' : 'unhandledrejection',
      })
    } catch {
      /* ignore */
    }
    const others = process.listenerCount(kind) - 1
    if (this.opts.exitOnFatal === false || others > 0) return
    const timeout = new Promise<boolean>((r) => {
      const t = setTimeout(() => r(false), 2000)
      ;(t as unknown as { unref?: () => void }).unref?.()
    })
    void Promise.race([this.transport.flush(true), timeout]).finally(() => {
      try {
        console.error(err instanceof Error ? err.stack || err : err)
      } catch {
        /* ignore */
      }
      process.exit(1)
    })
  }

  private userFor(u?: NodeUser): NodeEvent['user'] {
    if (!u) return { ...this.user }
    const out: NodeEvent['user'] = { anonymousId: this.user.anonymousId }
    if (u.id !== undefined && u.id !== null && u.id !== '') out.id = truncate(String(u.id), 128)
    const email = typeof u.email === 'string' ? u.email.trim().toLowerCase() : ''
    if (email) {
      out.emailHash = sha256(email)
      if (this.opts.sendEmail) out.email = truncate(email, 254)
    }
    return out
  }

  identify(u: NodeUser | null): void {
    this.user = u ? this.userFor(u) : { anonymousId: this.user.anonymousId }
  }

  setTag(k: string, v: unknown): void {
    if (!k) return
    if (v === undefined || v === null) delete this.tags[k]
    else Object.assign(this.tags, normalizeTags({ [k]: v }))
  }

  addBreadcrumb(b: { message: string; type?: NodeBreadcrumb['type']; data?: Record<string, unknown> }): void {
    const max = Math.max(0, Math.min(100, this.opts.maxBreadcrumbs ?? 30))
    if (!max || !b) return
    const keep = !!this.opts.captureQueryStrings
    const crumb: NodeBreadcrumb = {
      ts: Date.now(),
      type: b.type || 'custom',
      message: cleanText(String(b.message ?? ''), LIMITS.breadcrumb, keep),
    }
    if (b.data) crumb.data = flatPrimitives(b.data, 10, LIMITS.breadcrumb)
    this.breadcrumbs.push(crumb)
    if (this.breadcrumbs.length > max) this.breadcrumbs.splice(0, this.breadcrumbs.length - max)
  }

  private base(type: NodeEvent['type'], ctx?: CaptureContext): NodeEvent {
    const keep = !!this.opts.captureQueryStrings
    const ev: NodeEvent = {
      id: id(16),
      type,
      ts: Date.now(),
      environment: truncate(this.opts.environment || 'production', 64),
      release: this.opts.release ? truncate(String(this.opts.release), 64) : null,
      url: ctx && ctx.url ? truncate(keep ? ctx.url : stripQuery(ctx.url), 2000) : '',
      user: this.userFor(ctx && ctx.user),
      sessionId: this.sessionId,
      context: {
        os: { name: osName(), version: safeOsRelease() },
        runtime: { name: 'node', version: process.versions.node },
      },
      breadcrumbs: type === 'error' ? this.breadcrumbs.slice() : [],
      tags: { ...this.tags, ...(ctx && ctx.tags ? normalizeTags(ctx.tags) : {}) },
    }
    if (this.opts.sendHostname !== false) {
      try {
        ev.context.hostname = hostname()
      } catch {
        /* ignore */
      }
    }
    const extra = ctx && ctx.extra ? normalizeExtra(ctx.extra) : undefined
    if (extra) ev.extra = extra
    return ev
  }

  private dispatch(ev: NodeEvent): boolean {
    if (this.closed) return false
    let out: NodeEvent | null = ev
    if (this.opts.beforeSend) {
      try {
        out = this.opts.beforeSend(ev)
      } catch (e) {
        this.log('beforeSend threw, dropping event', e)
        out = null
      }
      if (!out) return false
    }
    this.transport.enqueue(out)
    return true
  }

  captureError(err: unknown, ctx: CaptureContext = {}): boolean {
    if (this.closed) return false
    const rate = typeof this.opts.sampleRate === 'number' ? Math.min(1, Math.max(0, this.opts.sampleRate)) : 1
    if (rate < 1 && !(Math.random() < rate)) return false
    const keep = !!this.opts.captureQueryStrings
    let type = 'Error'
    let message = ''
    let stack = ''
    if (err instanceof Error || (err && typeof err === 'object' && 'message' in (err as object))) {
      const e = err as Error
      type = typeof e.name === 'string' && e.name ? e.name : 'Error'
      message = safeString(e.message)
      stack = typeof e.stack === 'string' ? e.stack : ''
    } else {
      type = ctx.mechanism === 'unhandledrejection' ? 'UnhandledRejection' : 'Error'
      message = (ctx.mechanism === 'unhandledrejection' ? 'Non-Error promise rejection: ' : '') + safeString(err)
    }
    type = truncate(type, 128)
    message = cleanText(message, LIMITS.message, keep)
    stack = cleanText(stack, LIMITS.stack, keep)
    const now = Date.now()
    const dkey = type + '|' + message + '|' + topFrame(stack)
    const last = this.dedupe.get(dkey)
    if (last !== undefined && now - last < DEDUPE_MS) return false
    this.dedupe.set(dkey, now)
    if (this.dedupe.size > 500) {
      for (const [k, v] of this.dedupe) if (now - v >= DEDUPE_MS) this.dedupe.delete(k)
    }
    const ev = this.base('error', ctx)
    ev.error = {
      type,
      message,
      stack,
      handled: ctx.handled ?? true,
      mechanism: ctx.mechanism ?? 'manual',
    }
    return this.dispatch(ev)
  }

  captureMessage(message: string, level: MessageLevel = 'info', ctx: CaptureContext = {}): boolean {
    const err = { name: 'Message', message: String(message), stack: '' }
    return this.captureError(err, { ...ctx, tags: { level, ...(ctx.tags || {}) } })
  }

  track(name: string, props?: Record<string, unknown>, ctx?: Pick<CaptureContext, 'user' | 'url' | 'tags'>): boolean {
    if (this.closed || !name) return false
    const ev = this.base('custom', ctx)
    ev.custom = { name: truncate(String(name), LIMITS.name), props: flatPrimitives(props, LIMITS.propKeys, LIMITS.message) }
    return this.dispatch(ev)
  }

  flush(timeoutMs?: number): Promise<boolean> {
    const p = this.transport.flush(true).catch(() => false)
    if (!timeoutMs) return p
    return Promise.race([
      p,
      new Promise<boolean>((r) => {
        const t = setTimeout(() => r(false), timeoutMs)
        ;(t as unknown as { unref?: () => void }).unref?.()
      }),
    ])
  }

  close(timeoutMs?: number): Promise<boolean> {
    const p = this.flush(timeoutMs)
    this.closed = true
    this.transport.close()
    for (const [ev, fn] of this.listeners.splice(0)) process.removeListener(ev, fn)
    return p
  }
}

function safeOsRelease(): string {
  try {
    return osRelease()
  } catch {
    return ''
  }
}

let client: NodeClient | null = null

function guard<T>(fallback: T, fn: (c: NodeClient) => T): T {
  if (!client) return fallback
  try {
    return fn(client)
  } catch {
    return fallback
  }
}

/** Calls before init are safe no-ops. Calling init again replaces the previous client. */
export function init(options: NodeOptions): void {
  try {
    if (!options || !options.key) return
    if (client) void client.close()
    const c = new NodeClient(options)
    c.start()
    client = c
  } catch {
    /* never throw into the host */
  }
}

export function captureError(error: unknown, context?: CaptureContext): void {
  guard(undefined, (c) => {
    c.captureError(error, context)
  })
}

export function captureMessage(message: string, level?: MessageLevel, context?: CaptureContext): void {
  guard(undefined, (c) => {
    c.captureMessage(message, level, context)
  })
}

export function track(name: string, props?: Record<string, unknown>, context?: Pick<CaptureContext, 'user' | 'url' | 'tags'>): void {
  guard(undefined, (c) => {
    c.track(name, props, context)
  })
}

/** Sets a process-wide default user. For per-request users pass `user` in the capture context instead. */
export function identify(user: NodeUser | null): void {
  guard(undefined, (c) => c.identify(user))
}

export function setTag(key: string, value: unknown): void {
  guard(undefined, (c) => c.setTag(key, value))
}

export function addBreadcrumb(b: { message: string; type?: NodeBreadcrumb['type']; data?: Record<string, unknown> }): void {
  guard(undefined, (c) => c.addBreadcrumb(b))
}

export function flush(timeoutMs?: number): Promise<boolean> {
  return guard(Promise.resolve(true), (c) => c.flush(timeoutMs))
}

export function close(timeoutMs?: number): Promise<boolean> {
  const c = client
  client = null
  return c ? c.close(timeoutMs).catch(() => false) : Promise.resolve(true)
}

// ------------------------------------------------------------------ helpers

export interface HelperOptions {
  /** Also capture errors whose status is 4xx. Default false (only 5xx and errors without a status). */
  capture4xx?: boolean
}

function statusOf(err: unknown): number | undefined {
  try {
    const e = err as { status?: unknown; statusCode?: unknown }
    const s = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined
    return s
  } catch {
    return undefined
  }
}

function shouldCapture(err: unknown, opts?: HelperOptions): boolean {
  const s = statusOf(err)
  if (s === undefined || s >= 500) return true
  return !!(opts && opts.capture4xx && s >= 400)
}

interface ExpressLikeRequest {
  method?: string
  originalUrl?: string
  url?: string
  protocol?: string
  get?: (name: string) => string | undefined
  headers?: Record<string, unknown>
}

function expressUrl(req: ExpressLikeRequest): string {
  const path = req.originalUrl || req.url || ''
  try {
    const host = (req.get && req.get('host')) || (req.headers && (req.headers.host as string))
    if (host) return `${req.protocol || 'http'}://${host}${path}`
  } catch {
    /* ignore */
  }
  return path
}

/**
 * Express 4/5 error middleware. Register it after your routes and before your
 * own error handler: `app.use(expressErrorHandler())`. It captures the error
 * and always calls `next(err)`, so your error handling is unchanged.
 */
export function expressErrorHandler(opts?: HelperOptions) {
  // Express detects error middleware by its four parameters; keep them.
  return function checkedErrorHandler(err: unknown, req: ExpressLikeRequest, _res: unknown, next: (err?: unknown) => void) {
    try {
      if (shouldCapture(err, opts)) {
        captureError(err, {
          handled: false,
          mechanism: 'middleware',
          url: expressUrl(req || {}),
          tags: req && req.method ? { 'http.method': req.method } : undefined,
        })
      }
    } catch {
      /* never break the chain */
    }
    next(err)
  }
}

interface FastifyLikeRequest {
  method?: string
  url?: string
  protocol?: string
  hostname?: string
  host?: string
}

/** The raw Fastify onError hook. Prefer `fastifyErrorHook(app)`. */
export function fastifyOnError(opts?: HelperOptions) {
  return function checkedOnError(request: FastifyLikeRequest, _reply: unknown, error: unknown, done: () => void) {
    try {
      if (shouldCapture(error, opts)) {
        const host = request && (request.host || request.hostname)
        const url = request && request.url ? (host ? `${request.protocol || 'http'}://${host}${request.url}` : request.url) : ''
        captureError(error, {
          handled: false,
          mechanism: 'middleware',
          url,
          tags: request && request.method ? { 'http.method': request.method } : undefined,
        })
      }
    } catch {
      /* ignore */
    }
    done()
  }
}

/** Registers the onError hook on a Fastify instance. Returns the instance. */
export function fastifyErrorHook<T extends { addHook: (name: 'onError', fn: any) => unknown }>(instance: T, opts?: HelperOptions): T {
  instance.addHook('onError', fastifyOnError(opts))
  return instance
}

interface AdonisLikeContext {
  request?: {
    method?: () => string
    url?: (includeQuery?: boolean) => string
    completeUrl?: (includeQuery?: boolean) => string
  }
  auth?: { user?: { id?: string | number } | null }
}

/**
 * For an AdonisJS exception handler:
 *
 *   async report(error: unknown, ctx: HttpContext) {
 *     adonisReport(error, ctx)
 *     return super.report(error, ctx)
 *   }
 */
export function adonisReport(error: unknown, ctx?: AdonisLikeContext, opts?: HelperOptions): void {
  try {
    if (!shouldCapture(error, opts)) return
    let url = ''
    let method: string | undefined
    let userId: string | number | undefined
    try {
      const r = ctx && ctx.request
      if (r) {
        url = typeof r.completeUrl === 'function' ? r.completeUrl() : typeof r.url === 'function' ? r.url() : ''
        method = typeof r.method === 'function' ? r.method() : undefined
      }
      const u = ctx && ctx.auth && ctx.auth.user
      if (u && u.id !== undefined) userId = u.id
    } catch {
      /* ignore */
    }
    captureError(error, {
      handled: false,
      mechanism: 'middleware',
      url,
      tags: method ? { 'http.method': method } : undefined,
      user: userId !== undefined ? { id: userId } : undefined,
    })
  } catch {
    /* ignore */
  }
}

export const Checked = {
  init,
  captureError,
  captureMessage,
  track,
  identify,
  setTag,
  addBreadcrumb,
  flush,
  close,
  expressErrorHandler,
  fastifyErrorHook,
  fastifyOnError,
  adonisReport,
  version: SDK_VERSION,
}

export default Checked
