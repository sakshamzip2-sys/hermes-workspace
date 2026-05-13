/**
 * OpenComputer profile-swap toast listener.
 *
 * Subscribes to OC's dashboard SSE event stream
 * (`/api/v1/events?topics=profile_swap`) at the configured OC backend
 * URL and renders a toast whenever OC silently swaps the active
 * profile (auto-trigger or `/handoff <target>`).
 *
 * Event shape comes from OC's `ProfileSwapEvent` projected through the
 * SSE wildcard pattern. See:
 *   OpenComputer/docs/integrations/profile-swap-event-consumers.md
 *
 * Failure-isolated: EventSource auto-reconnects on transient drops,
 * malformed payloads are logged + skipped, and a missing/unreachable
 * OC backend is degraded silently (workspace continues to function;
 * the user just doesn't see swap toasts).
 *
 * Mount once at app root.
 */
import { useEffect } from 'react'
import { toast } from '@/components/ui/toast'

const DEFAULT_OC_BACKEND_URL = 'http://127.0.0.1:9119'

/** Shape projected by OC's SSE wildcard from ``ProfileSwapEvent``. */
export interface ProfileSwapEventPayload {
  event_type: string
  event_id?: string
  timestamp?: number
  from_profile: string
  to_profile: string
  trigger: 'auto' | 'manual' | 'cli'
  classifier_confidence?: number
  classifier_reason?: string
  has_handoff?: boolean
}

/**
 * Resolve the OC backend URL — env override first (build-time
 * Vite var or runtime window injection), then sensible localhost
 * default that matches OC's dashboard port.
 */
export function resolveOcBackendUrl(): string {
  // Vite-injected env var, set at build time.
  // Falls back to runtime window override (useful for Electron shell
  // that knows OC was launched with --port).
  const viteUrl =
    typeof import.meta !== 'undefined' &&
    (import.meta as unknown as { env?: Record<string, string> }).env
      ?.VITE_OPENCOMPUTER_BACKEND_URL
  if (viteUrl && typeof viteUrl === 'string') return viteUrl

  if (typeof window !== 'undefined') {
    const win = window as unknown as { __OC_BACKEND_URL__?: string }
    if (win.__OC_BACKEND_URL__) return win.__OC_BACKEND_URL__
  }
  return DEFAULT_OC_BACKEND_URL
}

/** Pretty-print the swap for the toast body. */
export function formatProfileSwapMessage(
  payload: ProfileSwapEventPayload,
): string {
  const from = payload.from_profile || '?'
  const to = payload.to_profile || '?'
  const trigger = payload.trigger || 'auto'
  const conf =
    typeof payload.classifier_confidence === 'number' &&
    payload.classifier_confidence > 0 &&
    trigger === 'auto'
      ? ` · ${Math.round(payload.classifier_confidence * 100)}%`
      : ''
  const handoff = payload.has_handoff ? ' (handoff written)' : ''
  return `↪ @${from} → @${to} [${trigger}${conf}]${handoff}`
}

/**
 * Validate that an SSE-projected event is actually a profile_swap
 * event from OC. Rejects malformed shapes silently — the SSE wildcard
 * stream carries every bus event, but our route URL already filters
 * server-side; this is belt-and-braces against a regression that
 * widens the filter.
 */
export function isProfileSwapPayload(
  data: unknown,
): data is ProfileSwapEventPayload {
  if (data === null || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  if (d.event_type !== 'profile_swap') return false
  if (typeof d.from_profile !== 'string') return false
  if (typeof d.to_profile !== 'string') return false
  if (
    typeof d.trigger !== 'string' ||
    !['auto', 'manual', 'cli'].includes(d.trigger)
  )
    return false
  return true
}

/**
 * React component that opens a single EventSource for the app's
 * lifetime. Idempotent across hot-reloads because React's effect
 * cleanup closes the EventSource on unmount/remount.
 */
export function OpenComputerProfileSwapListener(): null {
  useEffect(() => {
    const backend = resolveOcBackendUrl().replace(/\/+$/, '')
    const url = `${backend}/api/v1/events?topics=profile_swap`

    let closed = false
    let es: EventSource | null = null

    try {
      es = new EventSource(url, { withCredentials: false })
    } catch (err) {
      // EventSource constructor only throws on invalid URLs — we built
      // ours from a known base, so this is a hard config error worth
      // surfacing to the dev console.
      console.warn(
        '[OC profile-swap] could not construct EventSource:',
        err,
      )
      return
    }

    const handleEvent = (e: MessageEvent) => {
      if (closed) return
      let data: unknown
      try {
        data = JSON.parse(e.data)
      } catch (err) {
        console.debug('[OC profile-swap] SSE parse error', err)
        return
      }
      if (!isProfileSwapPayload(data)) {
        // Some other event_type slipped through the filter — ignore.
        return
      }
      try {
        toast(formatProfileSwapMessage(data), {
          type: 'info',
          duration: 6000,
          icon: '↪',
        })
      } catch (err) {
        console.warn('[OC profile-swap] toast render failed', err)
      }
    }

    // OC's SSE wraps every payload in ``event: event`` (literal event
    // name "event" — see opencomputer/dashboard/routes/events.py
    // line 152 ``encode_sse("event", item)``). Listen on that channel
    // first; fall back to the default ``message`` channel for any
    // shim/proxy that strips the named event.
    es.addEventListener('event', handleEvent as EventListener)
    es.addEventListener(
      'message',
      handleEvent as EventListener,
    )

    es.onerror = () => {
      // EventSource auto-reconnects on transient drops. Log at debug —
      // not a user-facing failure.
      console.debug('[OC profile-swap] SSE error (auto-reconnecting)')
    }

    return () => {
      closed = true
      try {
        es?.close()
      } catch {
        // ignore
      }
    }
  }, [])

  return null
}

export default OpenComputerProfileSwapListener
