import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Checked, adonisReport, expressErrorHandler, fastifyErrorHook, type NodeEvent } from '../src/index'

interface Sent {
  url: string
  init: RequestInit
  body: { key: string; sdk: { name: string; version: string }; sentAt: number; client: { dropped: number }; events: NodeEvent[] }
}

let sent: Sent[] = []
let statuses: number[] = [202]

beforeEach(() => {
  sent = []
  statuses = [202]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, init, body: JSON.parse(String(init.body)) })
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0]
      return { status, headers: { get: () => null } }
    }),
  )
})

afterEach(async () => {
  await Checked.close()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const events = () => sent.flatMap((s) => s.body.events)

function init(extra: Record<string, unknown> = {}) {
  Checked.init({ key: 'ck_pub_node', endpoint: 'https://ingest.test', environment: 'test', release: '9.9.9', exitOnFatal: false, ...extra })
}

describe('@checked/node', () => {
  it('captureError sends the wire protocol', async () => {
    init()
    const err = new TypeError('bad thing token=abc123')
    Checked.captureError(err, { tags: { area: 'jobs' }, extra: { jobId: 5 }, user: { id: 42, email: 'Ada@Example.com' } })
    await Checked.flush()
    expect(sent.length).toBe(1)
    const { url, init: req, body } = sent[0]
    expect(url).toBe('https://ingest.test/api/v1/ingest/events?key=ck_pub_node')
    expect(req.method).toBe('POST')
    expect(body.key).toBe('ck_pub_node')
    expect(body.sdk).toEqual({ name: 'checked.node', version: '1.0.0' })
    expect(body.client).toEqual({ dropped: 0 })
    const e = body.events[0]
    expect(e).toMatchObject({
      type: 'error',
      environment: 'test',
      release: '9.9.9',
      tags: { area: 'jobs' },
      extra: { jobId: 5 },
      error: { type: 'TypeError', message: 'bad thing token=[Filtered]', handled: true, mechanism: 'manual' },
    })
    expect(e.user.id).toBe('42')
    expect(e.user.emailHash).toBe(createHash('sha256').update('ada@example.com').digest('hex'))
    expect(e.user.email).toBeUndefined()
    expect(e.context.runtime).toEqual({ name: 'node', version: process.versions.node })
    expect(typeof e.context.hostname).toBe('string')
    expect(e.id).toMatch(/^[0-9a-f]{32}$/)
    expect(e.sessionId).toMatch(/^s_/)
    expect(e.user.anonymousId).toMatch(/^a_/)
  })

  it('track sends a custom event and is not sampled', async () => {
    init({ sampleRate: 0 })
    Checked.captureError(new Error('sampled out'))
    Checked.track('invoice_paid', { amount: 100, currency: 'NGN', nested: { x: 1 } })
    await Checked.flush()
    expect(events().map((e) => e.type)).toEqual(['custom'])
    expect(events()[0].custom).toEqual({ name: 'invoice_paid', props: { amount: 100, currency: 'NGN' } })
  })

  it('expressErrorHandler captures and calls next(err)', async () => {
    init()
    const handler = expressErrorHandler()
    expect(handler.length).toBe(4)
    const err = new Error('db down')
    const next = vi.fn()
    const req = { method: 'GET', originalUrl: '/orders/1?secret=x', protocol: 'https', get: (h: string) => (h === 'host' ? 'api.example.com' : undefined) }
    handler(err, req, {}, next)
    expect(next).toHaveBeenCalledWith(err)
    await Checked.flush()
    const e = events()[0]
    expect(e.url).toBe('https://api.example.com/orders/1')
    expect(e.error).toMatchObject({ message: 'db down', handled: false, mechanism: 'middleware' })
    expect(e.tags['http.method']).toBe('GET')
  })

  it('expressErrorHandler skips 4xx errors by default but still calls next', async () => {
    init()
    const next = vi.fn()
    const err = Object.assign(new Error('not found'), { status: 404 })
    expressErrorHandler()(err, { method: 'GET', url: '/x' }, {}, next)
    expect(next).toHaveBeenCalledWith(err)
    await Checked.flush()
    expect(sent.length).toBe(0)
  })

  it('fastifyErrorHook registers an onError hook that captures', async () => {
    init()
    const hooks: Array<[string, (...a: unknown[]) => void]> = []
    const app = { addHook: (name: string, fn: (...a: unknown[]) => void) => hooks.push([name, fn]) }
    expect(fastifyErrorHook(app)).toBe(app)
    expect(hooks[0][0]).toBe('onError')
    const done = vi.fn()
    hooks[0][1]({ method: 'POST', url: '/pay?card=4242', hostname: 'api.example.com', protocol: 'https' }, {}, new Error('boom'), done)
    expect(done).toHaveBeenCalled()
    await Checked.flush()
    expect(events()[0]).toMatchObject({ url: 'https://api.example.com/pay', error: { message: 'boom', mechanism: 'middleware' } })
  })

  it('adonisReport captures with the request url and the auth user', async () => {
    init()
    const ctx = {
      request: { method: () => 'PUT', completeUrl: () => 'https://api.example.com/v1/items/3' },
      auth: { user: { id: 77 } },
    }
    adonisReport(new Error('adonis fail'), ctx)
    adonisReport(Object.assign(new Error('validation'), { status: 422 }), ctx)
    await Checked.flush()
    expect(events().length).toBe(1)
    expect(events()[0]).toMatchObject({ url: 'https://api.example.com/v1/items/3', user: { id: '77' }, tags: { 'http.method': 'PUT' } })
  })

  it('captures uncaught exceptions and unhandled rejections through process listeners', async () => {
    const before = new Set(process.listeners('uncaughtException'))
    const beforeRej = new Set(process.listeners('unhandledRejection'))
    init()
    const mine = process.listeners('uncaughtException').filter((l) => !before.has(l))
    const mineRej = process.listeners('unhandledRejection').filter((l) => !beforeRej.has(l))
    expect(mine.length).toBe(1)
    expect(mineRej.length).toBe(1)
    ;(mine[0] as (e: unknown) => void)(new Error('crash'))
    ;(mineRej[0] as (r: unknown) => void)('plain string reason')
    await Checked.flush()
    const errs = events()
    expect(errs[0].error).toMatchObject({ message: 'crash', handled: false, mechanism: 'uncaughtException' })
    expect(errs[1].error).toMatchObject({ type: 'UnhandledRejection', mechanism: 'unhandledrejection' })
    await Checked.close()
    expect(process.listeners('uncaughtException').filter((l) => !before.has(l)).length).toBe(0)
  })

  it('retries a 503 with backoff and does not retry a 401', async () => {
    vi.useFakeTimers()
    init()
    statuses = [503, 202]
    Checked.track('a')
    await Checked.flush()
    expect(sent.length).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent.length).toBe(2)
    statuses = [401]
    Checked.track('b')
    await Checked.flush()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(sent.length).toBe(3)
  })

  it('calls before init are no-ops', async () => {
    expect(() => Checked.captureError(new Error('x'))).not.toThrow()
    await expect(Checked.flush()).resolves.toBe(true)
    expect(sent.length).toBe(0)
  })
})
