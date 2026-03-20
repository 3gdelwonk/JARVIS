/**
 * constants.ts — Shared business constants and pure helpers
 *
 * Single source of truth for values used across multiple components.
 */

// ─── Business constants ───────────────────────────────────────────────────────

/** ~$580/week ÷ 3 deliveries/week (CLAUDE.md) */
export const AVG_DELIVERY_COST = 193

/** IGA Camberwell delivery days: Mon(1), Wed(3), Fri(5) */
export const DELIVERY_DAYS = [1, 3, 5]

/** Margin thresholds */
export const MARGIN_TARGET_PCT = 28
export const MARGIN_ALERT_RED_PCT = 20
export const MARGIN_ALERT_AMBER_PCT = 28

// ─── Money ────────────────────────────────────────────────────────────────────

/** Round to 2 decimal places — use for all currency values */
export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Gross margin %. Returns null when sell price is zero/negative. */
export function calcMarginPct(sell: number, cost: number): number | null {
  if (sell <= 0) return null
  return ((sell - cost) / sell) * 100
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Parse a YYYY-MM-DD string as LOCAL midnight (not UTC midnight).
 * Use this everywhere instead of `new Date(dateStr)` which is UTC.
 */
export function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

/** Returns a YYYY-MM-DD string for N days ago from today (local time). */
export function getDaysAgoDateString(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().split('T')[0]!
}

/** Next Mon/Wed/Fri delivery date from today (same day included) */
export function nextDeliveryDate(): Date {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(today)
    candidate.setDate(today.getDate() + offset)
    if (DELIVERY_DAYS.includes(candidate.getDay())) return candidate
  }
  return today
}

// ─── Order status badge colours ───────────────────────────────────────────────

import type { Order } from './types'

export const STATUS_BADGE: Record<Order['status'], string> = {
  draft:     'bg-gray-100 text-gray-500',
  approved:  'bg-blue-100 text-blue-700',
  submitted: 'bg-purple-100 text-purple-700',
  delivered: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-600',
}

// ─── localStorage key registry ────────────────────────────────────────────────

/** Single source of truth for all localStorage keys used across the PWA. */
export const STORAGE_KEYS = {
  CLAUDE_KEY:         'milk-manager-claude-key',
  GEMINI_KEY:         'milk-manager-gemini-key',
  GMAIL_CLIENT_ID:    'milk-manager-gmail-client-id',
  GMAIL_TOKEN:        'milk-manager-gmail-token',
  GMAIL_TOKEN_EXPIRY: 'milk-manager-gmail-token-expiry',
  GMAIL_LAST_SYNC:    'milk-manager-gmail-last-sync',
  GMAIL_AUTO_SYNC:    'milk-manager-gmail-auto-sync',
  LAST_TAB:           'milk-manager-last-tab',
} as const

// ─── User-friendly error messages ─────────────────────────────────────────────

/** Map raw JS errors to human-readable messages */
export function friendlyError(e: unknown): string {
  const msg = String(e)
  if (msg.includes('QuotaExceededError') || msg.includes('quota')) {
    return 'Storage full — clear old data to continue.'
  }
  if (msg.includes('NetworkError') || msg.includes('Failed to fetch')) {
    return 'Network error — check your connection and try again.'
  }
  if (msg.includes('AbortError')) {
    return 'Operation was cancelled.'
  }
  if (msg.includes('timed out')) {
    return 'Forecast timed out — tap Retry. Try closing other apps if this repeats.'
  }
  if (msg.toLowerCase().includes('typeerror') || msg.toLowerCase().includes('cannot read')) {
    return 'Something went wrong with the data. Try refreshing the page.'
  }
  return msg
}
