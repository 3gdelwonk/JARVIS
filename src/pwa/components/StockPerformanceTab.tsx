/**
 * StockPerformanceTab.tsx — Stock intelligence & performance analytics
 *
 * Sections:
 *  1. KPI cards: Stock Value | Avg GMROI | Avg Days of Stock | Dead Stock count
 *  2. Department filter: All | Dairy | Liquor | General
 *  3. ABC distribution bar
 *  4. Sortable product performance table
 *  5. Dead stock panel
 */

import { useState, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  AlertTriangle,
  BarChart2,
  ChevronDown,
  ChevronUp,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import { db } from '../lib/db'
import { classifyABC, computePerformance, getLatestQoh, stockValue } from '../lib/stockAnalytics'
import type { StockPerformance } from '../lib/types'

// ─── Dept filter ──────────────────────────────────────────────────────────────

type DeptFilter = 'all' | 'dairy' | 'liquor' | 'general'

// ─── Sort config ──────────────────────────────────────────────────────────────

type SortKey = 'name' | 'qoh' | 'daysOfStock' | 'velocity' | 'trend' | 'gmroi' | 'abc'
type SortDir = 'asc' | 'desc'

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 px-3 py-2.5 flex-1 min-w-0">
      <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wide truncate">{label}</p>
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

// ─── Performance row ──────────────────────────────────────────────────────────

function PerfRow({
  name, dept, qoh, perf,
}: {
  name: string; dept: string; qoh: number | null; perf: StockPerformance
}) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 border-b border-gray-100 last:border-0 ${ABC_ROW_COLORS[perf.abcClass]}`}>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-gray-800 truncate">{name}</p>
        <p className="text-[10px] text-gray-400">{dept}</p>
      </div>
      <div className="grid grid-cols-5 gap-1.5 shrink-0 text-right text-[11px]">
        <span className="text-gray-700 font-medium">{qoh ?? '—'}</span>
        <span className={`${perf.daysOfStock <= 2 ? 'text-red-600 font-semibold' : perf.daysOfStock >= 14 ? 'text-amber-600' : 'text-gray-700'}`}>
          {perf.daysOfStock === 999 ? '∞' : fmt(perf.daysOfStock)}d
        </span>
        <span className="text-gray-600">{fmt(perf.avgDailySales)}/d</span>
        <span className={`${perf.velocityTrend > 10 ? 'text-green-600' : perf.velocityTrend < -10 ? 'text-red-600' : 'text-gray-500'} flex items-center justify-end gap-0.5`}>
          {perf.velocityTrend > 0 ? <TrendingUp size={9} /> : perf.velocityTrend < 0 ? <TrendingDown size={9} /> : null}
          {perf.velocityTrend > 0 ? '+' : ''}{perf.velocityTrend}%
        </span>
        <span className={`px-1 rounded text-[10px] font-medium ${ABC_COLORS[perf.abcClass]}`}>
          {perf.abcClass}
        </span>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function StockPerformanceTab() {
  const [deptFilter, setDeptFilter] = useState<DeptFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('abc')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [showDead, setShowDead] = useState(false)

  function handleSort(col: SortKey) {
    if (sortKey === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(col)
      setSortDir('asc')
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
    }))

    return { performances, totalStockValue }
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
        case 'trend': cmp = a.perf.velocityTrend - b.perf.velocityTrend; break
        case 'gmroi': cmp = a.perf.gmroi - b.perf.gmroi; break
        case 'abc': cmp = (abcOrder[a.perf.abcClass] ?? 4) - (abcOrder[b.perf.abcClass] ?? 4); break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [deptFiltered, sortKey, sortDir])

  // KPI calculations
  const activePerfs = deptFiltered.filter((r) => r.perf.abcClass !== 'D')
  const avgGmroi = activePerfs.length > 0
    ? activePerfs.reduce((s, r) => s + r.perf.gmroi, 0) / activePerfs.length
    : 0
  const avgDaysStock = activePerfs.length > 0
    ? activePerfs.filter((r) => r.perf.daysOfStock < 999).reduce((s, r) => s + r.perf.daysOfStock, 0) /
      activePerfs.filter((r) => r.perf.daysOfStock < 999).length
    : 0
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

        {/* KPI Cards */}
        <div className="flex gap-2">
          <KpiCard
            label="Stock Value"
            value={`$${totalStockValue.toFixed(0)}`}
            sub="at cost"
          />
          <KpiCard
            label="Avg GMROI"
            value={avgGmroi > 0 ? fmt(avgGmroi, 2) + 'x' : '—'}
            sub="active products"
          />
        </div>
        <div className="flex gap-2">
          <KpiCard
            label="Avg Days Stock"
            value={avgDaysStock > 0 ? `${fmt(avgDaysStock)}d` : '—'}
            sub="active products"
          />
          <KpiCard
            label="Dead Stock"
            value={String(deadCount)}
            sub="products (0 sales 30d)"
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
              <SortableHeader label="Days" col="daysOfStock" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="Vel" col="velocity" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="Trend" col="trend" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="ABC" col="abc" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
            </div>
          </div>

          {sorted.length === 0 ? (
            <div className="py-10 flex flex-col items-center gap-2">
              <BarChart2 size={28} className="text-gray-200" />
              <p className="text-xs text-gray-400">No products — import data to see performance</p>
            </div>
          ) : (
            sorted
              .filter((r) => r.perf.abcClass !== 'D')
              .map((r) => (
                <PerfRow
                  key={r.product.id}
                  name={r.product.name}
                  dept={DEPT_LABELS[r.product.department ?? 'dairy'] ?? 'Dairy'}
                  qoh={r.qoh}
                  perf={r.perf}
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
                        QOH: {r.qoh ?? '—'} · Last sale: {r.perf.lastSaleDate ?? 'never'}
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
