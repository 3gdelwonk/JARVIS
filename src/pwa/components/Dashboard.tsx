/**
 * Dashboard.tsx — Session 9
 *
 * Sections:
 *  1. Next delivery countdown (DeliverySlots DB, falls back to Mon/Wed/Fri pattern)
 *  2. Quick action — "Build New Order"
 *  3. Reorder alerts — top 8 products needing urgent ordering
 *  4. Weekly spend chart — last 8 weeks (Recharts BarChart)
 *  5. Recent orders — last 5 with status badges
 */

import { useEffect, useRef, useState } from 'react'
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
  AlertTriangle,
  ArrowRight,
  Clipboard,
  Clock,
  Download,
  ImageOff,
  Package,
  ShoppingCart,
  TrendingUp,
  Upload,
  X,
} from 'lucide-react'
import { db } from '../lib/db'
import { exportAllData, downloadBackup, importAllData } from '../lib/dataExport'
import { generateForecasts, getSettings, type Forecast } from '../lib/forecastEngine'
import { analyzeHistory } from '../lib/historyAnalyzer'
import { AVG_DELIVERY_COST, nextDeliveryDate, friendlyError } from '../lib/constants'
import type { Order } from '../lib/types'

const STATUS_BADGE: Record<Order['status'], string> = {
  draft:     'bg-gray-100 text-gray-500',
  approved:  'bg-blue-100 text-blue-700',
  submitted: 'bg-purple-100 text-purple-700',
  delivered: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-600',
}

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

  if (diffDays === 0) return { label: 'Today', urgent: true }
  if (diffDays === 1) return { label: 'Tomorrow', urgent: true }
  return {
    label: targetDate.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short' }),
    urgent: false,
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
  const csv = buildWasteCsv(entries)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `waste-report-${new Date().toISOString().split('T')[0]}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Reorder alert row ────────────────────────────────────────────────────────

function AlertRow({ f, imageUrl }: { f: Forecast; imageUrl?: string }) {
  const isHot = f.daysUntilStockout !== null && f.daysUntilStockout <= 2

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 last:border-0">
      <div className="w-8 h-8 rounded-md overflow-hidden bg-gray-100 shrink-0 flex items-center justify-center">
        {imageUrl
          ? <img src={imageUrl} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          : <ImageOff size={12} className="text-gray-300" />
        }
      </div>
      <AlertTriangle
        size={13}
        className={isHot ? 'text-red-500 shrink-0' : 'text-amber-400 shrink-0'}
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-800 truncate">{f.productName}</p>
        <p className="text-[11px] text-gray-400">
          {f.currentStock !== null ? `${f.currentStock} in stock` : 'stock unknown'}
          {f.daysUntilStockout !== null && ` · ${f.daysUntilStockout}d left`}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className={`text-sm font-semibold ${isHot ? 'text-red-600' : 'text-blue-600'}`}>
          ×{f.suggestedQty}
        </p>
        <p className="text-[11px] text-gray-400">suggested</p>
      </div>
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
  onNavigateToImport: () => void
}

const LAST_BACKUP_KEY = 'milk-manager-last-backup'

function getLastBackupLabel(): string {
  const raw = localStorage.getItem(LAST_BACKUP_KEY)
  if (!raw) return 'Never backed up'
  const diff = Math.floor((Date.now() - new Date(raw).getTime()) / 86400000)
  if (diff === 0) return 'Backed up today'
  if (diff === 1) return 'Backed up yesterday'
  return `Last backup ${diff} days ago`
}

export default function Dashboard({ onNavigateToOrder, onNavigateToImport }: Props) {
  const [alerts, setAlerts] = useState<Forecast[]>([])
  const [weeklyData, setWeeklyData] = useState<{ week: string; spend: number }[]>([])
  const [totalSpend, setTotalSpend] = useState(0)
  const [loadingForecasts, setLoadingForecasts] = useState(true)
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [forecastError, setForecastError] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [backupStatus, setBackupStatus] = useState<string | null>(null)
  const [backupLabel, setBackupLabel] = useState(() => getLastBackupLabel())
  const [transferJson, setTransferJson] = useState<string | null>(null)
  const [hasCopied, setHasCopied] = useState(false)
  const [pasteMode, setPasteMode] = useState(false)
  const [pastedText, setPastedText] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const restoreInputRef = useRef<HTMLInputElement>(null)

  async function handleBackup() {
    try {
      setBackupStatus('Exporting…')
      const json = await exportAllData()
      const date = new Date().toISOString().slice(0, 10)
      const filename = `milk-manager-backup-${date}.json`
      const blob = new Blob([json], { type: 'application/json' })
      if (navigator.canShare?.({ files: [new File([blob], filename)] })) {
        await navigator.share({ files: [new File([blob], filename, { type: 'application/json' })], title: 'Milk Manager Backup' })
        localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString())
        setBackupLabel(getLastBackupLabel())
        setBackupStatus('Shared ✓')
      } else {
        downloadBackup(json)
        localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString())
        setBackupLabel(getLastBackupLabel())
        setBackupStatus('Downloaded ✓')
        setTransferJson(json)
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setBackupStatus(`Error: ${(e as Error).message}`)
      else setBackupStatus(null)
    }
  }

  async function handleRestoreFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      setBackupStatus('Restoring…')
      await importAllData(await file.text())
      setBackupStatus('Restore complete')
    } catch (err) {
      setBackupStatus(`Restore failed: ${(err as Error).message}`)
    }
    e.target.value = ''
  }

  async function handleCopyJson() {
    if (!transferJson) return
    await navigator.clipboard.writeText(transferJson)
    setHasCopied(true)
    setTimeout(() => setHasCopied(false), 2000)
  }

  async function handlePasteImport() {
    setPasteError(null)
    try {
      setBackupStatus('Restoring…')
      await importAllData(pastedText)
      setBackupStatus('Restore complete')
      setPasteMode(false)
      setPastedText('')
    } catch (err) {
      setPasteError(`Import failed: ${(err as Error).message}`)
      setBackupStatus(null)
    }
  }

  // Live queries
  const recentOrders = useLiveQuery(
    () => db.orders.orderBy('createdAt').reverse().limit(5).toArray(),
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
        .then((slots) => slots[0] ?? null),
    [],
  )

  // Async: forecast for reorder alerts
  useEffect(() => {
    let cancelled = false

    function runForecast() {
      cancelled = false
      setLoadingForecasts(true)
      setForecastError(null)
      generateForecasts(getSettings())
        .then((forecasts) => {
          if (cancelled) return
          const urgent = forecasts
            .filter((f) => f.suggestedQty > 0)
            .sort((a, b) => {
              const aDay = a.daysUntilStockout ?? 999
              const bDay = b.daysUntilStockout ?? 999
              if (aDay !== bDay) return aDay - bDay
              return b.suggestedQty - a.suggestedQty
            })
            .slice(0, 8)
          setAlerts(urgent)
        })
        .catch((e) => { if (!cancelled) setForecastError(friendlyError(e)) })
        .finally(() => { if (!cancelled) setLoadingForecasts(false) })
    }

    runForecast()
    // Re-run when the user saves new forecast settings from SettingsSheet
    window.addEventListener('forecast-settings-changed', runForecast)
    return () => {
      cancelled = true
      window.removeEventListener('forecast-settings-changed', runForecast)
    }
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

  // ── Next delivery display ──────────────────────────────────────────────────

  const slotDelivery = nextSlot ? new Date(nextSlot.deliveryDate) : null
  const deliveryDate = slotDelivery && isValidDate(slotDelivery)
    ? slotDelivery
    : nextDeliveryDate()

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

  const { label: deliveryLabel, urgent: deliveryUrgent } = formatCountdown(deliveryDate)

  const hoursToClose = Math.max(
    0,
    Math.round((cutoffDate.getTime() - Date.now()) / 3600000),
  )
  const cutoffPassed = cutoffDate.getTime() < Date.now()

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
  const weekWaste = (allWasteEntries ?? []).filter((w) => w.wastedDate >= weekStartStr)
  // Group by product name → total qty
  const wasteByProduct = new Map<string, { qty: number; reason: string }>()
  for (const w of weekWaste) {
    const prev = wasteByProduct.get(w.productName)
    wasteByProduct.set(w.productName, {
      qty: (prev?.qty ?? 0) + w.quantity,
      reason: w.reason,
    })
  }
  const wasteSorted = [...wasteByProduct.entries()].sort((a, b) => b[1].qty - a[1].qty)
  const totalWasteQty = weekWaste.reduce((s, w) => s + w.quantity, 0)

  return (
    <div className="flex-1 overflow-auto pb-4">

      {/* ── Next delivery card ─────────────────────────────────────────────── */}
      <div className={`mx-3 mt-3 rounded-xl p-4 ${deliveryUrgent ? 'bg-amber-50 border border-amber-100' : 'bg-blue-50 border border-blue-100'}`}>
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Next Delivery</p>
              <button onClick={onNavigateToImport} title="Import data files"
                className="p-0.5 rounded hover:bg-white/50 text-gray-400">
                <Upload size={12} />
              </button>
            </div>
            <p className={`text-xl font-bold mt-0.5 ${deliveryUrgent ? 'text-amber-700' : 'text-blue-700'}`}>
              {deliveryLabel}
            </p>
            {!cutoffPassed ? (
              <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                <Clock size={11} />
                Order cutoff in {hoursToClose}h
              </p>
            ) : (
              <p className="text-xs text-red-500 mt-1">Cutoff passed</p>
            )}
          </div>
          <div className={`p-2.5 rounded-xl ${deliveryUrgent ? 'bg-amber-100' : 'bg-blue-100'}`}>
            <Package size={22} className={deliveryUrgent ? 'text-amber-600' : 'text-blue-600'} />
          </div>
        </div>

        {/* Quick action */}
        <button
          onClick={onNavigateToOrder}
          className={`mt-3 w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold ${
            deliveryUrgent ? 'bg-amber-500 text-white' : 'bg-blue-600 text-white'
          }`}
        >
          <ShoppingCart size={15} />
          Build Next Order
          <ArrowRight size={14} />
        </button>
      </div>

      {/* ── Reorder alerts ─────────────────────────────────────────────────── */}
      <div className="mx-3 mt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Needs Ordering
          </p>
          {!loadingForecasts && (
            <span className="text-[11px] text-gray-400">{alerts.length} products</span>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          {loadingForecasts ? (
            <div className="py-6 flex items-center justify-center">
              <p className="text-xs text-gray-400">Loading forecast…</p>
            </div>
          ) : forecastError ? (
            <div className="py-5 text-center px-4">
              <p className="text-xs text-red-500">{forecastError}</p>
            </div>
          ) : alerts.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-green-600 font-medium">All stocked up</p>
              <p className="text-xs text-gray-400 mt-0.5">No reorders needed right now</p>
            </div>
          ) : (
            alerts.map((f) => <AlertRow key={f.productId} f={f} imageUrl={productImageMap?.get(f.productId)} />)
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

        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          {wasteSorted.length === 0 ? (
            <div className="py-5 text-center">
              <p className="text-xs text-gray-400">No waste logged this week</p>
            </div>
          ) : (
            wasteSorted.map(([name, { qty, reason }]) => (
              <div key={name} className="flex items-center justify-between px-3 py-2 border-b border-gray-100 last:border-0">
                <p className="text-sm text-gray-800 truncate flex-1">{name}</p>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                    reason === 'expired' ? 'bg-red-100 text-red-700'
                    : reason === 'damaged' ? 'bg-amber-100 text-amber-700'
                    : 'bg-gray-100 text-gray-600'
                  }`}>{reason}</span>
                  <span className="text-sm font-semibold text-gray-700">×{qty}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Backup & Transfer ──────────────────────────────────────────────── */}
      <div className="mx-3 mt-4">
        <div className="bg-white rounded-xl border border-gray-100 p-3">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-sm font-semibold text-gray-800">Backup & Transfer</p>
              <p className={`text-[11px] mt-0.5 ${backupLabel.startsWith('Never') ? 'text-amber-500' : 'text-gray-400'}`}>
                {backupLabel}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleBackup}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-blue-600 text-white text-sm font-medium rounded-xl"
            >
              <Upload size={14} />
              Export & Share
            </button>
            <button
              onClick={() => { setPasteMode(false); restoreInputRef.current?.click() }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 border text-sm rounded-xl ${!pasteMode ? 'border-gray-300 bg-gray-50 text-gray-800 font-medium' : 'border-gray-200 text-gray-700'}`}
            >
              <Download size={14} />
              File
            </button>
            <button
              onClick={() => setPasteMode((m) => !m)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 border text-sm rounded-xl ${pasteMode ? 'border-blue-400 bg-blue-50 text-blue-700 font-medium' : 'border-gray-200 text-gray-700'}`}
            >
              <Clipboard size={14} />
              Paste
            </button>
            <input ref={restoreInputRef} type="file" accept=".json" className="hidden" onChange={handleRestoreFile} />
          </div>
          {pasteMode && (
            <div className="mt-2 space-y-1.5">
              <textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                placeholder="Paste JSON backup here…"
                className="w-full h-24 text-[11px] font-mono border border-gray-200 rounded-lg p-2 resize-none text-gray-700"
              />
              {pasteError && <p className="text-[11px] text-red-500">{pasteError}</p>}
              <button
                onClick={handlePasteImport}
                disabled={!pastedText.trim()}
                className="w-full py-2 bg-blue-600 text-white text-sm font-medium rounded-xl disabled:opacity-40"
              >
                Import
              </button>
            </div>
          )}
          {backupStatus && (
            <div className="mt-2 flex items-center gap-2">
              <p className="text-[11px] text-gray-500">{backupStatus}</p>
              {backupStatus === 'Restore complete' && (
                <button onClick={() => window.location.reload()}
                  className="text-[11px] bg-blue-600 text-white px-2 py-0.5 rounded">
                  Reload App
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Transfer to Phone modal ────────────────────────────────────────── */}
      {transferJson && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setTransferJson(null)}>
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <p className="text-base font-semibold text-gray-900">Transfer to Phone</p>
              <button onClick={() => setTransferJson(null)} className="p-1 rounded-full hover:bg-gray-100 text-gray-500">
                <X size={18} />
              </button>
            </div>

            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Option A — Copy &amp; Paste</p>
            <textarea
              readOnly
              value={transferJson}
              className="w-full h-16 text-[10px] font-mono border border-gray-200 rounded-lg p-2 resize-none text-gray-500 bg-gray-50"
            />
            <button
              onClick={handleCopyJson}
              className="mt-1.5 w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl"
            >
              <Clipboard size={15} />
              {hasCopied ? 'Copied ✓' : 'Copy JSON to Clipboard'}
            </button>
            <p className="text-[11px] text-gray-400 mt-1.5">
              Paste into iMessage, WhatsApp, or email to yourself. Then on your phone: open the app → Backup → Paste.
            </p>

            <div className="border-t border-gray-100 mt-3 pt-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Option B — File</p>
              <p className="text-[11px] text-gray-400">
                File already downloaded. Save it to iCloud Drive or Google Drive, then on your phone: open the app → Backup → Restore → pick the file.
              </p>
            </div>
          </div>
        </div>
      )}

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
                    ${order.totalCostEstimate.toFixed(2)} est.
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
