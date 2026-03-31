/**
 * Dashboard.tsx — Session 9
 *
 * Sections:
 *  1. Next delivery countdown (DeliverySlots DB, falls back to Mon/Wed/Fri pattern)
 *  2. Quick action — "Build New Order"
 *  3. Top sellers — past week's sales ranked by quantity sold
 *  4. Weekly spend chart — last 8 weeks (Recharts BarChart)
 *  5. Recent orders — last 5 with status badges
 */

import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import {
  ArrowRight,
  Clock,
  Download,
  ImageOff,
  Minus,
  Package,
  Plus,
  RefreshCw,
  ShoppingCart,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react'
import { db } from '../lib/db'
// forecast import removed — top sellers section uses sales data directly
import { analyzeHistory } from '../lib/historyAnalyzer'
import { AVG_DELIVERY_COST, DELIVERY_DAYS, nextDeliveryDate, friendlyError, STATUS_BADGE } from '../lib/constants'
import { getExtensionStatus, triggerScheduleRefresh, fetchCloudSchedule } from '../lib/extensionSync'
import { downloadFile } from '../lib/dataExport'

// ─── Next delivery helpers ─────────────────────────────────────────────────────

// L6 — outside component so it is not recreated on every render
function isValidDate(d: Date): boolean {
  return !isNaN(d.getTime())
}

function formatCountdown(targetDate: Date): { label: string; urgent: boolean } {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  // H1 — use ceil so a delivery that is partially through "today" still shows as 1d
  const diffDays = Math.ceil(
    (targetDate.getTime() - today.getTime()) / 86400000,
  )

  return {
    label: targetDate.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' }),
    urgent: diffDays <= 1,
  }
}

// ─── Waste CSV export helper ──────────────────────────────────────────────────

function buildWasteCsv(entries: import('../lib/types').WasteEntry[]): string {
  const rows = entries
    .sort((a, b) => a.wastedDate.localeCompare(b.wastedDate))
    .map((w) => `${w.wastedDate},"${w.productName}",${w.quantity},${w.reason},"${w.notes ?? ''}"`)
  return ['Date,Product,Quantity,Reason,Notes', ...rows].join('\n')
}

function downloadWasteCsv(entries: import('../lib/types').WasteEntry[]) {
  downloadFile(buildWasteCsv(entries), `waste-report-${new Date().toISOString().split('T')[0]}.csv`)
}

// ─── Top seller row + detail ─────────────────────────────────────────────────

interface TopSeller {
  productId: number
  productName: string
  totalQty: number
  totalRevenue: number
  prevWeekQty: number
  prevWeekRevenue: number
  dailyBreakdown: { date: string; qty: number; revenue: number }[]
}

function TopSellerRow({ rank, s, imageUrl, expanded, onToggle }: {
  rank: number; s: TopSeller; imageUrl?: string; expanded: boolean; onToggle: () => void
}) {
  const qtyChange = s.prevWeekQty > 0
    ? Math.round(((s.totalQty - s.prevWeekQty) / s.prevWeekQty) * 100)
    : null

  return (
    <div className="border-b border-gray-100 last:border-0">
      <button onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2 active:bg-gray-50">
        <span className="text-xs font-bold text-gray-300 w-5 text-center shrink-0">{rank}</span>
        <div className="relative w-8 h-8 rounded-md overflow-hidden bg-gray-100 shrink-0 flex items-center justify-center">
          <ImageOff size={12} className="text-gray-300" />
          {imageUrl && (
            <img src={imageUrl} alt="" className="absolute inset-0 w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          )}
        </div>
        <div className="flex-1 min-w-0 text-left">
          <p className="text-sm text-gray-800 truncate">{s.productName}</p>
          <p className="text-[11px] text-gray-400">${s.totalRevenue.toFixed(2)} revenue</p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-semibold text-gray-800">{Math.round(s.totalQty)}</p>
          <p className="text-[11px] text-gray-400">sold</p>
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 bg-gray-50 space-y-2">
          {/* Week comparison */}
          <div className="flex gap-2">
            <div className="flex-1 bg-white rounded-lg p-2 border border-gray-100">
              <p className="text-[10px] text-gray-400 uppercase">Last Week</p>
              <p className="text-sm font-semibold text-gray-900">{Math.round(s.totalQty)} units</p>
              <p className="text-[11px] text-gray-500">${s.totalRevenue.toFixed(2)}</p>
            </div>
            <div className="flex-1 bg-white rounded-lg p-2 border border-gray-100">
              <p className="text-[10px] text-gray-400 uppercase">Week Before</p>
              <p className="text-sm font-semibold text-gray-900">{Math.round(s.prevWeekQty)} units</p>
              <p className="text-[11px] text-gray-500">${s.prevWeekRevenue.toFixed(2)}</p>
            </div>
            {qtyChange !== null && (
              <div className="flex items-center shrink-0">
                <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
                  qtyChange > 0 ? 'bg-green-100 text-green-700' :
                  qtyChange < 0 ? 'bg-red-100 text-red-700' :
                  'bg-gray-100 text-gray-600'
                }`}>
                  {qtyChange > 0 ? '+' : ''}{qtyChange}%
                </span>
              </div>
            )}
          </div>

          {/* Daily breakdown */}
          {s.dailyBreakdown.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-100 overflow-hidden">
              <p className="text-[10px] text-gray-400 uppercase px-2 pt-1.5">Daily Breakdown</p>
              {s.dailyBreakdown.map((d) => (
                <div key={d.date} className="flex items-center justify-between px-2 py-1 text-xs">
                  <span className="text-gray-600">
                    {new Date(d.date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}
                  </span>
                  <span className="text-gray-800 font-medium">{Math.round(d.qty)} units · ${d.revenue.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Custom chart tooltip ─────────────────────────────────────────────────────

function SpendTooltip({ active, payload, label }: {
  active?: boolean
  payload?: { value: number }[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 shadow-sm text-xs">
      <p className="text-gray-400">{label}</p>
      <p className="font-semibold text-gray-900">${payload[0].value.toFixed(0)}</p>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  onNavigateToOrder: () => void
}

export default function Dashboard({ onNavigateToOrder }: Props) {
  const [topSellers, setTopSellers] = useState<TopSeller[]>([])
  const [weeklyData, setWeeklyData] = useState<{ week: string; spend: number }[]>([])
  const [totalSpend, setTotalSpend] = useState(0)
  const [loadingSales, setLoadingSales] = useState(true)
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [extStatus, setExtStatus] = useState<{ connected: boolean; lactalisLoggedIn: boolean } | null>(null)
  const [refreshingSchedule, setRefreshingSchedule] = useState(false)
  const [showWasteEditModal, setShowWasteEditModal] = useState(false)
  const [expandedSeller, setExpandedSeller] = useState<number | null>(null)
  // Live queries
  const recentOrders = useLiveQuery(
    () => db.orders.toArray().then(all =>
      all.sort((a, b) => {
        const da = new Date(a.createdAt).getTime() || 0
        const db2 = new Date(b.createdAt).getTime() || 0
        return db2 - da
      }).slice(0, 5)
    ),
    [],
  )

  const productImageMap = useLiveQuery(
    () => db.products.toArray().then((ps) => new Map(ps.map((p) => [p.id!, p.imageUrl ?? '']))),
    [],
  )

  const allWasteEntries = useLiveQuery(() => db.wasteLog.toArray(), [])

  const nextSlot = useLiveQuery(
    () =>
      db.deliverySlots
        .where('status')
        .equals('upcoming')
        .sortBy('deliveryDate')
        .then((slots) => {
          const now = Date.now()
          return slots.find((s) => {
            const co = new Date(`${s.orderCutoffDate}T${s.orderCutoffTime}`)
            if (!isNaN(co.getTime()) && co.getTime() < now) return false
            if (isNaN(co.getTime())) {
              const [y, m, d] = s.deliveryDate.split('-').map(Number)
              const fb = new Date(y!, m! - 1, d!)
              fb.setDate(fb.getDate() - 1)
              fb.setHours(17, 0, 0, 0)
              if (fb.getTime() < now) return false
            }
            return true
          }) ?? null
        }),
    [],
  )

  // Async: top sellers from last week's sales data, compared to week before
  useEffect(() => {
    let cancelled = false
    setLoadingSales(true)

    async function loadTopSellers() {
      try {
        const now = new Date()
        const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        const todayStr = fmt(now)
        const lastWeekStart = new Date(now)
        lastWeekStart.setDate(lastWeekStart.getDate() - 7)
        const prevWeekStart = new Date(now)
        prevWeekStart.setDate(prevWeekStart.getDate() - 14)
        const lastWeekStr = fmt(lastWeekStart)
        const prevWeekStr = fmt(prevWeekStart)

        const allSales = await db.salesRecords.toArray()
        // Last week = 7 days ago to yesterday
        const lastWeek = allSales.filter((s) => s.date >= lastWeekStr && s.date < todayStr)
        // Week before = 14 days ago to 7 days ago
        const weekBefore = allSales.filter((s) => s.date >= prevWeekStr && s.date < lastWeekStr)

        const products = await db.products.toArray()
        const productMap = new Map(products.map((p) => [p.id!, p]))

        // Last week aggregation (primary ranking)
        const map = new Map<number, {
          productName: string; totalQty: number; totalRevenue: number
          prevWeekQty: number; prevWeekRevenue: number
          dailyMap: Map<string, { qty: number; revenue: number }>
        }>()

        for (const s of lastWeek) {
          const pid = s.productId
          if (!pid) continue
          const existing = map.get(pid)
          if (existing) {
            existing.totalQty += s.qtySold
            existing.totalRevenue += s.salesValue
            const day = existing.dailyMap.get(s.date)
            if (day) { day.qty += s.qtySold; day.revenue += s.salesValue }
            else existing.dailyMap.set(s.date, { qty: s.qtySold, revenue: s.salesValue })
          } else {
            const prod = productMap.get(pid)
            const dailyMap = new Map<string, { qty: number; revenue: number }>()
            dailyMap.set(s.date, { qty: s.qtySold, revenue: s.salesValue })
            map.set(pid, {
              productName: prod?.name ?? s.barcode,
              totalQty: s.qtySold, totalRevenue: s.salesValue,
              prevWeekQty: 0, prevWeekRevenue: 0, dailyMap,
            })
          }
        }

        // Week before aggregation (for comparison)
        for (const s of weekBefore) {
          const pid = s.productId
          if (!pid) continue
          const existing = map.get(pid)
          if (existing) {
            existing.prevWeekQty += s.qtySold
            existing.prevWeekRevenue += s.salesValue
          }
        }

        const sorted: TopSeller[] = Array.from(map.entries())
          .map(([productId, data]) => ({
            productId,
            productName: data.productName,
            totalQty: data.totalQty,
            totalRevenue: data.totalRevenue,
            prevWeekQty: data.prevWeekQty,
            prevWeekRevenue: data.prevWeekRevenue,
            dailyBreakdown: Array.from(data.dailyMap.entries())
              .map(([date, d]) => ({ date, qty: d.qty, revenue: d.revenue }))
              .sort((a, b) => a.date.localeCompare(b.date)),
          }))
          .sort((a, b) => b.totalQty - a.totalQty)
          .slice(0, 10)

        if (!cancelled) setTopSellers(sorted)
      } catch (e) {
        console.warn('[Dashboard] Failed to load top sellers:', e)
      } finally {
        if (!cancelled) setLoadingSales(false)
      }
    }

    loadTopSellers()
    return () => { cancelled = true }
  }, [])

  // Async: weekly spend history
  useEffect(() => {
    let cancelled = false
    setLoadingHistory(true)
    setHistoryError(null)
    analyzeHistory()
      .then(({ overall }) => {
        if (cancelled) return
        setTotalSpend(overall.totalSpend ?? 0)
        const last8 = (overall.weeklySpend ?? []).slice(-8).map((w) => ({
          week: new Date(w.week).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }),
          spend: w.spend,
        }))
        setWeeklyData(last8)
      })
      .catch((e) => { if (!cancelled) setHistoryError(friendlyError(e)) })
      .finally(() => { if (!cancelled) setLoadingHistory(false) })
    return () => { cancelled = true }
  }, [])

  // Async: extension status check on mount + cloud schedule fallback
  useEffect(() => {
    getExtensionStatus().then((status) => {
      setExtStatus(status)
      // If extension not connected locally, try cloud schedule
      if (!status.connected) {
        fetchCloudSchedule()
      }
    })
  }, [])

  async function handleRefreshSchedule() {
    setRefreshingSchedule(true)

    if (extStatus?.connected) {
      triggerScheduleRefresh()
      setTimeout(async () => {
        setExtStatus(await getExtensionStatus())
        setRefreshingSchedule(false)
      }, 3000)
    } else {
      // Try cloud sync when extension not connected (mobile / no extension)
      await fetchCloudSchedule()
      setRefreshingSchedule(false)
    }
  }

  // ── Next delivery display ──────────────────────────────────────────────────

  const slotDelivery = nextSlot ? new Date(nextSlot.deliveryDate) : null
  let deliveryDate = slotDelivery && isValidDate(slotDelivery)
    ? slotDelivery
    : nextDeliveryDate()

  // If using fallback and today's cutoff (17:00 day before) has passed, advance
  if (!nextSlot) {
    const fbCutoff = new Date(deliveryDate)
    fbCutoff.setDate(fbCutoff.getDate() - 1)
    fbCutoff.setHours(17, 0, 0, 0)
    if (fbCutoff.getTime() < Date.now()) {
      const today = new Date()
      const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
      for (let offset = 1; offset <= 7; offset++) {
        const candidate = new Date(base)
        candidate.setDate(base.getDate() + offset)
        if (DELIVERY_DAYS.includes(candidate.getDay())) {
          deliveryDate = candidate
          break
        }
      }
    }
  }

  const slotCutoff = nextSlot
    ? new Date(`${nextSlot.orderCutoffDate}T${nextSlot.orderCutoffTime}`)
    : null
  const cutoffDate = slotCutoff && isValidDate(slotCutoff)
    ? slotCutoff
    : (() => {
        // Cutoff = day before delivery at 17:00
        const d = new Date(deliveryDate)
        d.setDate(d.getDate() - 1)
        d.setHours(17, 0, 0, 0)
        return d
      })()

  const { label: deliveryLabel } = formatCountdown(deliveryDate)

  const hoursToClose = Math.max(
    0,
    Math.round((cutoffDate.getTime() - Date.now()) / 3600000),
  )

  // ── Weekly spend avg (last 8 weeks) ───────────────────────────────────────

  const chartAvg =
    weeklyData.length > 0
      ? weeklyData.reduce((s, w) => s + w.spend, 0) / weeklyData.length
      : AVG_DELIVERY_COST * 3

  // ── Weekly waste ─────────────────────────────────────────────────────────
  const weekStartStr = (() => {
    const d = new Date()
    d.setDate(d.getDate() - 6)
    return d.toISOString().split('T')[0]
  })()
  const weekWaste = (allWasteEntries ?? [])
    .filter((w) => w.wastedDate >= weekStartStr)
    .sort((a, b) => b.wastedDate.localeCompare(a.wastedDate))
  // Group by productId (or productName fallback) for the summary card rows
  const wasteGroupMap = new Map<string, { productName: string; productId: number; qty: number; reason: string }>()
  for (const w of weekWaste) {
    const key = w.productId ? `id:${w.productId}` : `name:${w.productName}`
    const prev = wasteGroupMap.get(key)
    wasteGroupMap.set(key, {
      productName: w.productName,
      productId: w.productId,
      qty: (prev?.qty ?? 0) + w.quantity,
      reason: w.reason,
    })
  }
  const wasteSorted = [...wasteGroupMap.values()].sort((a, b) => b.qty - a.qty)
  const totalWasteQty = weekWaste.reduce((s, w) => s + w.quantity, 0)

  return (
    <div className="flex-1 overflow-auto pb-4">

      {/* ── Next delivery card ─────────────────────────────────────────────── */}
      <div className="mx-3 mt-3 rounded-xl p-4 bg-blue-50 border border-blue-100">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Next Delivery</p>
            </div>
            <p className="text-xl font-bold mt-0.5 text-blue-700">
              {deliveryLabel}
            </p>
            <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
              <Clock size={11} />
              Order cutoff in {hoursToClose}h
            </p>
          </div>
          <div className="p-2.5 rounded-xl bg-blue-100">
            <Package size={22} className="text-blue-600" />
          </div>
        </div>

        {/* Cloud sync / Extension status */}
        <div className="flex items-center justify-between mt-2">
          {extStatus !== null && extStatus.connected ? (
            <div className="flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 rounded-full ${
                extStatus.lactalisLoggedIn ? 'bg-green-500' : 'bg-amber-400'
              }`} />
              <span className="text-[11px] text-gray-500">
                {extStatus.lactalisLoggedIn ? 'Lactalis live' : 'Extension connected'}
              </span>
            </div>
          ) : extStatus !== null ? (
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-gray-300" />
              <span className="text-[11px] text-gray-400">
                Cloud mode (no extension)
              </span>
            </div>
          ) : (
            <div />
          )}
          <button
            onClick={handleRefreshSchedule}
            disabled={refreshingSchedule}
            className="flex items-center gap-1 text-[11px] text-blue-600 disabled:text-gray-400"
          >
            <RefreshCw size={10} className={refreshingSchedule ? 'animate-spin' : ''} />
            {extStatus?.connected ? 'Refresh Data' : 'Sync from Cloud'}
          </button>
        </div>

        {/* Quick action */}
        <button
          onClick={onNavigateToOrder}
          className="mt-3 w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 text-white"
        >
          <ShoppingCart size={15} />
          Build Next Order
          <ArrowRight size={14} />
        </button>
      </div>

      {/* ── Top sellers this week ────────────────────────────────────────── */}
      <div className="mx-3 mt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Top Sellers Last Week
          </p>
          {!loadingSales && topSellers.length > 0 && (
            <span className="text-[11px] text-gray-400">{topSellers.length} products</span>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          {loadingSales ? (
            <div className="py-6 flex items-center justify-center">
              <p className="text-xs text-gray-400">Loading sales data…</p>
            </div>
          ) : topSellers.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-gray-500 font-medium">No sales data yet</p>
              <p className="text-xs text-gray-400 mt-0.5">Import POS data from JARVISmart</p>
            </div>
          ) : (
            topSellers.map((s, i) => (
              <TopSellerRow
                key={s.productId}
                rank={i + 1}
                s={s}
                imageUrl={productImageMap?.get(s.productId)}
                expanded={expandedSeller === s.productId}
                onToggle={() => setExpandedSeller(expandedSeller === s.productId ? null : s.productId)}
              />
            ))
          )}
        </div>
      </div>

      {/* ── Weekly spend chart ─────────────────────────────────────────────── */}
      <div className="mx-3 mt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Weekly Spend
          </p>
          {!loadingHistory && totalSpend > 0 && (
            <span className="text-[11px] text-gray-400">
              ${totalSpend.toFixed(0)} total
            </span>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-3">
          {loadingHistory ? (
            <div className="h-32 flex items-center justify-center">
              <p className="text-xs text-gray-400">Loading history…</p>
            </div>
          ) : historyError ? (
            <div className="h-32 flex items-center justify-center px-4">
              <p className="text-xs text-red-500 text-center">{historyError}</p>
            </div>
          ) : weeklyData.length === 0 ? (
            <div className="h-32 flex flex-col items-center justify-center gap-1">
              <TrendingUp size={24} className="text-gray-200" />
              <p className="text-xs text-gray-400">Import invoices to see spend trends</p>
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={weeklyData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <XAxis
                    dataKey="week"
                    tick={{ fontSize: 10, fill: '#9ca3af' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: '#9ca3af' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `$${v}`}
                  />
                  <Tooltip content={<SpendTooltip />} cursor={{ fill: '#f3f4f6' }} />
                  <ReferenceLine
                    y={chartAvg}
                    stroke="#d1d5db"
                    strokeDasharray="3 3"
                    label={{ value: 'avg', position: 'insideTopRight', fontSize: 10, fill: '#9ca3af' }}
                  />
                  <Bar dataKey="spend" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={32} />
                </BarChart>
              </ResponsiveContainer>
              <p className="text-[10px] text-gray-400 text-center mt-1">
                Weekly avg ${Math.round(chartAvg)} · last {weeklyData.length} weeks
              </p>
            </>
          )}
        </div>
      </div>

      {/* ── Weekly waste ───────────────────────────────────────────────────── */}
      <div className="mx-3 mt-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              This Week's Waste
            </p>
            {totalWasteQty > 0 && (
              <span className="text-[11px] text-gray-400">{totalWasteQty} units</span>
            )}
          </div>
          <button
            onClick={() => allWasteEntries && downloadWasteCsv(allWasteEntries)}
            disabled={!allWasteEntries || allWasteEntries.length === 0}
            className="flex items-center gap-1 text-[11px] text-blue-600 disabled:text-gray-300"
            title="Export all waste as CSV"
          >
            <Download size={11} />
            Export Report
          </button>
        </div>

        {/* Waste edit modal */}
        {showWasteEditModal && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-end justify-center">
            <div className="bg-white rounded-t-2xl w-full max-w-[480px] flex flex-col max-h-[80vh] shadow-xl">
              <div className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
                <p className="text-base font-semibold text-gray-900">Edit This Week's Waste</p>
                <button onClick={() => setShowWasteEditModal(false)} className="p-1 text-gray-400 hover:text-gray-600">
                  <X size={18} />
                </button>
              </div>
              <div className="border-t border-gray-100 mx-4 shrink-0" />
              <div className="overflow-y-auto flex-1 px-4 py-2 flex flex-col gap-2">
                {weekWaste.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-6">No waste logged this week</p>
                )}
                {weekWaste.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-3 bg-gray-50 rounded-xl px-3 py-2.5">
                    <div className="relative w-9 h-9 rounded-lg bg-gray-100 overflow-hidden flex items-center justify-center shrink-0">
                      <ImageOff size={12} className="text-gray-300" />
                      {entry.productId && productImageMap?.get(entry.productId) && (
                        <img
                          src={productImageMap.get(entry.productId)}
                          alt=""
                          className="absolute inset-0 w-full h-full object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                        />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-800 truncate">{entry.productName}</p>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                        entry.reason === 'expired' ? 'bg-red-100 text-red-700'
                        : entry.reason === 'damaged' ? 'bg-amber-100 text-amber-700'
                        : 'bg-gray-100 text-gray-600'
                      }`}>{entry.reason}</span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => db.wasteLog.update(entry.id!, { quantity: Math.max(1, entry.quantity - 1) })}
                        className="w-7 h-7 rounded-full bg-white border border-gray-200 flex items-center justify-center text-gray-600"
                      >
                        <Minus size={12} />
                      </button>
                      <span className="w-7 text-center text-sm font-semibold text-gray-900">{entry.quantity}</span>
                      <button
                        onClick={() => db.wasteLog.update(entry.id!, { quantity: entry.quantity + 1 })}
                        className="w-7 h-7 rounded-full bg-white border border-gray-200 flex items-center justify-center text-gray-600"
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                    <button
                      onClick={() => db.wasteLog.delete(entry.id!)}
                      className="p-1 text-gray-300 hover:text-red-400 shrink-0"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="px-4 pb-5 pt-3 shrink-0 border-t border-gray-100">
                <button
                  onClick={() => setShowWasteEditModal(false)}
                  className="w-full py-3 bg-gray-900 text-white text-sm font-semibold rounded-xl"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Grouped summary card — tap to edit */}
        <button
          onClick={() => weekWaste.length > 0 && setShowWasteEditModal(true)}
          className="w-full text-left bg-white rounded-xl border border-gray-100 overflow-hidden"
        >
          {wasteSorted.length === 0 ? (
            <div className="py-5 text-center">
              <p className="text-xs text-gray-400">No waste logged this week</p>
            </div>
          ) : (
            wasteSorted.map((group) => (
              <div key={`${group.productId}-${group.productName}`} className="flex items-center gap-2.5 px-3 py-2 border-b border-gray-100 last:border-0">
                <div className="relative w-8 h-8 rounded-md bg-gray-100 overflow-hidden flex items-center justify-center shrink-0">
                  <ImageOff size={11} className="text-gray-300" />
                  {group.productId > 0 && productImageMap?.get(group.productId) && (
                    <img
                      src={productImageMap.get(group.productId)}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                  )}
                </div>
                <p className="text-sm text-gray-800 truncate flex-1">{group.productName}</p>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                    group.reason === 'expired' ? 'bg-red-100 text-red-700'
                    : group.reason === 'damaged' ? 'bg-amber-100 text-amber-700'
                    : 'bg-gray-100 text-gray-600'
                  }`}>{group.reason}</span>
                  <span className="text-sm font-semibold text-gray-700">×{group.qty}</span>
                </div>
              </div>
            ))
          )}
        </button>
      </div>

      {/* ── Recent orders ──────────────────────────────────────────────────── */}
      <div className="mx-3 mt-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Recent Orders
        </p>

        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          {!recentOrders || recentOrders.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-xs text-gray-400">No orders yet</p>
            </div>
          ) : (
            recentOrders.map((order) => (
              <div
                key={order.id}
                className="flex items-center justify-between px-3 py-2.5 border-b border-gray-100 last:border-0"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {new Date(order.createdAt).toLocaleDateString('en-AU', {
                      weekday: 'short', day: 'numeric', month: 'short',
                    })}
                  </p>
                  <p className="text-[11px] text-gray-400">
                    ${(order.totalCostEstimate ?? 0).toFixed(2)} est.
                  </p>
                </div>
                <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[order.status]}`}>
                  {order.status}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

    </div>
  )
}
