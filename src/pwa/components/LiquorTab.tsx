import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { AlertTriangle, ChevronDown, ChevronUp, Tag, TrendingUp, Package } from 'lucide-react'
import { db } from '../lib/db'
import {
  getLatestQoh,
  classifyABC,
  computePerformance,
  stockValue,
} from '../lib/stockAnalytics'
import { getDaysAgoDateString, round2 } from '../lib/constants'
import type { Promotion, SalesRecord } from '../lib/types'

// ─── Stock status helper ──────────────────────────────────────────────────────

function stockStatus(qoh: number | null, min: number, max?: number) {
  if (qoh === null) return 'unknown'
  if (qoh < min) return 'low'
  if (max !== undefined && qoh > max) return 'over'
  return 'good'
}

const STATUS_CHIP: Record<string, string> = {
  low:     'bg-red-100 text-red-700',
  over:    'bg-amber-100 text-amber-700',
  good:    'bg-green-100 text-green-700',
  unknown: 'bg-gray-100 text-gray-500',
}
const STATUS_LABEL: Record<string, string> = {
  low: 'Low', over: 'Over', good: 'Good', unknown: '—',
}

const CATEGORY_LABELS: Record<string, string> = {
  beer:     'Beer',
  wine:     'Wine',
  spirits:  'Spirits',
  cider:    'Cider',
  rtd:      'RTD',
  non_alc:  'Non-Alc',
  specialty: 'Other',
  fresh:    'Other',
  flavoured:'Other',
  uht:      'Other',
}

const CATEGORY_COLORS: Record<string, string> = {
  beer:    'bg-amber-100 text-amber-800',
  wine:    'bg-purple-100 text-purple-800',
  spirits: 'bg-blue-100 text-blue-800',
  cider:   'bg-green-100 text-green-800',
  rtd:     'bg-pink-100 text-pink-800',
  non_alc: 'bg-gray-100 text-gray-600',
  specialty:'bg-gray-100 text-gray-600',
}

// ─── Velocity lift for history promos ────────────────────────────────────────

function computePromoLift(promo: Promotion, salesRecords: SalesRecord[]) {
  const promoDays = Math.max(
    1,
    Math.round((new Date(promo.endDate).getTime() - new Date(promo.startDate).getTime()) / 86400000) + 1
  )
  const baselineStart = (() => {
    const d = new Date(promo.startDate); d.setDate(d.getDate() - 30)
    return d.toISOString().split('T')[0]!
  })()
  const promoSales = salesRecords.filter(
    (s) => s.barcode === promo.barcode && s.date >= promo.startDate && s.date <= promo.endDate
  )
  const baseSales = salesRecords.filter(
    (s) => s.barcode === promo.barcode && s.date >= baselineStart && s.date < promo.startDate
  )
  const promoDailyAvg = promoSales.reduce((s, r) => s + r.qtySold, 0) / promoDays
  const baseDailyAvg  = baseSales.reduce((s, r) => s + r.qtySold, 0) / 30
  const liftPct = baseDailyAvg > 0
    ? Math.round(((promoDailyAvg - baseDailyAvg) / baseDailyAvg) * 100)
    : promoDailyAvg > 0 ? 100 : 0
  return { promoDailyAvg, baseDailyAvg, liftPct }
}

// ─── Sub-nav types ────────────────────────────────────────────────────────────

type SubNav = 'stock' | 'performance' | 'promotions'

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color }: {
  label: string; value: string | number; sub?: string; color?: string
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3 flex flex-col gap-0.5">
      <p className="text-[11px] text-gray-500 font-medium uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold ${color ?? 'text-gray-900'}`}>{value}</p>
      {sub && <p className="text-[11px] text-gray-400">{sub}</p>}
    </div>
  )
}

// ─── Stock Sub-View ────────────────────────────────────────────────────────────

type StockSort = 'name' | 'qoh' | 'status' | 'daysOfStock'
type LiquorCatFilter = 'all' | 'spirits' | 'wine' | 'beer' | 'cider' | 'rtd' | 'non_alc'

function StockView() {
  const [catFilter, setCatFilter] = useState<LiquorCatFilter>('all')
  const [sortBy, setSortBy] = useState<StockSort>('name')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [editState, setEditState] = useState<Record<string, string>>({})

  const data = useLiveQuery(async () => {
    const [products, snapshots, promotions, salesRecords] = await Promise.all([
      db.products.filter((p) => p.active !== false && p.department === 'liquor').toArray(),
      db.stockSnapshots.toArray(),
      db.promotions.toArray(),
      db.salesRecords.toArray(),
    ])
    const today = new Date().toISOString().split('T')[0]!
    const latestQoh = getLatestQoh(snapshots)
    const activePromoIds = new Set(
      promotions.filter((pr) => pr.startDate <= today && pr.endDate >= today).map((pr) => pr.productId)
    )
    const cutoff30 = getDaysAgoDateString(30)
    const recentSalesBarcodes = new Set(
      salesRecords.filter((s) => s.date >= cutoff30).map((s) => s.barcode)
    )
    return { products, snapshots, latestQoh, activePromoIds, recentSalesBarcodes }
  }, [])

  const kpis = useMemo(() => {
    if (!data) return null
    const { products, snapshots, latestQoh, activePromoIds, recentSalesBarcodes } = data
    const value = stockValue(products, snapshots)
    const lowCount = products.filter(
      (p) => (latestQoh.get(p.id!) ?? 0) < p.minStockLevel
    ).length
    const deadCount = products.filter(
      (p) => !recentSalesBarcodes.has(p.barcode)
    ).length
    return { value, lowCount, activePromos: activePromoIds.size, deadCount }
  }, [data])

  const sorted = useMemo(() => {
    if (!data) return []
    const { products, latestQoh } = data
    const filtered = catFilter === 'all'
      ? products
      : products.filter((p) => p.category === catFilter)
    return [...filtered].sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name)
      if (sortBy === 'qoh') return (latestQoh.get(b.id!) ?? 0) - (latestQoh.get(a.id!) ?? 0)
      if (sortBy === 'status') {
        const order = { low: 0, over: 1, good: 2, unknown: 3 }
        const sa = stockStatus(latestQoh.get(a.id!) ?? null, a.minStockLevel, a.maxStockLevel)
        const sb = stockStatus(latestQoh.get(b.id!) ?? null, b.minStockLevel, b.maxStockLevel)
        return (order[sa] ?? 3) - (order[sb] ?? 3)
      }
      if (sortBy === 'daysOfStock') {
        const qohA = latestQoh.get(a.id!) ?? 0
        const qohB = latestQoh.get(b.id!) ?? 0
        return qohA - qohB
      }
      return 0
    })
  }, [data, catFilter, sortBy])

  if (!data) return <div className="p-4 text-sm text-gray-400">Loading…</div>

  return (
    <div>
      {/* KPI strip */}
      {kpis && (
        <div className="grid grid-cols-4 gap-2 p-3">
          <KpiCard label="Stock Value" value={`$${round2(kpis.value).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`} />
          <KpiCard label="Low Stock" value={kpis.lowCount} color={kpis.lowCount > 0 ? 'text-red-600' : 'text-gray-900'} />
          <KpiCard label="Promos" value={kpis.activePromos} color="text-amber-600" />
          <KpiCard label="Dead Stock" value={kpis.deadCount} color={kpis.deadCount > 0 ? 'text-amber-600' : 'text-gray-900'} />
        </div>
      )}

      {/* Category filter */}
      <div className="flex gap-1.5 px-3 pb-2 overflow-x-auto">
        {(['all', 'beer', 'wine', 'spirits', 'cider', 'rtd', 'non_alc'] as const).map((c) => (
          <button key={c} onClick={() => setCatFilter(c)}
            className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium shrink-0 transition-colors ${
              catFilter === c ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}>
            {c === 'all' ? 'All' : CATEGORY_LABELS[c] ?? c}
          </button>
        ))}
      </div>

      {/* Sort */}
      <div className="flex gap-1.5 px-3 pb-2 overflow-x-auto">
        <span className="text-[11px] text-gray-500 font-medium shrink-0 self-center">Sort:</span>
        {(['name', 'qoh', 'status', 'daysOfStock'] as const).map((s) => (
          <button key={s} onClick={() => setSortBy(s)}
            className={`px-2 py-0.5 rounded text-[11px] shrink-0 transition-colors ${
              sortBy === s ? 'bg-gray-700 text-white' : 'bg-gray-100 text-gray-600'
            }`}>
            {s === 'daysOfStock' ? 'Days' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* Product list */}
      <div className="divide-y divide-gray-100">
        {sorted.map((p) => {
          const qoh = data.latestQoh.get(p.id!) ?? null
          const status = stockStatus(qoh, p.minStockLevel, p.maxStockLevel)
          const isPromo = data.activePromoIds.has(p.id!)
          const isExpanded = expandedId === p.id
          const pct = p.maxStockLevel && p.maxStockLevel > 0
            ? Math.min(100, ((qoh ?? 0) / p.maxStockLevel) * 100)
            : p.minStockLevel > 0 ? Math.min(100, ((qoh ?? 0) / (p.minStockLevel * 2)) * 100) : 0
          const gaugeColor = status === 'low' ? 'bg-red-400' : status === 'over' ? 'bg-amber-400' : 'bg-green-400'

          const handleExpand = () => {
            if (isExpanded) {
              setExpandedId(null)
            } else {
              setExpandedId(p.id!)
              setEditState({
                minStockLevel: String(p.minStockLevel),
                maxStockLevel: String(p.maxStockLevel ?? ''),
                sellPrice: String(p.sellPrice),
                abv: String(p.abv ?? ''),
                bottleSize: String(p.bottleSize ?? ''),
                notes: p.notes ?? '',
              })
            }
          }

          const handleSave = async () => {
            setSaving(true)
            try {
              await db.products.update(p.id!, {
                minStockLevel: Number(editState.minStockLevel) || 0,
                maxStockLevel: editState.maxStockLevel ? Number(editState.maxStockLevel) : undefined,
                sellPrice: Number(editState.sellPrice) || 0,
                abv: editState.abv ? Number(editState.abv) : undefined,
                bottleSize: editState.bottleSize ? Number(editState.bottleSize) : undefined,
                notes: editState.notes || undefined,
                updatedAt: new Date(),
              })
              setExpandedId(null)
            } finally {
              setSaving(false)
            }
          }

          return (
            <div key={p.id}>
              <button
                className="w-full text-left px-3 py-2.5 flex items-start gap-2 active:bg-gray-50"
                onClick={handleExpand}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-medium text-gray-900 truncate">{p.name}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${CATEGORY_COLORS[p.category] ?? 'bg-gray-100 text-gray-600'}`}>
                      {CATEGORY_LABELS[p.category] ?? p.category}
                    </span>
                    {isPromo && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-amber-100 text-amber-700">PROMO</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-gray-500">QOH {qoh !== null ? qoh : '—'}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_CHIP[status]}`}>
                      {STATUS_LABEL[status]}
                    </span>
                    {p.abv && <span className="text-[11px] text-gray-400">{p.abv}% ABV</span>}
                    {p.bottleSize && <span className="text-[11px] text-gray-400">{p.bottleSize}ml</span>}
                  </div>
                  {(p.minStockLevel > 0 || p.maxStockLevel) && (
                    <div className="mt-1 h-1 bg-gray-200 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${gaugeColor}`} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
                {isExpanded ? <ChevronUp size={14} className="text-gray-400 shrink-0 mt-0.5" /> : <ChevronDown size={14} className="text-gray-400 shrink-0 mt-0.5" />}
              </button>

              {isExpanded && (
                <div className="px-3 pb-3 bg-gray-50 border-t border-gray-100">
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    {[
                      { key: 'minStockLevel', label: 'Min Stock', placeholder: '0' },
                      { key: 'maxStockLevel', label: 'Max Stock', placeholder: 'optional' },
                      { key: 'sellPrice', label: 'Sell Price ($)', placeholder: '0.00' },
                      { key: 'abv', label: 'ABV %', placeholder: 'e.g. 4.5' },
                      { key: 'bottleSize', label: 'Bottle Size (ml)', placeholder: 'e.g. 700' },
                    ].map(({ key, label, placeholder }) => (
                      <div key={key} className="flex flex-col gap-0.5">
                        <label className="text-[11px] text-gray-500 font-medium">{label}</label>
                        <input
                          type="number"
                          min="0"
                          step={key === 'abv' || key === 'sellPrice' ? '0.1' : '1'}
                          placeholder={placeholder}
                          value={editState[key] ?? ''}
                          onChange={(e) => setEditState((s) => ({ ...s, [key]: e.target.value }))}
                          className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
                        />
                      </div>
                    ))}
                    <div className="col-span-2 flex flex-col gap-0.5">
                      <label className="text-[11px] text-gray-500 font-medium">Notes</label>
                      <input
                        type="text"
                        placeholder="Staff notes…"
                        value={editState.notes ?? ''}
                        onChange={(e) => setEditState((s) => ({ ...s, notes: e.target.value }))}
                        className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3">
                    <button onClick={handleSave} disabled={saving}
                      className="flex-1 bg-blue-600 text-white text-sm font-medium py-1.5 rounded disabled:opacity-50">
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button onClick={() => setExpandedId(null)}
                      className="px-3 py-1.5 text-sm text-gray-500">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}

        {sorted.length === 0 && (
          <div className="p-8 text-center text-gray-400 text-sm">
            No liquor products found — import a Smart Retail Item Maintenance file with department mode set to Liquor.
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Performance Sub-View ─────────────────────────────────────────────────────

type PerfSort = 'name' | 'qoh' | 'daysOfStock' | 'velocity' | 'trend' | 'gmroi' | 'abc'

const ABC_COLORS: Record<string, string> = {
  A: 'bg-green-100 text-green-800',
  B: 'bg-blue-100 text-blue-800',
  C: 'bg-yellow-100 text-yellow-800',
  D: 'bg-gray-100 text-gray-500',
}

function PerformanceView() {
  const [sortBy, setSortBy] = useState<PerfSort>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const data = useLiveQuery(async () => {
    const [products, salesRecords, snapshots, invoiceLines, invoiceRecords] = await Promise.all([
      db.products.filter((p) => p.active !== false && p.department === 'liquor').toArray(),
      db.salesRecords.toArray(),
      db.stockSnapshots.toArray(),
      db.invoiceLines.toArray(),
      db.invoiceRecords.toArray(),
    ])
    const invoiceIds = new Set(
      invoiceRecords.filter((r) => r.documentType === 'invoice').map((r) => r.id!)
    )
    const latestQoh = getLatestQoh(snapshots)
    const abcMap = classifyABC(products, salesRecords)
    const totalStockValue = stockValue(products, snapshots)
    const filteredInvoiceLines = invoiceLines.filter((l) => invoiceIds.has(l.invoiceRecordId))
    const performances = products.map((p) => ({
      product: p,
      qoh: latestQoh.get(p.id!) ?? null,
      perf: computePerformance(p, {
        salesRecords, snapshots,
        invoiceLines: filteredInvoiceLines,
        abcClass: abcMap.get(p.id!) ?? 'D',
      }),
    }))
    return { performances, totalStockValue }
  }, [])

  const sorted = useMemo(() => {
    if (!data) return []
    const rows = [...data.performances]
    rows.sort((a, b) => {
      let diff = 0
      if (sortBy === 'name')        diff = a.product.name.localeCompare(b.product.name)
      else if (sortBy === 'qoh')    diff = (a.qoh ?? 0) - (b.qoh ?? 0)
      else if (sortBy === 'daysOfStock') diff = a.perf.daysOfStock - b.perf.daysOfStock
      else if (sortBy === 'velocity')   diff = a.perf.avgDailySales - b.perf.avgDailySales
      else if (sortBy === 'trend')      diff = a.perf.velocityTrend - b.perf.velocityTrend
      else if (sortBy === 'gmroi')      diff = a.perf.gmroi - b.perf.gmroi
      else if (sortBy === 'abc') {
        const order = { A: 0, B: 1, C: 2, D: 3 }
        diff = (order[a.perf.abcClass] ?? 3) - (order[b.perf.abcClass] ?? 3)
      }
      return sortDir === 'asc' ? diff : -diff
    })
    return rows
  }, [data, sortBy, sortDir])

  const kpis = useMemo(() => {
    if (!data) return null
    const { performances, totalStockValue } = data
    const withGmroi = performances.filter((r) => r.perf.gmroi > 0)
    const avgGmroi = withGmroi.length > 0
      ? withGmroi.reduce((s, r) => s + r.perf.gmroi, 0) / withGmroi.length
      : 0
    const withDays = performances.filter((r) => r.perf.daysOfStock > 0 && r.perf.daysOfStock < 999)
    const avgDays = withDays.length > 0
      ? withDays.reduce((s, r) => s + r.perf.daysOfStock, 0) / withDays.length
      : 0
    const deadCount = performances.filter((r) => r.perf.abcClass === 'D').length
    const abcDist = { A: 0, B: 0, C: 0, D: 0 }
    for (const r of performances) abcDist[r.perf.abcClass]++
    return { totalStockValue, avgGmroi, avgDays, deadCount, abcDist }
  }, [data])

  const handleSort = (col: PerfSort) => {
    if (sortBy === col) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    else { setSortBy(col); setSortDir('asc') }
  }

  if (!data) return <div className="p-4 text-sm text-gray-400">Loading…</div>

  return (
    <div>
      {kpis && (
        <div className="grid grid-cols-2 gap-2 p-3">
          <KpiCard label="Stock Value" value={`$${round2(kpis.totalStockValue).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`} />
          <KpiCard label="Avg GMROI" value={kpis.avgGmroi.toFixed(2)} sub="higher = better" />
          <KpiCard label="Avg Days Stock" value={kpis.avgDays > 0 ? kpis.avgDays.toFixed(1) : '—'} />
          <KpiCard label="Dead Stock" value={kpis.deadCount} color={kpis.deadCount > 0 ? 'text-amber-600' : 'text-gray-900'} />
        </div>
      )}

      {/* ABC distribution */}
      {kpis && (
        <div className="mx-3 mb-3 flex gap-1 h-2 rounded overflow-hidden">
          {(['A', 'B', 'C', 'D'] as const).map((cls) => {
            const total = data.performances.length || 1
            const pct = (kpis.abcDist[cls] / total) * 100
            const colors = { A: 'bg-green-500', B: 'bg-blue-500', C: 'bg-yellow-500', D: 'bg-gray-300' }
            return <div key={cls} className={colors[cls]} style={{ width: `${pct}%` }} title={`${cls}: ${kpis.abcDist[cls]}`} />
          })}
        </div>
      )}

      {/* Sort buttons */}
      <div className="flex gap-1.5 px-3 pb-2 overflow-x-auto">
        <span className="text-[11px] text-gray-500 font-medium shrink-0 self-center">Sort:</span>
        {(['name', 'qoh', 'daysOfStock', 'velocity', 'trend', 'gmroi', 'abc'] as const).map((s) => (
          <button key={s} onClick={() => handleSort(s)}
            className={`px-2 py-0.5 rounded text-[11px] shrink-0 transition-colors flex items-center gap-0.5 ${
              sortBy === s ? 'bg-gray-700 text-white' : 'bg-gray-100 text-gray-600'
            }`}>
            {s === 'daysOfStock' ? 'Days' : s === 'velocity' ? 'Vel.' : s.charAt(0).toUpperCase() + s.slice(1)}
            {sortBy === s && <span>{sortDir === 'asc' ? '↑' : '↓'}</span>}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="divide-y divide-gray-100">
        {sorted.map(({ product: p, qoh, perf }) => (
          <div key={p.id} className="px-3 py-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-sm font-medium text-gray-900 truncate">{p.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${ABC_COLORS[perf.abcClass]}`}>
                    {perf.abcClass}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap text-xs text-gray-500">
                  <span>QOH {qoh !== null ? qoh : '—'}</span>
                  <span>·</span>
                  <span>{perf.daysOfStock < 999 && perf.daysOfStock > 0 ? `${perf.daysOfStock}d stock` : '—'}</span>
                  <span>·</span>
                  <span>vel {perf.avgDailySales.toFixed(2)}/d</span>
                  {perf.velocityTrend !== 0 && (
                    <>
                      <span>·</span>
                      <span className={perf.velocityTrend > 0 ? 'text-green-600' : 'text-red-500'}>
                        {perf.velocityTrend > 0 ? '+' : ''}{perf.velocityTrend}%
                      </span>
                    </>
                  )}
                  {perf.gmroi > 0 && (
                    <>
                      <span>·</span>
                      <span>GMROI {perf.gmroi.toFixed(2)}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}

        {sorted.length === 0 && (
          <div className="p-8 text-center text-gray-400 text-sm">No liquor products found.</div>
        )}
      </div>
    </div>
  )
}

// ─── Promotions Sub-View ──────────────────────────────────────────────────────

interface PromoForm {
  productId: string
  startDate: string
  endDate: string
  promoPrice: string
  promoType: 'price_reduction' | 'multibuy' | 'special'
  multibuyQty: string
  multibuyPrice: string
  notes: string
}

const EMPTY_FORM: PromoForm = {
  productId: '',
  startDate: '',
  endDate: '',
  promoPrice: '',
  promoType: 'price_reduction',
  multibuyQty: '',
  multibuyPrice: '',
  notes: '',
}

const PROMO_TYPE_LABEL: Record<string, string> = {
  price_reduction: 'Price Drop',
  multibuy: 'Multibuy',
  special: 'Special',
}

const PROMO_TYPE_COLORS: Record<string, string> = {
  price_reduction: 'bg-red-100 text-red-700',
  multibuy: 'bg-blue-100 text-blue-700',
  special: 'bg-purple-100 text-purple-700',
}

function PromotionsView() {
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<PromoForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const data = useLiveQuery(async () => {
    const [promotions, products, salesRecords] = await Promise.all([
      db.promotions.orderBy('startDate').reverse().toArray(),
      db.products.filter((p) => p.department === 'liquor' && p.active !== false).toArray(),
      db.salesRecords.toArray(),
    ])
    return { promotions, products, salesRecords }
  }, [])

  const segments = useMemo(() => {
    if (!data) return { active: [], upcoming: [], history: [] }
    const today = new Date().toISOString().split('T')[0]!
    const active   = data.promotions.filter((p) => p.startDate <= today && p.endDate >= today)
    const upcoming = data.promotions.filter((p) => p.startDate > today)
    const history  = data.promotions.filter((p) => p.endDate < today)
    return { active, upcoming, history }
  }, [data])

  const selectedProduct = data?.products.find((p) => p.id === Number(form.productId))

  async function handleSave() {
    if (!selectedProduct || !form.startDate || !form.endDate || !form.promoPrice) return
    setSaving(true)
    try {
      await db.promotions.add({
        productId: selectedProduct.id!,
        productName: selectedProduct.name,
        barcode: selectedProduct.barcode,
        startDate: form.startDate,
        endDate: form.endDate,
        promoPrice: Number(form.promoPrice),
        normalPrice: selectedProduct.sellPrice,
        promoType: form.promoType,
        multibuyQty: form.multibuyQty ? Number(form.multibuyQty) : undefined,
        multibuyPrice: form.multibuyPrice ? Number(form.multibuyPrice) : undefined,
        notes: form.notes || undefined,
        createdAt: new Date(),
      })
      setForm(EMPTY_FORM)
      setShowForm(false)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(promo: Promotion) {
    if (!window.confirm(`Delete promo for "${promo.productName}"?`)) return
    await db.promotions.delete(promo.id!)
  }

  const renderPromoCard = (promo: Promotion, isHistory = false) => {
    const discount = promo.normalPrice > 0
      ? Math.round(((promo.normalPrice - promo.promoPrice) / promo.normalPrice) * 100)
      : 0
    const lift = isHistory && data
      ? computePromoLift(promo, data.salesRecords)
      : null

    return (
      <div key={promo.id} className="border border-gray-200 rounded-xl p-3 space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-medium text-gray-900 truncate">{promo.productName}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${PROMO_TYPE_COLORS[promo.promoType]}`}>
                {PROMO_TYPE_LABEL[promo.promoType]}
              </span>
            </div>
            {promo.promoType === 'price_reduction' && (
              <p className="text-xs text-gray-600 mt-0.5">
                ${promo.promoPrice} <span className="text-gray-400">(was ${promo.normalPrice})</span> · {discount}% off
              </p>
            )}
            {promo.promoType === 'multibuy' && promo.multibuyQty && (
              <p className="text-xs text-gray-600 mt-0.5">
                {promo.multibuyQty} for ${promo.multibuyPrice}
              </p>
            )}
            {promo.promoType === 'special' && (
              <p className="text-xs text-gray-600 mt-0.5">${promo.promoPrice}</p>
            )}
            <p className="text-[11px] text-gray-400 mt-0.5">{promo.startDate} – {promo.endDate}</p>
            {promo.notes && <p className="text-[11px] text-gray-500 italic">{promo.notes}</p>}
            {lift !== null && (
              <p className={`text-xs font-medium mt-0.5 flex items-center gap-1 ${lift.liftPct >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                <TrendingUp size={11} />
                Lift: {lift.liftPct >= 0 ? '+' : ''}{lift.liftPct}% vs 30d baseline
              </p>
            )}
          </div>
          <button onClick={() => handleDelete(promo)}
            className="text-[11px] text-gray-400 hover:text-red-500 shrink-0 mt-0.5">
            ✕
          </button>
        </div>
      </div>
    )
  }

  if (!data) return <div className="p-4 text-sm text-gray-400">Loading…</div>

  return (
    <div className="p-3 space-y-4">
      {/* Add button */}
      <button
        onClick={() => setShowForm((v) => !v)}
        className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white text-sm font-medium py-2 rounded-lg"
      >
        <Tag size={15} />
        {showForm ? 'Cancel' : 'Add Promotion'}
      </button>

      {/* Add form */}
      {showForm && (
        <div className="border border-blue-200 rounded-xl p-3 bg-blue-50 space-y-2">
          <p className="text-sm font-semibold text-blue-900">New Promotion</p>

          <div className="flex flex-col gap-0.5">
            <label className="text-[11px] text-gray-600 font-medium">Product</label>
            <select
              value={form.productId}
              onChange={(e) => setForm((s) => ({ ...s, productId: e.target.value }))}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
            >
              <option value="">Select product…</option>
              {data.products.map((p) => (
                <option key={p.id} value={String(p.id)}>{p.name}</option>
              ))}
            </select>
          </div>

          {selectedProduct && (
            <p className="text-[11px] text-gray-500">Normal price: ${selectedProduct.sellPrice.toFixed(2)}</p>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-0.5">
              <label className="text-[11px] text-gray-600 font-medium">Start Date</label>
              <input type="date" value={form.startDate}
                onChange={(e) => setForm((s) => ({ ...s, startDate: e.target.value }))}
                className="border border-gray-300 rounded px-2 py-1 text-sm" />
            </div>
            <div className="flex flex-col gap-0.5">
              <label className="text-[11px] text-gray-600 font-medium">End Date</label>
              <input type="date" value={form.endDate}
                onChange={(e) => setForm((s) => ({ ...s, endDate: e.target.value }))}
                className="border border-gray-300 rounded px-2 py-1 text-sm" />
            </div>
          </div>

          <div className="flex flex-col gap-0.5">
            <label className="text-[11px] text-gray-600 font-medium">Promo Type</label>
            <select value={form.promoType}
              onChange={(e) => setForm((s) => ({ ...s, promoType: e.target.value as PromoForm['promoType'] }))}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white">
              <option value="price_reduction">Price Reduction</option>
              <option value="multibuy">Multibuy</option>
              <option value="special">Special</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-0.5">
              <label className="text-[11px] text-gray-600 font-medium">Promo Price ($)</label>
              <input type="number" min="0" step="0.01" value={form.promoPrice}
                onChange={(e) => setForm((s) => ({ ...s, promoPrice: e.target.value }))}
                className="border border-gray-300 rounded px-2 py-1 text-sm" />
            </div>
            {form.promoType === 'multibuy' && (
              <>
                <div className="flex flex-col gap-0.5">
                  <label className="text-[11px] text-gray-600 font-medium">Buy Qty</label>
                  <input type="number" min="1" value={form.multibuyQty}
                    onChange={(e) => setForm((s) => ({ ...s, multibuyQty: e.target.value }))}
                    className="border border-gray-300 rounded px-2 py-1 text-sm" />
                </div>
                <div className="flex flex-col gap-0.5">
                  <label className="text-[11px] text-gray-600 font-medium">For Price ($)</label>
                  <input type="number" min="0" step="0.01" value={form.multibuyPrice}
                    onChange={(e) => setForm((s) => ({ ...s, multibuyPrice: e.target.value }))}
                    className="border border-gray-300 rounded px-2 py-1 text-sm" />
                </div>
              </>
            )}
          </div>

          <div className="flex flex-col gap-0.5">
            <label className="text-[11px] text-gray-600 font-medium">Notes (optional)</label>
            <input type="text" placeholder="e.g. Weekend special"
              value={form.notes}
              onChange={(e) => setForm((s) => ({ ...s, notes: e.target.value }))}
              className="border border-gray-300 rounded px-2 py-1 text-sm" />
          </div>

          <button
            onClick={handleSave}
            disabled={saving || !form.productId || !form.startDate || !form.endDate || !form.promoPrice}
            className="w-full bg-green-600 text-white text-sm font-medium py-1.5 rounded-lg disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save Promotion'}
          </button>
        </div>
      )}

      {/* Active promos */}
      {segments.active.length > 0 && (
        <section>
          <p className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-2">Active ({segments.active.length})</p>
          <div className="space-y-2">{segments.active.map((p) => renderPromoCard(p))}</div>
        </section>
      )}

      {/* Upcoming promos */}
      {segments.upcoming.length > 0 && (
        <section>
          <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-2">Upcoming ({segments.upcoming.length})</p>
          <div className="space-y-2">{segments.upcoming.map((p) => renderPromoCard(p))}</div>
        </section>
      )}

      {/* History */}
      {segments.history.length > 0 && (
        <section>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">History ({segments.history.length})</p>
          <div className="space-y-2">{segments.history.map((p) => renderPromoCard(p, true))}</div>
        </section>
      )}

      {data.promotions.length === 0 && !showForm && (
        <div className="p-8 text-center">
          <AlertTriangle size={28} className="mx-auto text-gray-200 mb-2" />
          <p className="text-sm text-gray-400">No promotions yet — tap Add Promotion to create one.</p>
        </div>
      )}
    </div>
  )
}

// ─── Main LiquorTab ────────────────────────────────────────────────────────────

export default function LiquorTab() {
  const [subNav, setSubNav] = useState<SubNav>('stock')

  return (
    <div className="flex flex-col h-full">
      {/* Sub-nav */}
      <div className="flex border-b border-gray-200 bg-white shrink-0">
        {([
          { id: 'stock',       label: 'Stock',       icon: <Package size={14} /> },
          { id: 'performance', label: 'Performance', icon: <TrendingUp size={14} /> },
          { id: 'promotions',  label: 'Promotions',  icon: <Tag size={14} /> },
        ] as const).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setSubNav(tab.id)}
            className={`flex-1 flex flex-col items-center py-2 gap-0.5 text-[11px] font-medium transition-colors ${
              subNav === tab.id
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        {subNav === 'stock'       && <StockView />}
        {subNav === 'performance' && <PerformanceView />}
        {subNav === 'promotions'  && <PromotionsView />}
      </div>
    </div>
  )
}
