// Same batching and retry rules as checkd-browser, without beacons or offline detection.

export const MAX_BATCH = 50
export const MAX_BODY_BYTES = 60 * 1024
export const MAX_QUEUE = 200
export const MAX_ATTEMPTS = 5
export const MAX_BACKOFF_MS = 60_000
export const FLUSH_AT = 10

type SendResult = { kind: 'ok' } | { kind: 'drop' } | { kind: 'retry'; retryAfterMs?: number }

export interface TransportConfig {
  url: string
  key: string
  sdk: { name: string; version: string }
  flushIntervalMs: number
  log: (...args: unknown[]) => void
}

function unref(t: ReturnType<typeof setTimeout>): void {
  const u = t as unknown as { unref?: () => void }
  if (u && typeof u.unref === 'function') u.unref()
}

export class Transport<E extends object = object> {
  private queue: E[] = []
  private dropped = 0
  private failures = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private chain: Promise<boolean> = Promise.resolve(true)
  private closed = false

  constructor(private cfg: TransportConfig) {}

  get size(): number {
    return this.queue.length
  }

  countDropped(n = 1): void {
    this.dropped += n
  }

  enqueue(event: E): void {
    if (this.closed) return
    this.queue.push(event)
    while (this.queue.length > MAX_QUEUE) {
      this.queue.shift()
      this.dropped++
    }
    if (this.queue.length >= FLUSH_AT && !this.retryTimer) void this.flush()
    else this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.closed) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, this.cfg.flushIntervalMs)
    unref(this.flushTimer)
  }

  /** Send everything queued. With `force`, a pending backoff is skipped (used on shutdown). */
  flush(force = false): Promise<boolean> {
    if (force && this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.chain = this.chain.then(
      () => this.drain(),
      () => this.drain(),
    )
    return this.chain
  }

  private async drain(): Promise<boolean> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    while (this.queue.length) {
      if (this.retryTimer) return false
      const { batch, body, droppedSent } = this.takeBatch()
      if (!batch.length) continue
      const res = await this.send(body)
      if (res.kind === 'ok') {
        this.failures = 0
        this.dropped = Math.max(0, this.dropped - droppedSent)
        continue
      }
      if (res.kind === 'drop') {
        this.failures = 0
        this.cfg.log('batch rejected, dropping', batch.length, 'events')
        this.dropped = Math.max(0, this.dropped - droppedSent) + batch.length
        continue
      }
      this.failures++
      if (this.failures >= MAX_ATTEMPTS) {
        this.failures = 0
        this.dropped += batch.length
        continue
      }
      this.queue = batch.concat(this.queue)
      while (this.queue.length > MAX_QUEUE) {
        this.queue.shift()
        this.dropped++
      }
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, this.failures - 1))
      const delay = res.retryAfterMs !== undefined ? Math.min(MAX_BACKOFF_MS, Math.max(0, res.retryAfterMs)) : backoff
      if (!this.closed) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          void this.flush()
        }, delay)
        unref(this.retryTimer)
      }
      return false
    }
    return true
  }

  private takeBatch(): { batch: E[]; body: string; droppedSent: number } {
    let count = Math.min(MAX_BATCH, this.queue.length)
    const droppedSent = this.dropped
    while (count > 0) {
      const batch = this.queue.slice(0, count)
      const body = JSON.stringify({
        key: this.cfg.key,
        sdk: this.cfg.sdk,
        sentAt: Date.now(),
        client: { dropped: droppedSent },
        events: batch,
      })
      if (Buffer.byteLength(body, 'utf8') <= MAX_BODY_BYTES) {
        this.queue.splice(0, count)
        return { batch, body, droppedSent }
      }
      if (count === 1) {
        this.queue.shift()
        this.dropped++
        return { batch: [], body: '', droppedSent: 0 }
      }
      count = Math.max(1, Math.floor(count / 2))
    }
    return { batch: [], body: '', droppedSent: 0 }
  }

  private async send(body: string): Promise<SendResult> {
    if (typeof fetch !== 'function') return { kind: 'drop' }
    let res: Response
    try {
      res = await fetch(this.cfg.url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      })
    } catch (e) {
      this.cfg.log('send failed', e)
      return { kind: 'retry' }
    }
    const status = res.status
    if (status >= 200 && status < 300) return { kind: 'ok' }
    if (status === 429) {
      let retryAfterMs: number | undefined
      try {
        const h = res.headers && res.headers.get('Retry-After')
        const secs = h ? Number(h) : NaN
        if (isFinite(secs) && secs >= 0) retryAfterMs = secs * 1000
      } catch {
        /* ignore */
      }
      return { kind: 'retry', retryAfterMs }
    }
    if (status >= 500) return { kind: 'retry' }
    return { kind: 'drop' }
  }

  close(): void {
    this.closed = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.flushTimer = null
    this.retryTimer = null
  }
}
