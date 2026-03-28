/**
 * StockPerformanceTab.tsx — Stock intelligence & performance analytics
 *
 * Sections:
 *  1. KPI cards: Stock Value | Sales 7d | Sales 30d | Dead Stock
 *  2. Department filter: All | Dairy | Liquor | General
 *  3. ABC distribution bar
 *  4. Sortable product performance table with expandable insight rows
 *  5. Dead stock panel
 */

import { useState, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  AlertTriangle,
  BarChart2,
  ChevronDown,
  ChevronUp,
  DollarSign,
  Package,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import { db } from '../lib/db'
import { classifyABC, computePerformance, getLatestQoh, stockValue } from '../lib/stockAnalytics'
import type { Product, SalesRecord, StockPerformance } from '../lib/types'

// ─── Dept filter ──────────────────────────────────────────────────────────────

type DeptFilter = 'all' | 'dairy' | 'liquor' | 'general'

// ─── Sort config ──────────────────────────────────────────────────────────────

type SortKey = 'name' | 'qoh' | 'daysOfStock' | 'velocity' | 'sold7d' | 'sold30d' | 'margin' | 'abc'
type SortDir = 'asc' | 'desc'

// ─── Per-product sales insight ───────────────────────────────────────────────

interface SalesInsight {
  qtySold7d: number
  qtySold30d: number
  revenue7d: number
  revenue30d: number
  costPrice: number
  sellPrice: number
  marginPct: number | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function offsetDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().split('T')[0]
}

function computeSalesInsight(product: Product, salesRecords: SalesRecord[]): SalesInsight {
  const cutoff7 = offsetDate(7)
  const cutoff30 = offsetDate(30)
  const productSales = salesRecords.filter(
    (s) => s.productId === product.id || s.barcode === product.barcode,
  )
  const sales7d = productSales.filter((s) => s.date >= cutoff7)
  const sales30d = productSales.filter((s) => s.date >= cutoff30)

  const cost = product.lactalisCostPrice || 0
  const sell = product.sellPrice || 0
  const marginPct = sell > 0 ? ((sell - cost) / sell) * 100 : null

  return {
    qtySold7d: sales7d.reduce((s, r) => s + r.qtySold, 0),
    qtySold30d: sales30d.reduce((s, r) => s + r.qtySold, 0),
    revenue7d: sales7d.reduce((s, r) => s + r.salesValue, 0),
    revenue30d: sales30d.reduce((s, r) => s + r.salesValue, 0),
    costPrice: cost,
    sellPrice: sell,
    marginPct,
  }
}

const ABC_COLORS: Record<string, string> = {
  A: 'bg-green-100 text-green-800',
  B: 'bg-teal-100 text-teal-800',
  C: 'bg-amber-100 text-amber-800',
  D: 'bg-red-100 text-red-700',
}

const ABC_ROW_COLORS: Record<string, string> = {
  A: 'border-l-2 border-l-green-400',
  B: 'border-l-2 border-l-teal-400',
  C: 'border-l-2 border-l-amber-400',
  D: 'border-l-2 border-l-red-400',
}

function fmt(n: number, dec = 1): string {
  return n.toFixed(dec)
}

function fmtDollar(n: number): string {
  return '$' + n.toFixed(2)
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon?: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 px-3 py-2.5 flex-1 min-w-0">
      <div className="flex items-center gap-1.5">
        {icon}
        <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wide truncate">{label}</p>
      </div>
      <p className="text-lg font-bold text-gray-900 mt-0.5 truncate">{value}</p>
      {sub && <p className="text-[10px] text-gray-400 truncate">{sub}</p>}
    </div>
  )
}

// ─── ABC Distribution bar ─────────────────────────────────────────────────────

function AbcBar({ counts }: { counts: Record<string, number> }) {
  const total = Object.values(counts).reduce((s, v) => s + v, 0)
  if (total === 0) return null
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-3">
      <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">ABC Distribution</p>
      <div className="flex h-4 rounded-full overflow-hidden gap-0.5">
        {(['A', 'B', 'C', 'D'] as const).map((cls) => {
          const pct = (counts[cls] ?? 0) / total * 100
          const bg = cls === 'A' ? 'bg-green-400' : cls === 'B' ? 'bg-teal-400' : cls === 'C' ? 'bg-amber-400' : 'bg-red-400'
          return pct > 0 ? (
            <div key={cls} className={`${bg} h-full`} style={{ width: `${pct}%` }} />
          ) : null
        })}
      </div>
      <div className="flex gap-3 mt-1.5">
        {(['A', 'B', 'C', 'D'] as const).map((cls) => (
          <div key={cls} className="flex items-center gap-1">
            <span className={`text-[10px] px-1 rounded font-medium ${ABC_COLORS[cls]}`}>{cls}</span>
            <span className="text-[10px] text-gray-500">{counts[cls] ?? 0}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Sortable column header ────────────────────────────────────────────────────

function SortableHeader({
  label, col, sortKey, sortDir, onSort,
}: {
  label: string; col: SortKey; sortKey: SortKey; sortDir: SortDir
  onSort: (col: SortKey) => void
}) {
  const active = sortKey === col
  return (
    <button
      className={`flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide ${active ? 'text-blue-600' : 'text-gray-400'}`}
      onClick={() => onSort(col)}
    >
      {label}
      {active ? (
        sortDir === 'asc' ? <ChevronUp size={9} /> : <ChevronDown size={9} />
      ) : (
        <ChevronDown size={9} className="opacity-30" />
      )}
    </button>
  )
}

// ─── Insight stat pill ───────────────────────────────────────────────────────

function InsightStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-gray-50 rounded-lg px-2.5 py-1.5 min-w-0">
      <p className="text-[9px] font-medium text-gray-400 uppercase tracking-wide">{label}</p>
      <p className="text-sm font-bold text-gray-800">{value}</p>
      {sub && <p className="text-[9px] text-gray-400">{sub}</p>}
    </div>
  )
}

// ─── Performance row with expandable detail ──────────────────────────────────

function PerfRow({
  name, dept, qoh, perf, insight, expanded, onToggle,
}: {
  name: string; dept: string; qoh: number | null; perf: StockPerformance
  insight: SalesInsight; expanded: boolean; onToggle: () => void
}) {
  const marginColor = insight.marginPct === null ? 'text-gray-400'
    : insight.marginPct >= 28 ? 'text-green-600'
    : insight.marginPct >= 20 ? 'text-amber-600'
    : 'text-red-600'

  return (
    <div className={`border-b border-gray-100 last:border-0 ${ABC_ROW_COLORS[perf.abcClass]}`}>
      {/* Summary row — tap to expand */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
        onClick={onToggle}
      >
        <div className="flex-1 min-w-0">
          <p className="text-xs text-gray-800 truncate">{name}</p>
          <p className="text-[10px] text-gray-400">{dept}</p>
        </div>
        <div className="grid grid-cols-5 gap-1.5 shrink-0 text-right text-[11px]">
          <span className="text-gray-700 font-medium">{qoh ?? '—'}</span>
          <span className="text-blue-700 font-medium">{insight.qtySold7d}</span>
          <span className="text-gray-600">{fmt(perf.avgDailySales)}/d</span>
          <span className={`${perf.velocityTrend > 10 ? 'text-green-600' : perf.velocityTrend < -10 ? 'text-red-600' : 'text-gray-500'} flex items-center justify-end gap-0.5`}>
            {perf.velocityTrend > 0 ? <TrendingUp size={9} /> : perf.velocityTrend < 0 ? <TrendingDown size={9} /> : null}
            {perf.velocityTrend > 0 ? '+' : ''}{perf.velocityTrend}%
          </span>
          <span className={`px-1 rounded text-[10px] font-medium ${ABC_COLORS[perf.abcClass]}`}>
            {perf.abcClass}
          </span>
        </div>
      </button>

      {/* Expanded insight panel */}
      {expanded && (
        <div className="px-3 pb-3 pt-0.5">
          <div className="grid grid-cols-3 gap-1.5 mb-1.5">
            <InsightStat label="Sold 7d" value={String(insight.qtySold7d)} sub={fmtDollar(insight.revenue7d)} />
            <InsightStat label="Sold 30d" value={String(insight.qtySold30d)} sub={fmtDollar(insight.revenue30d)} />
            <InsightStat label="Velocity" value={`${fmt(perf.avgDailySales)}/d`} sub={`${perf.daysOfStock === 999 ? '∞' : fmt(perf.daysOfStock)}d stock`} />
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <InsightStat label="Cost" value={fmtDollar(insight.costPrice)} />
            <InsightStat label="Sell" value={fmtDollar(insight.sellPrice)} />
            <div className="bg-gray-50 rounded-lg px-2.5 py-1.5">
              <p className="text-[9px] font-medium text-gray-400 uppercase tracking-wide">Margin</p>
              <p className={`text-sm font-bold ${marginColor}`}>
                {insight.marginPct !== null ? `${fmt(insight.marginPct)}%` : '—'}
              </p>
              <p className="text-[9px] text-gray-400">GMROI {fmt(perf.gmroi, 2)}x</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function StockPerformanceTab() {
  const [deptFilter, setDeptFilter] = useState<DeptFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('sold7d')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [showDead, setShowDead] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  function handleSort(col: SortKey) {
    if (sortKey === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(col)
      setSortDir(col === 'name' ? 'asc' : 'desc')
    }
  }

  // Fetch all required data in one live query
  const data = useLiveQuery(async () => {
    const [products, salesRecords, snapshots, invoiceLines, invoiceRecords] = await Promise.all([
      db.products.filter((p) => p.active !== false).toArray(),
      db.salesRecords.toArray(),
      db.stockSnapshots.toArray(),
      db.invoiceLines.toArray(),
      db.invoiceRecords.toArray(),
    ])

    const invoiceIds = new Set(
      invoiceRecords.filter((r) => r.documentType === 'invoice').map((r) => r.id!),
    )
    const invoiceOnlyLines = invoiceLines.filter((l) => invoiceIds.has(l.invoiceRecordId))

    const latestQoh = getLatestQoh(snapshots)

    const abcMap = classifyABC(products, salesRecords)
    const totalStockValue = stockValue(products, snapshots)

    const performances = products.map((p) => ({
      product: p,
      qoh: latestQoh.get(p.id!) ?? null,
      perf: computePerformance(p, {
        salesRecords,
        snapshots,
        invoiceLines: invoiceOnlyLines,
        abcClass: abcMap.get(p.id!) ?? 'D',
      }),
      insight: computeSalesInsight(p, salesRecords),
    }))

    // Aggregate totals for KPI cards
    const totalRevenue7d = performances.reduce((s, r) => s + r.insight.revenue7d, 0)
    const totalRevenue30d = performances.reduce((s, r) => s + r.insight.revenue30d, 0)
    const totalQty7d = performances.reduce((s, r) => s + r.insight.qtySold7d, 0)
    const totalQty30d = performances.reduce((s, r) => s + r.insight.qtySold30d, 0)

    return { performances, totalStockValue, totalRevenue7d, totalRevenue30d, totalQty7d, totalQty30d }
  }, [])

  const performances = data?.performances ?? []
  const totalStockValue = data?.totalStockValue ?? 0

  // Department filter
  const deptFiltered = useMemo(() => {
    if (deptFilter === 'all') return performances
    return performances.filter((r) => (r.product.department ?? 'dairy') === deptFilter)
  }, [performances, deptFilter])

  // Sort
  const sorted = useMemo(() => {
    return [...deptFiltered].sort((a, b) => {
      let cmp = 0
      const abcOrder: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 }
      switch (sortKey) {
        case 'name': cmp = a.product.name.localeCompare(b.product.name); break
        case 'qoh': cmp = (a.qoh ?? -1) - (b.qoh ?? -1); break
        case 'daysOfStock': cmp = a.perf.daysOfStock - b.perf.daysOfStock; break
        case 'velocity': cmp = a.perf.avgDailySales - b.perf.avgDailySales; break
        case 'sold7d': cmp = a.insight.qtySold7d - b.insight.qtySold7d; break
        case 'sold30d': cmp = a.insight.qtySold30d - b.insight.qtySold30d; break
        case 'margin': cmp = (a.insight.marginPct ?? -1) - (b.insight.marginPct ?? -1); break
        case 'abc': cmp = (abcOrder[a.perf.abcClass] ?? 4) - (abcOrder[b.perf.abcClass] ?? 4); break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [deptFiltered, sortKey, sortDir])

  // KPI calculations
  const deadCount = deptFiltered.filter((r) => r.perf.abcClass === 'D').length
  const deadStock = sorted.filter((r) => r.perf.abcClass === 'D')

  // ABC counts for bar chart
  const abcCounts = { A: 0, B: 0, C: 0, D: 0 }
  for (const r of deptFiltered) {
    abcCounts[r.perf.abcClass] = (abcCounts[r.perf.abcClass] ?? 0) + 1
  }

  const DEPT_LABELS: Record<string, string> = { dairy: 'Dairy', liquor: 'Liquor', general: 'General' }

  return (
    <div className="flex flex-col h-full overflow-auto pb-6">
      <div className="p-3 space-y-3">

        {/* KPI Cards — Row 1 */}
        <div className="flex gap-2">
          <KpiCard
            label="Stock Value"
            value={`$${totalStockValue.toFixed(0)}`}
            sub="at cost"
            icon={<Package size={10} className="text-gray-400" />}
          />
          <KpiCard
            label="Dead Stock"
            value={String(deadCount)}
            sub="0 sales in 30d"
            icon={<AlertTriangle size={10} className="text-gray-400" />}
          />
        </div>

        {/* KPI Cards — Row 2: Sales summary */}
        <div className="flex gap-2">
          <KpiCard
            label="Sales 7d"
            value={`$${(data?.totalRevenue7d ?? 0).toFixed(0)}`}
            sub={`${data?.totalQty7d ?? 0} units`}
            icon={<DollarSign size={10} className="text-blue-400" />}
          />
          <KpiCard
            label="Sales 30d"
            value={`$${(data?.totalRevenue30d ?? 0).toFixed(0)}`}
            sub={`${data?.totalQty30d ?? 0} units`}
            icon={<DollarSign size={10} className="text-blue-400" />}
          />
        </div>

        {/* Department filter */}
        <div className="flex gap-1.5">
          {(['all', 'dairy', 'liquor', 'general'] as const).map((dept) => (
            <button
              key={dept}
              onClick={() => setDeptFilter(dept)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                deptFilter === dept
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {dept === 'all' ? 'All' : DEPT_LABELS[dept]}
            </button>
          ))}
        </div>

        {/* ABC Distribution */}
        <AbcBar counts={abcCounts} />

        {/* Product table */}
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          {/* Column headers */}
          <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
            <div className="flex-1">
              <SortableHeader label="Product" col="name" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            </div>
            <div className="grid grid-cols-5 gap-1.5 shrink-0 text-right">
              <SortableHeader label="QOH" col="qoh" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="7d" col="sold7d" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="Vel" col="velocity" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="Trend" col="daysOfStock" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="ABC" col="abc" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            </div>
          </div>

          {sorted.length === 0 ? (
            <div className="py-10 flex flex-col items-center gap-2">
              <BarChart2 size={28} className="text-gray-200" />
              <p className="text-xs text-gray-400">No products — import data to see performance</p>
            </div>
          ) : (
            sorted.map((r) => (
              <PerfRow
                key={r.product.id}
                name={r.product.name}
                dept={DEPT_LABELS[r.product.department ?? 'dairy'] ?? 'Dairy'}
                qoh={r.qoh}
                perf={r.perf}
                insight={r.insight}
                expanded={expandedId === r.product.id}
                onToggle={() => setExpandedId(expandedId === r.product.id ? null : r.product.id!)}
              />
            ))
          )}
        </div>

        {/* Dead stock panel */}
        {deadStock.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <button
              className="w-full px-3 py-2.5 flex items-center justify-between bg-red-50"
              onClick={() => setShowDead((v) => !v)}
            >
              <div className="flex items-center gap-2">
                <AlertTriangle size={14} className="text-red-500" />
                <span className="text-sm font-semibold text-red-800">
                  Dead Stock — {deadStock.length} products
                </span>
              </div>
              {showDead ? <ChevronUp size={14} className="text-red-400" /> : <ChevronDown size={14} className="text-red-400" />}
            </button>
            {showDead && (
              <div className="divide-y divide-gray-100">
                {deadStock.map((r) => (
                  <div key={r.product.id} className="px-3 py-2 flex items-center justify-between">
                    <div>
                      <p className="text-xs text-gray-800">{r.product.name}</p>
                      <p className="text-[10px] text-gray-400">
                        QOH: {r.qoh ?? '—'} · Cost: {fmtDollar(r.insight.costPrice)} · Last sale: {r.perf.lastSaleDate ?? 'never'}
                      </p>
                    </div>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">D</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
