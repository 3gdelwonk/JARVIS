/**
 * posRelay.ts — JARVISmart POS relay client
 *
 * Fetches live stock levels, sales data, and top sellers from Smart Retail POS
 * via the JARVISmart server's POS bridge (/api/pos/*).
 *
 * Uses the same relay URL and API key as lactalisRelay.ts (stored in localStorage).
 */

import { getRelayUrl, getApiKey } from './lactalisRelay'

const POS_TIMEOUT_MS = 15_000 // 15s — POS queries should be fast

async function posFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  const base = getRelayUrl()
  const apiKey = getApiKey()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey) headers['X-API-Key'] = apiKey

  const url = new URL(`${base}/api/pos${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v)
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), POS_TIMEOUT_MS)

  try {
    const res = await fetch(url.toString(), { headers, signal: controller.signal })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(body.error || body.detail || `POS ${res.status}`)
    }
    return res.json() as Promise<T>
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('POS request timed out — JARVISmart may be unresponsive')
    }
    // Safari says "Load failed", Chrome says "Failed to fetch"
    if (/load failed|failed to fetch|networkerror/i.test(err.message || '')) {
      throw new Error('Cannot reach JARVISmart — check that the server is running and the URL is correct')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// ── POS Health ──

interface PosStatus {
  connected: boolean
  reason?: string
}

export async function checkPos(): Promise<PosStatus> {
  try {
    return await posFetch<PosStatus>('/status')
  } catch (err: any) {
    return { connected: false, reason: err.message }
  }
}

// ── Stock levels ──

export interface StockItem {
  itemCode: string
  description: string
  department: string
  qoh: number
  lastReceived?: string
  lastSold?: string
}

interface StockResponse {
  items: StockItem[]
  count: number
}

export async function getStock(opts?: {
  department?: string
  itemCode?: string
  lowStock?: boolean
  limit?: number
}): Promise<StockResponse> {
  const params: Record<string, string> = {}
  if (opts?.department) params.department = opts.department
  if (opts?.itemCode) params.itemCode = opts.itemCode
  if (opts?.lowStock !== undefined) params.lowStock = opts.lowStock ? '1' : '0'
  if (opts?.limit !== undefined) params.limit = String(opts.limit)
  return posFetch<StockResponse>('/stock', params)
}

// ── Sales ──

export interface SalesSummary {
  period: string
  totalSales: number
  totalTransactions: number
  avgBasket?: number
}

export async function getSales(period: string = 'week'): Promise<SalesSummary> {
  return posFetch<SalesSummary>('/sales', { period })
}

// ── Top sellers ──

export interface TopSeller {
  itemCode: string
  description: string
  qtySold: number
  revenue: number
}

interface TopSellersResponse {
  items: TopSeller[]
  days: number
}

export async function getTopSellers(days: number = 7, limit: number = 20): Promise<TopSellersResponse> {
  return posFetch<TopSellersResponse>('/top-sellers', {
    days: String(days),
    limit: String(limit),
  })
}

// ── Search ──

export interface SearchResult {
  itemCode: string
  description: string
  department: string
  qoh: number
  price?: number
}

interface SearchResponse {
  items: SearchResult[]
  count: number
}

export async function searchItems(query: string, limit: number = 20): Promise<SearchResponse> {
  return posFetch<SearchResponse>('/search', {
    q: query,
    limit: String(limit),
  })
}

// ── Item Performance (combined QOH + sales + pricing) ──

export interface ItemPerformance {
  itemCode: string
  description: string
  department: string
  revenue: number
  cost: number
  grossProfit: number
  gpPercent: number
  qtySold: number
  avgDailyVelocity: number
  qoh: number
  sellPrice: number
  avgCost: number
  daysOfStock: number
  supplierCtnCost: number
  ctnQty: number
  grade: string
}

interface ItemPerformanceResponse {
  items: ItemPerformance[]
  count: number
  sort: string
  period: string
}

export async function getItemPerformance(opts: {
  department: string
  days?: number
  limit?: number
}): Promise<ItemPerformanceResponse> {
  return posFetch<ItemPerformanceResponse>('/item-performance', {
    department: opts.department,
    days: String(opts.days ?? 7),
    limit: String(opts.limit ?? 200),
    sort: 'revenue',
  })
}

/** Fetch MILK + DAIRY departments in parallel, return combined array */
export async function getDairyPerformance(days = 7): Promise<ItemPerformance[]> {
  try {
    const [milk, dairy] = await Promise.all([
      getItemPerformance({ department: 'MILK', days, limit: 200 }),
      getItemPerformance({ department: 'DAIRY', days, limit: 200 }),
    ])
    return [...milk.items, ...dairy.items]
  } catch (err) {
    console.warn('[POS] getDairyPerformance failed:', (err as Error).message)
    return []
  }
}
