// Copied from checkd-browser src/utils.ts (keep the privacy rules identical).
export type Primitive = string | number | boolean

export const LIMITS = {
  message: 1000,
  stack: 8000,
  breadcrumb: 300,
  userAgent: 300,
  tagKey: 64,
  tagValue: 200,
  maxTags: 50,
  propKeys: 20,
  name: 100,
  extraBytes: 4000,
}

export function now(): number {
  return Date.now()
}

export function truncate(value: string, max: number): string {
  if (typeof value !== 'string') value = String(value)
  return value.length > max ? value.slice(0, max - 3) + '...' : value
}

/** Remove the query string and hash from a URL string. */
export function stripQuery(url: string): string {
  if (typeof url !== 'string') return ''
  const i = url.search(/[?#]/)
  return i === -1 ? url : url.slice(0, i)
}

/**
 * Strip query strings and hashes from every http(s) URL found inside free
 * text (error messages, stack traces). A trailing `:line:col` that belongs to
 * a stack frame is kept.
 */
const URL_QUERY_RE = /(https?:\/\/[^\s?#()'"<>]+)[?#][^\s()'"<>]*?((?::\d+){1,2})?(?=[\s)'"<>]|$)/g
export function stripQueriesInText(text: string): string {
  return text.replace(URL_QUERY_RE, (_m, base: string, pos?: string) => base + (pos || ''))
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(bearer|basic)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, '$1 [Filtered]'],
  [
    /\b(password|passwd|pwd|pass|token|access_token|refresh_token|id_token|api_key|apikey|api-key|secret|client_secret|auth|authorization|session|sessionid)=([^&\s"'<>]+)/gi,
    '$1=[Filtered]',
  ],
  [/("(?:password|passwd|token|access_token|refresh_token|api_key|apikey|secret|authorization)"\s*:\s*")[^"]*"/gi, '$1[Filtered]"'],
]

export function scrubSecrets(text: string): string {
  let out = text
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep)
  return out
}

/** Full privacy pass for free text: secrets, then URL queries (unless allowed), then length. */
export function cleanText(text: string, max: number, keepQueries: boolean): string {
  let t = typeof text === 'string' ? text : safeString(text)
  t = scrubSecrets(t)
  if (!keepQueries) t = stripQueriesInText(t)
  return truncate(t, max)
}

/** Stringify anything without throwing (cycles, BigInt, getters that throw). */
export function safeString(value: unknown): string {
  try {
    if (typeof value === 'string') return value
    if (value === undefined) return 'undefined'
    if (value === null) return 'null'
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
    if (typeof value === 'symbol' || typeof value === 'function') return String(value)
    if (value instanceof Error) return value.name + ': ' + value.message
    const seen = new WeakSet<object>()
    const json = JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return v.toString()
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
      }
      return v
    })
    return json === undefined ? String(value) : json
  } catch {
    try {
      return Object.prototype.toString.call(value)
    } catch {
      return '[unserializable]'
    }
  }
}

/** Keep only primitive values in a flat object, with key and string caps. */
export function flatPrimitives(
  input: Record<string, unknown> | undefined,
  maxKeys: number,
  maxString: number,
): Record<string, Primitive> {
  const out: Record<string, Primitive> = {}
  if (!input || typeof input !== 'object') return out
  let n = 0
  for (const k of Object.keys(input)) {
    if (n >= maxKeys) break
    const v = (input as Record<string, unknown>)[k]
    if (typeof v === 'string') out[truncate(k, LIMITS.tagKey)] = truncate(v, maxString)
    else if (typeof v === 'number' && isFinite(v)) out[truncate(k, LIMITS.tagKey)] = v
    else if (typeof v === 'boolean') out[truncate(k, LIMITS.tagKey)] = v
    else continue
    n++
  }
  return out
}

/** Normalize an arbitrary object into a small JSON-safe value. */
export function normalize(value: unknown, depth = 3, maxString = LIMITS.message): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return truncate(value, maxString)
  if (typeof value === 'number') return isFinite(value) ? value : String(value)
  if (typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (value instanceof Error) return { name: value.name, message: truncate(value.message, maxString) }
  if (depth <= 0) return '[Object]'
  try {
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => normalize(v, depth - 1, maxString))
    const out: Record<string, unknown> = {}
    let n = 0
    for (const k of Object.keys(value as object)) {
      if (n++ >= 30) break
      out[k] = normalize((value as Record<string, unknown>)[k], depth - 1, maxString)
    }
    return out
  } catch {
    return '[unserializable]'
  }
}

export function normalizeExtra(extra: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!extra || typeof extra !== 'object') return undefined
  const n = normalize(extra, 3) as Record<string, unknown>
  try {
    const size = JSON.stringify(n).length
    if (size > LIMITS.extraBytes) return { _truncated: true, _size: size }
  } catch {
    return undefined
  }
  return n
}

export function normalizeTags(tags: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!tags || typeof tags !== 'object') return out
  let n = 0
  for (const k of Object.keys(tags)) {
    if (n >= LIMITS.maxTags) break
    const v = (tags as Record<string, unknown>)[k]
    if (v === undefined || v === null) continue
    out[truncate(k, LIMITS.tagKey)] = truncate(typeof v === 'string' ? v : safeString(v), LIMITS.tagValue)
    n++
  }
  return out
}

/** Top stack frame line, used for dedupe. */
export function topFrame(stack: string): string {
  if (!stack) return ''
  const lines = stack.split('\n')
  for (const line of lines) {
    const l = line.trim()
    if (/^at\s/.test(l) || /@/.test(l)) return l
  }
  return lines[1] ? lines[1].trim() : ''
}
