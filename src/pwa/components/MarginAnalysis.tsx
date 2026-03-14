/**
 * MarginAnalysis.tsx — Session 10
 *
 * Per-product GP% analysis with:
 *  - Margin calculation: (sell - cost) / sell × 100
 *  - Dual-supplier comparison: Lactalis vs Metcash cost
 *  - Sort views: lowest margin, highest margin, most daily profit
 *  - Threshold alerts: < 20% = red, < 28% = amber, ≥ 28% = green
 *  - Price change detection from priceHistory table
 *  - Suggested sell price to hit target margin (default 28%)
 *
 * All prices are ex-GST (CLAUDE.md key decision #8).
 */

import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  AlertTriangle,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import { db } from '../lib/db'
import { MARGIN_TARGET_PCT, MARGIN_ALERT_RED_PCT, MARGIN_ALERT_AMBER_PCT } from '../lib/constants'
import type { Product, PriceRecord } from '../lib/types'

// ─── Constants ────────────────────────────────────────────────────────────────

const TARGET_MARGIN = MARGIN_TARGET_PCT
const ALERT_RED    = MARGIN_ALERT_RED_PCT
const ALERT_AMBER  = MARGIN_ALERT_AMBER_PCT

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calcMarginPct(sell: number, cost: number): number | null {
  if (sell <= 0) return null
  return ((sell - cost) / sell) * 100
}

function suggestedSellPrice(cost: number, targetMarginPct = TARGET_MARGIN): number {
  // sell = cost / (1 - margin); guard against denominator ≤ 0
  if (targetMarginPct >= 100) return 0
  const denominator = 1 - targetMarginPct / 100
  if (denominator <= 0) return 0
  return cost / denominator
}

function marginColor(pct: number | null): string {
  if (pct === null) return 'text-gray-400'
  if (pct < ALERT_RED)   return 'text-red-600 font-semibold'
  if (pct < ALERT_AMBER) return 'text-amber-500 font-semibold'
  return 'text-green-600'
}

function marginBg(pct: number | null): string {
  if (pct === null) return 'bg-gray-50'
  if (pct < ALERT_RED)   return 'bg-red-50 border-red-100'
  if (pct < ALERT_AMBER) return 'bg-amber-50 border-amber-100'
  return 'bg-white'
}

// ─── Types ────────────────────────────────────────────────────────────────────

type SortMode = 'lowest' | 'highest' | 'profit'

interface ProductMargin {
  product: Product
  marginPct: number | null
  dailyProfit: number       // avg daily profit = avgDailySales × (sell - cost)
  avgDailySales: number
  recentPriceChanges: PriceRecord[]
  hasPriceRise: boolean
}

// ─── Product row ──────────────────────────────────────────────────────────────

function MarginRow({
  pm,
  productHistory,
}: {
  pm: ProductMargin
  productHistory: PriceRecord[]   // M5 — pre-filtered for this product
}) {
  const [expanded, setExpanded] = useState(false)
  const p = pm.product

  const lactalisCost = p.lactalisCostPrice
  const metcashCost  = p.metcashCostPrice ?? null
  const marginLactalis = calcMarginPct(p.sellPrice, lactalisCost)
  const marginMetcash  = metcashCost !== null ? calcMarginPct(p.sellPrice, metcashCost) : null
  const suggested = p.sellPrice > 0 && pm.marginPct !== null && pm.marginPct < TARGET_MARGIN
    ? suggestedSellPrice(lactalisCost)
    : null

  // Price trend — last 4 history entries (already scoped to this product)
  const history = [...productHistory]
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))
    .slice(0, 4)

  const priceRose = history.length >= 2 && history[0]!.costPrice > history[1]!.costPrice
  const priceFell = history.length >= 2 && history[0]!.costPrice < history[1]!.costPrice

  return (
    <div className={`border-b border-gray-100 last:border-0 ${marginBg(pm.marginPct)}`}>
      {/* Summary row */}
      <button
        className="w-full text-left px-3 py-2.5 flex items-start gap-2"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium text-gray-900 truncate">{p.name}</span>
            {p.isGstBearing && (
              <span className="text-[10px] px-1 py-0.5 bg-purple-100 text-purple-700 rounded">GST</span>
            )}
            {priceRose && (
              <span title="Cost rose recently"><TrendingUp size={12} className="text-red-400" /></span>
            )}
            {priceFell && (
              <span title="Cost fell recently"><TrendingDown size={12} className="text-green-500" /></span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-xs text-gray-500">Cost ${lactalisCost.toFixed(2)}</span>
            {metcashCost !== null && (
              <span className="text-xs text-gray-400">/ ${metcashCost.toFixed(2)} MC</span>
            )}
            <span className="text-xs text-gray-400">·</span>
            <span className="text-xs text-gray-600">
              Sell {p.sellPrice > 0 ? `$${p.sellPrice.toFixed(2)}` : '—'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 mt-0.5">
          <div className="text-right">
            <p className={`text-sm ${marginColor(pm.marginPct)}`}>
              {pm.marginPct !== null ? `${pm.marginPct.toFixed(1)}%` : '—'}
            </p>
            {pm.dailyProfit > 0 && (
              <p className="text-[10px] text-gray-400">${pm.dailyProfit.toFixed(2)}/day</p>
            )}
          </div>
          {expanded ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-3 bg-white border-t border-gray-100 space-y-3">

          {/* Margin breakdown */}
          <div className="grid grid-cols-2 gap-2 mt-2">
            <div className="bg-gray-50 rounded-lg p-2">
              <p className="text-[10px] text-gray-400 uppercase tracking-wide">Lactalis Margin</p>
              <p className={`text-base font-bold ${marginColor(marginLactalis)}`}>
                {marginLactalis !== null ? `${marginLactalis.toFixed(1)}%` : '—'}
              </p>
              <p className="text-[11px] text-gray-500">Cost ${lactalisCost.toFixed(2)}</p>
            </div>
            {metcashCost !== null ? (
              <div className="bg-gray-50 rounded-lg p-2">
                <p className="text-[10px] text-gray-400 uppercase tracking-wide">Metcash Margin</p>
                <p className={`text-base font-bold ${marginColor(marginMetcash)}`}>
                  {marginMetcash !== null ? `${marginMetcash.toFixed(1)}%` : '—'}
                </p>
                <p className="text-[11px] text-gray-500">Cost ${metcashCost.toFixed(2)}</p>
              </div>
            ) : (
              <div className="bg-gray-50 rounded-lg p-2 flex items-center justify-center">
                <p className="text-[11px] text-gray-400 text-center">No Metcash<br />price on file</p>
              </div>
            )}
          </div>

          {/* Suggested price */}
          {suggested !== null && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              <AlertTriangle size={13} className="text-amber-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-xs font-medium text-amber-700">
                  Suggested sell: ${suggested.toFixed(2)}
                </p>
                <p className="text-[11px] text-amber-600">
                  To reach {TARGET_MARGIN}% margin on Lactalis cost
                </p>
              </div>
            </div>
          )}

          {/* Price history */}
          {history.length > 0 && (
            <div>
              <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1.5">Cost Price History</p>
              <div className="space-y-1">
                {history.map((r, i) => {
                  const prev = history[i + 1]
                  const delta = prev ? r.costPrice - prev.costPrice : 0
                  return (
                    <div key={r.id} className="flex items-center justify-between text-xs">
                      <span className="text-gray-500">{r.effectiveDate}</span>
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-gray-800">${r.costPrice.toFixed(2)}</span>
                        {delta !== 0 && (
                          <span className={delta > 0 ? 'text-red-500' : 'text-green-500'}>
                            {delta > 0 ? '+' : ''}{delta.toFixed(2)}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Dual-supplier savings */}
          {metcashCost !== null && metcashCost < lactalisCost && (
            <div className="flex items-start gap-2 bg-green-50 border border-green-100 rounded-lg px-3 py-2">
              <TrendingDown size={13} className="text-green-500 mt-0.5 shrink-0" />
              <p className="text-xs text-green-700">
                Metcash is ${(lactalisCost - metcashCost).toFixed(2)} cheaper per unit
                {pm.avgDailySales > 0 && ` · saves $${((lactalisCost - metcashCost) * pm.avgDailySales * 7).toFixed(2)}/week`}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

const SORT_LABELS: Record<SortMode, string> = {
  lowest:  'Lowest Margin',
  highest: 'Highest Margin',
  profit:  'Most Daily Profit',
}

export default function MarginAnalysis() {
  const [sort, setSort] = useState<SortMode>('lowest')
  const [sortCycle] = useState<SortMode[]>(['lowest', 'highest', 'profit'])

  function cycleSort() {
    setSort((prev) => {
      const idx = sortCycle.indexOf(prev)
      return sortCycle[(idx + 1) % sortCycle.length]!
    })
  }

  const products = useLiveQuery(() => db.products.toArray(), [])
  const priceHistory = useLiveQuery(() => db.priceHistory.toArray(), [])

  // ── All hooks MUST come before any conditional return ──────────────────────

  // M5 — pre-group price history by productId so MarginRow doesn't O(n) filter per product
  const priceHistoryByProduct = useMemo(() => {
    const map = new Map<number, PriceRecord[]>()
    for (const r of priceHistory ?? []) {
      const arr = map.get(r.productId) ?? []
      arr.push(r)
      map.set(r.productId, arr)
    }
    return map
  }, [priceHistory])

  const active = useMemo(() => (products ?? []).filter((p) => p.active), [products])

  // Memoised — only recalculates when products or priceHistory change, not on sort change
  const rows = useMemo<ProductMargin[]>(() => active.map((p) => {
    const marginPct = calcMarginPct(p.sellPrice, p.lactalisCostPrice)
    const deliveriesPerWeek = { every: 3, most: 2.5, some: 1.5, occasional: 0.5 }[p.orderFrequency] ?? 2
    const avgDailySales = (p.defaultOrderQty * deliveriesPerWeek) / 7
    const gpPerUnit = p.sellPrice > 0 ? p.sellPrice - p.lactalisCostPrice : 0
    const dailyProfit = avgDailySales * gpPerUnit

    const recentPriceChanges = (priceHistoryByProduct.get(p.id!) ?? [])
      .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))
      .slice(0, 2)

    const hasPriceRise =
      recentPriceChanges.length >= 2 &&
      recentPriceChanges[0]!.costPrice > recentPriceChanges[1]!.costPrice

    return { product: p, marginPct, dailyProfit, avgDailySales, recentPriceChanges, hasPriceRise }
  }), [active, priceHistoryByProduct])

  // Memoised sort — only re-sorts when rows or sort mode change
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    if (sort === 'lowest') {
      if (a.marginPct === null) return 1
      if (b.marginPct === null) return -1
      return a.marginPct - b.marginPct
    }
    if (sort === 'highest') {
      if (a.marginPct === null) return 1
      if (b.marginPct === null) return -1
      return b.marginPct - a.marginPct
    }
    return b.dailyProfit - a.dailyProfit
  }), [rows, sort])

  if (!products || !priceHistory) {
    return <div className="p-4 text-sm text-gray-400">Loading…</div>
  }

  // Summary stats
  const withSell   = rows.filter((r) => r.marginPct !== null)
  const belowRed   = withSell.filter((r) => r.marginPct! < ALERT_RED)
  const belowAmber = withSell.filter((r) => r.marginPct! >= ALERT_RED && r.marginPct! < ALERT_AMBER)
  const avgMargin  = withSell.length
    ? withSell.reduce((s, r) => s + r.marginPct!, 0) / withSell.length
    : 0
  const priceRises = rows.filter((r) => r.hasPriceRise).length

  return (
    <div className="flex flex-col h-full">

      {/* Summary bar */}
      <div className="grid grid-cols-4 divide-x divide-gray-100 border-b border-gray-200 bg-gray-50 shrink-0">
        <div className="px-2 py-2 text-center">
          <p className="text-base font-bold text-gray-900">{avgMargin.toFixed(1)}%</p>
          <p className="text-[10px] text-gray-400">avg GP</p>
        </div>
        <div className="px-2 py-2 text-center">
          <p className={`text-base font-bold ${belowRed.length > 0 ? 'text-red-600' : 'text-gray-300'}`}>
            {belowRed.length}
          </p>
          <p className="text-[10px] text-gray-400">&lt;{ALERT_RED}%</p>
        </div>
        <div className="px-2 py-2 text-center">
          <p className={`text-base font-bold ${belowAmber.length > 0 ? 'text-amber-500' : 'text-gray-300'}`}>
            {belowAmber.length}
          </p>
          <p className="text-[10px] text-gray-400">&lt;{ALERT_AMBER}%</p>
        </div>
        <div className="px-2 py-2 text-center">
          <p className={`text-base font-bold ${priceRises > 0 ? 'text-red-500' : 'text-gray-300'}`}>
            {priceRises}
          </p>
          <p className="text-[10px] text-gray-400">↑ price</p>
        </div>
      </div>

      {/* Sort toggle */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-white shrink-0">
        <p className="text-xs text-gray-500">{active.length} active products</p>
        <button
          onClick={cycleSort}
          className="flex items-center gap-1.5 text-xs font-medium text-blue-600 px-2.5 py-1 border border-blue-100 rounded-lg bg-blue-50"
        >
          <ArrowUpDown size={12} />
          {SORT_LABELS[sort]}
        </button>
      </div>

      {/* Product list */}
      <div className="flex-1 overflow-auto">
        {sorted.map((pm) => (
          <MarginRow
            key={pm.product.id}
            pm={pm}
            productHistory={priceHistoryByProduct.get(pm.product.id!) ?? []}
          />
        ))}

        {active.length === 0 && (
          <div className="p-8 text-center text-sm text-gray-400">
            No active products
          </div>
        )}
      </div>
    </div>
  )
}
