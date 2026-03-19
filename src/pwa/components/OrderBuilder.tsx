/**
 * OrderBuilder.tsx — Sessions 7 + 8
 *
 * Three-view container:
 *  'history' — past orders list + "Build New Order"
 *  'build'   — forecast editor (urgency-grouped, qty steppers)
 *  'export'  — CSV / paste export for the approved order
 *
 * Export formats (per CLAUDE.md verified portal behaviour):
 *  CSV:   Item Number,Quantity\n19100,18\n...
 *  Paste: 19100,18;40248,10;18532,6
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  Download,
  ExternalLink,
  FileWarning,
  Globe,
  ImageOff,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShoppingCart,
  Trash2,
  X,
} from 'lucide-react'
import { generateForecasts, getSettings, type Forecast } from '../lib/forecastEngine'
import { db } from '../lib/db'
import { AVG_DELIVERY_COST, nextDeliveryDate, friendlyError } from '../lib/constants'
import { submitOrderViaCloud, pollOrderStatus, checkRelayStatus } from '../lib/extensionSync'
import type { Order, OrderLine } from '../lib/types'

const STATUS_BADGE: Record<Order['status'], string> = {
  draft:      'bg-gray-100 text-gray-600',
  approved:   'bg-blue-100 text-blue-700',
  submitted:  'bg-purple-100 text-purple-700',
  delivered:  'bg-green-100 text-green-700',
  cancelled:  'bg-red-100 text-red-600',
}

// ─── Urgency helpers ──────────────────────────────────────────────────────────

type Urgency = 'critical' | 'order' | 'ok'

function getUrgency(f: Forecast): Urgency {
  if (f.daysUntilStockout !== null && f.daysUntilStockout <= 2) return 'critical'
  if (f.suggestedQty > 0) return 'order'
  return 'ok'
}

const URGENCY_ORDER: Urgency[] = ['critical', 'order', 'ok']

const URGENCY_LABEL: Record<Urgency, string> = {
  critical: 'Critical — Order Now',
  order: 'Needs Ordering',
  ok: 'Well Stocked',
}

const URGENCY_HEADER: Record<Urgency, string> = {
  critical: 'bg-red-50 text-red-700 border-red-100',
  order: 'bg-blue-50 text-blue-700 border-blue-100',
  ok: 'bg-green-50 text-green-700 border-green-100',
}

const URGENCY_PILL: Record<Urgency, string> = {
  critical: 'bg-red-100 text-red-700',
  order: 'bg-blue-100 text-blue-700',
  ok: 'bg-green-100 text-green-700',
}

const CONF_COLOR: Record<Forecast['confidence'], string> = {
  high: 'text-green-600',
  medium: 'text-amber-500',
  low: 'text-gray-400',
}

// ─── Export helpers ───────────────────────────────────────────────────────────

function buildPasteString(lines: OrderLine[]): string {
  return lines
    .filter((l) => l.approvedQty > 0)
    .map((l) => `${l.itemNumber},${l.approvedQty}`)
    .join(';')
}

function buildCsvString(lines: OrderLine[]): string {
  const rows = lines
    .filter((l) => l.approvedQty > 0)
    .map((l) => `${l.itemNumber},${l.approvedQty}`)
  return ['Item Number,Quantity', ...rows].join('\n')
}

function downloadCsv(csvContent: string, filename: string) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const EXTENSION_STORAGE_KEY = 'milk-manager-pending-order'

function sendToExtension(order: Order, lines: OrderLine[]) {
  const payload = {
    orderId: order.id,
    date: order.deliveryDate,
    approvedAt: order.approvedAt?.toISOString(),
    lines: lines
      .filter((l) => l.approvedQty > 0)
      .map((l) => ({ itemNumber: l.itemNumber, qty: l.approvedQty })),
  }
  localStorage.setItem(EXTENSION_STORAGE_KEY, JSON.stringify(payload))
  // Notify pwa-bridge.js content script (same-tab — storage event doesn't fire)
  window.dispatchEvent(new CustomEvent('milk-manager-order-sent'))
}

// ─── ForecastRow ──────────────────────────────────────────────────────────────

interface RowProps {
  forecast: Forecast
  qty: number
  onChange: (id: number, qty: number) => void
  imageUrl?: string
}

const ForecastRow = memo(function ForecastRow({ forecast: f, qty, onChange, imageUrl }: RowProps) {
  const stockLabel = f.currentStock !== null ? `${f.currentStock} in stock` : 'stock unknown'
  const stockoutLabel =
    f.daysUntilStockout !== null
      ? f.daysUntilStockout <= 0 ? 'Stocked out' : `${f.daysUntilStockout}d left`
      : null
  const costLine = qty > 0 ? `$${(qty * f.lactalisCostPrice).toFixed(2)}` : null

  return (
    <div className="px-3 py-2.5 border-b border-gray-100 last:border-0">
      <div className="flex items-start justify-between gap-2">
        <div className="relative w-8 h-8 rounded-md overflow-hidden bg-gray-100 shrink-0 flex items-center justify-center mt-0.5">
          <ImageOff size={12} className="text-gray-300" />
          {imageUrl && (
            <img src={imageUrl} alt="" className="absolute inset-0 w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 leading-snug truncate">{f.productName}</p>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className="text-[11px] text-gray-400">#{f.itemNumber}</span>
            {f.unitsPerOrder > 1 && (
              <>
                <span className="text-[11px] text-gray-400">·</span>
                <span className="text-[11px] text-gray-400">×{f.unitsPerOrder} {f.orderUnit}</span>
              </>
            )}
            <span className="text-[11px] text-gray-400">·</span>
            <span className="text-[11px] text-gray-500">{stockLabel}</span>
            {stockoutLabel && (
              <>
                <span className="text-[11px] text-gray-400">·</span>
                <span className={`text-[11px] font-medium ${
                  f.daysUntilStockout !== null && f.daysUntilStockout <= 2 ? 'text-red-600' : 'text-amber-600'
                }`}>{stockoutLabel}</span>
              </>
            )}
            {f.avgDailySales > 0 && (
              <>
                <span className="text-[11px] text-gray-400">·</span>
                <span className="text-[11px] text-gray-400">{f.avgDailySales.toFixed(1)}/day</span>
              </>
            )}
            {costLine && (
              <>
                <span className="text-[11px] text-gray-400">·</span>
                <span className="text-[11px] text-blue-600 font-medium">{costLine}</span>
              </>
            )}
            <span className={`text-[10px] font-medium ${CONF_COLOR[f.confidence]}`}
              title={`${f.dataPoints} data points`}>
              {f.confidence}
            </span>
          </div>
        </div>

        <div className="flex flex-col items-center gap-0 shrink-0">
          <div className="flex items-center gap-1">
          <button onPointerDown={(e) => e.preventDefault()}
            onClick={() => onChange(f.productId, Math.max(0, qty - 1))}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 active:bg-gray-200 text-gray-600"
            aria-label="Decrease">
            <Minus size={14} />
          </button>

          <input
            type="number"
            min={0}
            value={qty === 0 ? '' : qty}
            placeholder="0"
            onChange={(e) => onChange(f.productId, Math.max(0, parseInt(e.target.value, 10) || 0))}
            onFocus={(e) => e.target.select()}
            className={`w-12 text-center text-sm font-semibold border rounded py-0.5 outline-none focus:border-blue-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${
              qty === 0
                ? 'text-gray-400 border-gray-200 bg-gray-50'
                : qty > f.suggestedQty * 1.5
                  ? 'text-amber-600 border-amber-200 bg-amber-50'
                  : 'text-gray-900 border-blue-200 bg-blue-50'
            }`}
          />

          <button onPointerDown={(e) => e.preventDefault()}
            onClick={() => onChange(f.productId, qty === 0 ? f.suggestedQty : qty + 1)}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 active:bg-gray-200 text-gray-600"
            aria-label="Increase">
            <Plus size={14} />
          </button>
          </div>
          {qty === 0 && f.suggestedQty > 0 && (
            <p className="text-[10px] text-blue-400 text-center leading-none mt-0.5">+{f.suggestedQty}</p>
          )}
        </div>
      </div>
    </div>
  )
})

// ─── History view (enhanced) ──────────────────────────────────────────────────

interface HistoryViewProps {
  onBuild: () => void
  onViewOrder: (id: number) => void
}

type HistoryFilter = 'all' | 'submitted' | 'delivered' | 'draft'

function HistoryView({ onBuild, onViewOrder }: HistoryViewProps) {
  const [filter, setFilter] = useState<HistoryFilter>('all')
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const orders = useLiveQuery(
    () => db.orders.orderBy('createdAt').reverse().toArray(),
    [],
  )

  // Preload line counts for all orders
  const lineCounts = useLiveQuery(async () => {
    if (!orders) return new Map<number, number>()
    const counts = new Map<number, number>()
    for (const o of orders) {
      const c = await db.orderLines.where('orderId').equals(o.id!).count()
      counts.set(o.id!, c)
    }
    return counts
  }, [orders])

  // Expanded order lines
  const expandedLines = useLiveQuery(
    () => expandedId ? db.orderLines.where('orderId').equals(expandedId).toArray() : [],
    [expandedId],
  )

  const filtered = orders?.filter((o) => {
    if (filter === 'all') return true
    if (filter === 'submitted') return o.status === 'submitted' || o.status === 'approved'
    return o.status === filter
  })

  const FILTER_OPTS: { id: HistoryFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'submitted', label: 'Active' },
    { id: 'delivered', label: 'Delivered' },
    { id: 'draft', label: 'Draft' },
  ]

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-gray-200 bg-white shrink-0 space-y-2">
        <button
          onClick={onBuild}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-semibold py-2.5 rounded-xl"
        >
          <ShoppingCart size={16} />
          Build New Order
        </button>
        {/* Filter pills */}
        <div className="flex gap-1.5">
          {FILTER_OPTS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                filter === f.id
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-500'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {!filtered || filtered.length === 0 ? (
          <div className="p-8 text-center">
            <ShoppingCart size={32} className="mx-auto text-gray-200 mb-3" />
            <p className="text-sm text-gray-400">
              {filter === 'all' ? 'No orders yet' : `No ${filter} orders`}
            </p>
            <p className="text-xs text-gray-300 mt-1">Build your first order above</p>
          </div>
        ) : (
          filtered.map((order) => {
            const isExpanded = expandedId === order.id
            const itemCount = lineCounts?.get(order.id!) ?? 0
            const delivDate = order.deliveryDate
              ? new Date(order.deliveryDate + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })
              : null

            return (
              <div key={order.id} className="border-b border-gray-100">
                {/* Order card header */}
                <div className="px-3 py-3 flex items-start gap-3">
                  <button
                    onClick={() => onViewOrder(order.id!)}
                    className="flex-1 min-w-0 text-left active:bg-gray-50"
                  >
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="text-sm font-medium text-gray-900">
                        {order.lactalisOrderNumber
                          ? `#${order.lactalisOrderNumber}`
                          : new Date(order.createdAt).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}
                      </p>
                      {order.portalSource && (
                        <span className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600 font-medium">
                          <Globe size={8} /> Portal
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-gray-500">
                      {delivDate && <span>Delivery: {delivDate}</span>}
                      {delivDate && itemCount > 0 && <span>·</span>}
                      {itemCount > 0 && <span>{itemCount} items</span>}
                      {order.totalCostEstimate > 0 && (
                        <>
                          <span>·</span>
                          <span>${order.totalCostEstimate.toFixed(2)}</span>
                        </>
                      )}
                    </div>
                    {order.portalRefNumber && (
                      <p className="text-[10px] text-gray-400 mt-0.5">Ref: {order.portalRefNumber}</p>
                    )}
                    {order.portalStatus && order.portalStatus !== order.status && (
                      <p className="text-[10px] text-gray-400">Portal: {order.portalStatus}</p>
                    )}
                  </button>

                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[order.status]}`}>
                      {order.status}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : order.id!)}
                        className="p-1 rounded-full hover:bg-gray-100 text-gray-400"
                        aria-label="Toggle details"
                      >
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          if (!window.confirm('Delete this order?')) return
                          await db.orderLines.where('orderId').equals(order.id!).delete()
                          await db.orders.delete(order.id!)
                        }}
                        className="p-1 rounded-full hover:bg-red-50 text-gray-400 hover:text-red-500"
                        aria-label="Delete order"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expanded line items */}
                {isExpanded && (
                  <div className="px-3 pb-3">
                    {(!expandedLines || expandedLines.length === 0) ? (
                      <p className="text-[11px] text-gray-300 text-center py-2">No line items</p>
                    ) : (
                      <div className="bg-gray-50 rounded-lg overflow-hidden">
                        {expandedLines.filter((l) => l.approvedQty > 0).map((line) => (
                          <div key={line.id} className="flex items-center justify-between px-3 py-1.5 border-b border-gray-100 last:border-0">
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-gray-700 truncate">{line.productName}</p>
                              <p className="text-[10px] text-gray-400">#{line.itemNumber}</p>
                            </div>
                            <div className="text-right shrink-0 ml-2">
                              <p className="text-xs font-medium text-gray-800">x{line.approvedQty}</p>
                              <p className="text-[10px] text-gray-400">${line.lineTotal.toFixed(2)}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ─── Export view ──────────────────────────────────────────────────────────────

interface ExportViewProps {
  orderId: number
  onBack: () => void
  onReceive: () => void
}

function ExportView({ orderId, onBack, onReceive }: ExportViewProps) {
  const [copied, setCopied] = useState<'paste' | 'csv' | 'portal' | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [statusSaving, setStatusSaving] = useState(false)
  const [cloudStatus, setCloudStatus] = useState<'idle' | 'submitting' | 'waiting' | 'success' | 'error'>('idle')
  const [cloudMessage, setCloudMessage] = useState('')
  const cloudAbortedRef = useRef(false)
  const [relayOnline, setRelayOnline] = useState<boolean | null>(null) // null = checking

  // Check relay status on mount
  useEffect(() => {
    checkRelayStatus().then(({ online }) => setRelayOnline(online))
  }, [])

  const order = useLiveQuery(() => db.orders.get(orderId), [orderId])
  const lines = useLiveQuery(
    () => db.orderLines.where('orderId').equals(orderId).toArray(),
    [orderId],
  )

  if (!order || !lines) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw size={20} className="text-gray-300 animate-spin" />
      </div>
    )
  }

  const activeLines = lines.filter((l) => l.approvedQty > 0)
  const pasteStr = buildPasteString(lines)
  const csvStr = buildCsvString(lines)
  const linesTotalCost = Math.round(activeLines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100
  const totalCost = linesTotalCost > 0 ? linesTotalCost : order.totalCostEstimate
  const hasLines = activeLines.length > 0
  const dateStr = new Date(order.createdAt).toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long',
  })
  const filename = `lactalis-order-${order.deliveryDate}.csv`

  async function copyPaste() {
    await navigator.clipboard.writeText(pasteStr)
    setCopied('paste')
    setTimeout(() => setCopied(null), 2000)
  }

  async function copyCsv() {
    await navigator.clipboard.writeText(csvStr)
    setCopied('csv')
    setTimeout(() => setCopied(null), 2000)
  }

  function handleDownload() {
    downloadCsv(csvStr, filename)
  }

  function handleSubmitToLactalis() {
    sendToExtension(order as Order, lines as OrderLine[])
    window.dispatchEvent(new CustomEvent('milk-manager-submit-order'))
    setSubmitted(true)
    setTimeout(() => setSubmitted(false), 4000)
  }

  async function markSubmitted() {
    setStatusSaving(true)
    try {
      await db.orders.update(orderId, { status: 'submitted', submittedAt: new Date() })
    } finally {
      setStatusSaving(false)
    }
  }

  async function handleCopyAndOpenPortal() {
    await navigator.clipboard.writeText(pasteStr)
    window.open('https://mylactalis.com.au/customer/product/quick-add/', '_blank')
    setCopied('portal')
    setTimeout(() => setCopied(null), 4000)
  }

  function handleCancelCloud() {
    cloudAbortedRef.current = true
    setCloudStatus('idle')
    setCloudMessage('')
  }

  async function handleCloudSubmit() {
    if (!lines) return
    cloudAbortedRef.current = false
    setCloudStatus('submitting')
    setCloudMessage('Submitting to Worker...')

    try {
      const cloudLines = activeLines.map((l) => ({ itemNumber: l.itemNumber, qty: l.approvedQty }))
      const result = await submitOrderViaCloud(cloudLines)

      if (cloudAbortedRef.current) return

      if (result.success) {
        setCloudStatus('success')
        setCloudMessage('Submitted directly!')
        await db.orders.update(orderId, { status: 'submitted', submittedAt: new Date() })
        return
      }

      if (result.queued) {
        setCloudStatus('waiting')

        // Exponential backoff: 5s, 10s, 15s, 20s, 30s (cap)
        const BACKOFF = [5, 10, 15, 20, 30]
        const MAX_WAIT_MS = 3 * 60 * 1000 // 3 minutes
        let elapsed = 0
        let attempt = 0

        while (elapsed < MAX_WAIT_MS) {
          if (cloudAbortedRef.current) return
          const delaySec = BACKOFF[Math.min(attempt, BACKOFF.length - 1)]
          attempt++
          const maxAttempts = Math.ceil(MAX_WAIT_MS / (delaySec * 1000))
          setCloudMessage(`Checking... (attempt ${attempt}/${Math.min(attempt + maxAttempts - 1, 99)})`)

          await new Promise((r) => setTimeout(r, delaySec * 1000))
          elapsed += delaySec * 1000
          if (cloudAbortedRef.current) return

          const status = await pollOrderStatus()
          if (cloudAbortedRef.current) return
          if (!status) continue

          if (status.status === 'completed') {
            setCloudStatus('success')
            setCloudMessage(status.lactalisRef ? `Submitted! Ref: ${status.lactalisRef}` : 'Submitted!')
            await db.orders.update(orderId, {
              status: 'submitted',
              submittedAt: new Date(),
              lactalisOrderNumber: status.lactalisRef ?? undefined,
            })
            return
          }

          if (status.status === 'failed') {
            setCloudStatus('error')
            setCloudMessage(status.error || 'Extension failed to submit')
            return
          }
        }

        if (!cloudAbortedRef.current) {
          setCloudStatus('error')
          setCloudMessage('Timed out waiting for extension')
        }
      }
    } catch (e) {
      if (!cloudAbortedRef.current) {
        setCloudStatus('error')
        setCloudMessage(e instanceof Error ? e.message : 'Cloud submit failed')
      }
    }
  }

  const delivDateStr = order.deliveryDate
    ? new Date(order.deliveryDate + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    : null
  const createdStr = new Date(order.createdAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="flex flex-col h-full">
      {/* Back bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 bg-white shrink-0">
        <button onClick={onBack} className="p-1.5 -ml-1 text-gray-500" aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate">
            {order.lactalisOrderNumber ? `Order #${order.lactalisOrderNumber}` : dateStr}
          </p>
          <p className="text-[11px] text-gray-400">
            {activeLines.length} items · ${totalCost.toFixed(2)}
          </p>
        </div>
        <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0 ${STATUS_BADGE[order.status]}`}>
          {order.status}
        </span>
      </div>

      <div className="flex-1 overflow-auto">

        {/* Order summary card */}
        <div className="px-3 py-3 border-b border-gray-100 bg-gray-50">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {order.lactalisOrderNumber && (
              <>
                <span className="text-gray-400">Lactalis Order #</span>
                <span className="text-gray-800 font-medium">{order.lactalisOrderNumber}</span>
              </>
            )}
            {delivDateStr && (
              <>
                <span className="text-gray-400">Delivery Date</span>
                <span className="text-gray-800">{delivDateStr}</span>
              </>
            )}
            <span className="text-gray-400">Created</span>
            <span className="text-gray-800">{createdStr}</span>
            {order.submittedAt && (
              <>
                <span className="text-gray-400">Submitted</span>
                <span className="text-gray-800">{new Date(order.submittedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              </>
            )}
            <span className="text-gray-400">Status</span>
            <span className="text-gray-800 capitalize">{order.status}</span>
            {order.portalStatus && order.portalStatus !== order.status && (
              <>
                <span className="text-gray-400">Portal Status</span>
                <span className="text-gray-800">{order.portalStatus}</span>
              </>
            )}
            {order.portalRefNumber && (
              <>
                <span className="text-gray-400">Ref Number</span>
                <span className="text-gray-800">{order.portalRefNumber}</span>
              </>
            )}
            {order.invoiceNumber && (
              <>
                <span className="text-gray-400">Invoice #</span>
                <span className="text-gray-800">{order.invoiceNumber}</span>
              </>
            )}
            <span className="text-gray-400">Items</span>
            <span className="text-gray-800">{activeLines.length} products</span>
            <span className="text-gray-400">Est. Total</span>
            <span className="text-gray-800 font-semibold">${totalCost.toFixed(2)}</span>
            {order.portalSource && (
              <>
                <span className="text-gray-400">Source</span>
                <span className="text-indigo-600 font-medium">Lactalis Portal</span>
              </>
            )}
          </div>
        </div>

        {/* Export actions — only show when there are lines to export */}
        {hasLines && <div className="px-3 py-4 space-y-3 border-b border-gray-100">
          <p className="text-[11px] text-gray-400 font-medium uppercase tracking-wide">Export for Lactalis Portal</p>

          {/* Paste string */}
          <div className="bg-gray-50 rounded-xl p-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-gray-600">Quick Order Paste</span>
              <button
                onClick={copyPaste}
                className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg font-medium transition-colors ${
                  copied === 'paste' ? 'bg-green-100 text-green-700' : 'bg-white border border-gray-200 text-gray-600'
                }`}
              >
                <ClipboardCopy size={12} />
                {copied === 'paste' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p className="text-[11px] text-gray-500 font-mono break-all leading-relaxed">
              {pasteStr || '—'}
            </p>
          </div>

          {/* CSV download */}
          <div className="flex gap-2">
            <button
              onClick={handleDownload}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-700 font-medium bg-white"
            >
              <Download size={15} />
              Download CSV
            </button>
            <button
              onClick={copyCsv}
              className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                copied === 'csv'
                  ? 'bg-green-100 text-green-700 border-green-200'
                  : 'border-gray-200 text-gray-700 bg-white'
              }`}
            >
              <ClipboardCopy size={15} />
              {copied === 'csv' ? 'Copied!' : 'Copy CSV'}
            </button>
          </div>

          {/* Cloud relay submit — primary action */}
          <div>
            {/* Relay status indicator */}
            <div className="flex items-center gap-1.5 mb-2">
              <div className={`w-2 h-2 rounded-full ${
                relayOnline === null ? 'bg-gray-300' : relayOnline ? 'bg-green-500' : 'bg-red-400'
              }`} />
              <span className="text-[11px] text-gray-500">
                {relayOnline === null ? 'Checking relay…' : relayOnline ? 'Main computer: Online' : 'Main computer: Offline'}
              </span>
            </div>
            <button
              onClick={handleCloudSubmit}
              disabled={order.status !== 'approved' || cloudStatus === 'submitting' || cloudStatus === 'waiting' || cloudStatus === 'success'}
              className={`w-full flex flex-col items-center justify-center py-3 rounded-xl text-sm font-semibold transition-colors ${
                cloudStatus === 'success'
                  ? 'bg-green-100 text-green-700'
                  : cloudStatus === 'error'
                    ? 'bg-red-50 text-red-600'
                    : cloudStatus === 'waiting'
                      ? 'bg-amber-50 text-amber-700'
                      : cloudStatus === 'submitting'
                        ? 'bg-blue-50 text-blue-600'
                        : order.status !== 'approved'
                          ? 'bg-gray-100 text-gray-400'
                          : 'bg-blue-600 text-white'
              }`}
            >
              <span className="flex items-center gap-2">
                {cloudStatus === 'waiting' && <RefreshCw size={14} className="animate-spin" />}
                {cloudStatus === 'success' && <CheckCircle2 size={14} />}
                {cloudStatus === 'idle' && <ExternalLink size={15} />}
                {cloudStatus === 'submitting' && <RefreshCw size={14} className="animate-spin" />}
                {cloudStatus === 'error' && <AlertTriangle size={14} />}
                {cloudStatus === 'idle' ? 'Submit Order' : cloudMessage}
              </span>
              {cloudStatus === 'idle' && (
                <span className="text-[10px] opacity-70 mt-0.5">
                  {relayOnline ? 'Auto-submits via your main computer' : 'Queues order — submits when main computer is online'}
                </span>
              )}
            </button>
            {cloudStatus === 'waiting' && (
              <button
                onClick={handleCancelCloud}
                className="w-full mt-1 py-2 rounded-xl text-xs font-medium text-gray-500 border border-gray-200 bg-white"
              >
                Cancel
              </button>
            )}
            {relayOnline === false && cloudStatus === 'idle' && (
              <p className="text-[11px] text-gray-400 text-center mt-1">
                Or open Lactalis Quick Order and tap your Fill Order bookmark
              </p>
            )}
          </div>

          {/* Copy & Open Portal — secondary fallback */}
          <button
            onClick={handleCopyAndOpenPortal}
            disabled={!pasteStr}
            className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-colors ${
              copied === 'portal'
                ? 'bg-green-100 text-green-700'
                : !pasteStr
                  ? 'bg-gray-100 text-gray-400'
                  : 'bg-gray-100 text-gray-600'
            }`}
          >
            <ExternalLink size={15} />
            {copied === 'portal' ? 'Copied! Paste into Quick Order field' : 'Copy Order & Open Portal'}
          </button>

          {/* Auto-submit via extension (desktop only, same-machine) */}
          <button
            onClick={handleSubmitToLactalis}
            disabled={order.status !== 'approved'}
            className={`w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-medium transition-colors ${
              submitted
                ? 'bg-green-100 text-green-700'
                : order.status !== 'approved'
                  ? 'bg-gray-100 text-gray-400'
                  : 'bg-gray-50 text-gray-400 border border-gray-200'
            }`}
          >
            <ExternalLink size={13} />
            {submitted ? 'Sent to Extension…' : 'Auto-Submit via Extension (desktop only)'}
          </button>
        </div>}

        {/* Status actions */}
        {(order.status === 'approved' || order.status === 'submitted') && (
          <div className="px-3 py-4 border-b border-gray-100 flex gap-2">
            {order.status === 'approved' && (
              <button
                onClick={markSubmitted}
                disabled={statusSaving}
                className="flex-1 py-2 border border-purple-200 text-purple-700 text-sm font-medium rounded-xl disabled:opacity-40"
              >
                {statusSaving ? '…' : 'Mark Submitted'}
              </button>
            )}
            {order.status === 'submitted' && (
              <button
                onClick={onReceive}
                className="flex-1 py-2 border border-green-200 text-green-700 text-sm font-medium rounded-xl"
              >
                Receive Order
              </button>
            )}
          </div>
        )}

        {/* Order lines */}
        <div className="px-3 py-3">
          <p className="text-[11px] text-gray-400 font-medium uppercase tracking-wide mb-2">
            Order Lines ({activeLines.length})
          </p>
          {hasLines ? activeLines.map((line) => (
            <div key={line.id} className="flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-800 truncate">{line.productName}</p>
                <p className="text-[11px] text-gray-400">#{line.itemNumber} · ${line.unitPrice.toFixed(2)}/unit</p>
              </div>
              <div className="text-right shrink-0 ml-3">
                <p className="text-sm font-semibold text-gray-900">x{line.approvedQty}</p>
                <p className="text-[11px] text-gray-500">${line.lineTotal.toFixed(2)}</p>
              </div>
            </div>
          )) : (
            <div className="py-6 text-center">
              <p className="text-xs text-gray-400">Line item details not available</p>
              <p className="text-[10px] text-gray-300 mt-1">
                {order.portalSource
                  ? 'Visit this order on the Lactalis portal to sync line items'
                  : 'No items in this order'}
              </p>
            </div>
          )}
        </div>

        {/* Total */}
        <div className="px-3 py-3 border-t border-gray-100 flex justify-between items-center">
          <span className="text-sm font-medium text-gray-600">
            {hasLines ? 'Estimated Total' : 'Portal Total'}
          </span>
          <span className="text-base font-bold text-gray-900">${totalCost.toFixed(2)}</span>
        </div>
      </div>
    </div>
  )
}

// ─── Build view ───────────────────────────────────────────────────────────────

interface BuildViewProps {
  onApproved: (orderId: number) => void
  onCancel: () => void
}

function BuildView({ onApproved, onCancel }: BuildViewProps) {
  const [forecasts, setForecasts] = useState<Forecast[]>([])
  const [qtys, setQtys] = useState<Map<number, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [approving, setApproving] = useState(false)
  const [showOk, setShowOk] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const productImages = useLiveQuery(
    () => db.products.toArray().then((ps) => new Map(ps.map((p) => [p.id!, p.imageUrl ?? '']))),
    [],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      setError('Forecast timed out — tap Retry.')
      setLoading(false)
    }, 30000)
    try {
      const results = await generateForecasts(getSettings())
      clearTimeout(timer)
      if (timedOut) return
      setForecasts(results)
      setQtys((prev) => {
        const next = new Map(prev)
        for (const f of results) {
          if (!next.has(f.productId)) next.set(f.productId, 0)
        }
        return next
      })
    } catch (e) {
      clearTimeout(timer)
      if (!timedOut) setError(friendlyError(e))
    } finally {
      clearTimeout(timer)
      if (!timedOut) setLoading(false)
    }
  }, [])

  // Re-run forecast when settings are saved from SettingsSheet
  useEffect(() => {
    window.addEventListener('forecast-settings-changed', load)
    return () => window.removeEventListener('forecast-settings-changed', load)
  }, [load])

  useEffect(() => { load() }, [load])

  // Stable callback — prevents all ForecastRow memo invalidations on qty change
  const setQty = useCallback((productId: number, qty: number) => {
    setQtys((prev) => new Map(prev).set(productId, qty))
  }, [])

  function resetToSuggested() {
    const next = new Map<number, number>()
    for (const f of forecasts) next.set(f.productId, f.suggestedQty)
    setQtys(next)
  }

  async function handleApprove() {
    const lines = forecasts
      .map((f) => ({ f, qty: qtys.get(f.productId) ?? 0 }))
      .filter(({ qty }) => qty > 0)
    if (lines.length === 0) return

    setApproving(true)
    try {
      const totalCost = lines.reduce((s, { f, qty }) => s + qty * f.lactalisCostPrice, 0)
      const nextDelivery = nextDeliveryDate()
      const deliveryDateStr = `${nextDelivery.getFullYear()}-${String(nextDelivery.getMonth() + 1).padStart(2, '0')}-${String(nextDelivery.getDate()).padStart(2, '0')}`

      const orderId = (await db.orders.add({
        deliveryDate: deliveryDateStr,
        createdAt: new Date(),
        approvedAt: new Date(),
        status: 'approved',
        totalCostEstimate: Math.round(totalCost * 100) / 100,
      })) as number

      await db.orderLines.bulkAdd(
        lines.map(({ f, qty }) => ({
          orderId,
          productId: f.productId,
          itemNumber: f.itemNumber,
          productName: f.productName,
          suggestedQty: f.suggestedQty,
          approvedQty: qty,
          unitPrice: f.lactalisCostPrice,
          lineTotal: Math.round(qty * f.lactalisCostPrice * 100) / 100,
        })),
      )

      onApproved(orderId)
    } catch (e) {
      setError(friendlyError(e))
      setApproving(false)
    }
  }

  const searchTerm = search.trim().toLowerCase()
  const visibleForecasts = searchTerm
    ? forecasts.filter(
        (f) =>
          f.productName.toLowerCase().includes(searchTerm) ||
          f.itemNumber.toLowerCase().includes(searchTerm),
      )
    : forecasts

  const grouped = URGENCY_ORDER.reduce<Record<Urgency, Forecast[]>>(
    (acc, u) => { acc[u] = visibleForecasts.filter((f) => getUrgency(f) === u); return acc },
    { critical: [], order: [], ok: [] },
  )

  const orderLines = forecasts
    .map((f) => ({ f, qty: qtys.get(f.productId) ?? 0 }))
    .filter(({ qty }) => qty > 0)

  const totalItems = orderLines.length
  const totalCostCalc = Math.round(orderLines.reduce((sum, { f, qty }) => sum + qty * f.lactalisCostPrice, 0) * 100) / 100
  const costDelta = totalCostCalc - AVG_DELIVERY_COST

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <RefreshCw size={24} className="text-blue-400 animate-spin" />
        <p className="text-sm text-gray-400">Calculating forecast…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4 text-center">
        <p className="text-sm text-red-600">{error}</p>
        <button onClick={load} className="mt-3 text-sm text-blue-600">Retry</button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="border-b border-gray-200 bg-white shrink-0">
        <div className="flex items-center justify-between px-3 py-2">
          <button onClick={onCancel} className="p-1.5 -ml-1 text-gray-500" aria-label="Cancel">
            <ArrowLeft size={18} />
          </button>
          <p className="text-xs text-gray-500">
            {searchTerm ? `${visibleForecasts.length} of ${forecasts.length}` : forecasts.length} products · {totalItems} to order
          </p>
          <div className="flex items-center gap-1.5">
            <button onClick={resetToSuggested}
              className="flex items-center gap-1 text-xs text-gray-500 px-2 py-1 rounded border border-gray-200">
              <RotateCcw size={12} />Fill Suggested
            </button>
            <button onClick={load}
              className="flex items-center gap-1 text-xs text-gray-500 px-2 py-1 rounded border border-gray-200">
              <RefreshCw size={12} />Refresh
            </button>
          </div>
        </div>
        {/* Search bar */}
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 bg-gray-100 rounded-xl px-3 py-2">
            <Search size={14} className="text-gray-400 shrink-0" />
            <input
              ref={searchRef}
              type="search"
              placeholder="Search products or item #…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setShowOk(true) }}
              className="flex-1 bg-transparent text-sm text-gray-700 placeholder-gray-400 outline-none min-w-0"
            />
            {search && (
              <button onClick={() => { setSearch(''); searchRef.current?.focus() }} className="text-gray-400 shrink-0">
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Forecast list */}
      <div className="flex-1 overflow-auto pb-24">
        {searchTerm && visibleForecasts.length === 0 && (
          <div className="p-8 text-center">
            <Search size={28} className="mx-auto text-gray-200 mb-3" />
            <p className="text-sm text-gray-400">No products match "{search}"</p>
            <button onClick={() => setSearch('')} className="mt-2 text-xs text-blue-500">Clear search</button>
          </div>
        )}
        {URGENCY_ORDER.map((urgency) => {
          const items = grouped[urgency]
          if (items.length === 0) return null
          const isOk = urgency === 'ok'

          return (
            <div key={urgency}>
              <button
                onClick={() => isOk && setShowOk((v) => !v)}
                disabled={isOk && !!searchTerm}
                className={`w-full flex items-center justify-between px-3 py-2 border-b sticky top-0 z-10 ${URGENCY_HEADER[urgency]}`}
              >
                <div className="flex items-center gap-2">
                  {urgency === 'critical' && <AlertTriangle size={13} />}
                  {urgency === 'ok' && <CheckCircle2 size={13} />}
                  <span className="text-xs font-semibold">{URGENCY_LABEL[urgency]}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${URGENCY_PILL[urgency]}`}>
                    {items.length}
                  </span>
                </div>
                {isOk && (showOk ? <ChevronUp size={14} /> : <ChevronDown size={14} />)}
              </button>

              {(!isOk || showOk || !!searchTerm) && items.map((f) => (
                <ForecastRow key={f.productId} forecast={f} qty={qtys.get(f.productId) ?? 0} onChange={setQty} imageUrl={productImages?.get(f.productId)} />
              ))}
            </div>
          )
        })}
      </div>

      {/* Summary + Approve bar */}
      <div
        className="absolute left-1/2 -translate-x-1/2 w-full max-w-[480px] bg-white border-t border-gray-200 px-3 py-2.5 shadow-lg z-20"
        style={{ bottom: 'calc(49px + env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className="text-xs text-gray-500">{totalItems} items · est. cost</p>
            <p className="text-base font-semibold text-gray-900">
              ${totalCostCalc.toFixed(2)}
              <span className={`ml-2 text-xs font-normal ${
                costDelta > 30 ? 'text-amber-600' : costDelta < -30 ? 'text-blue-600' : 'text-gray-400'
              }`}>
                {costDelta >= 0 ? '+' : ''}${costDelta.toFixed(0)} vs avg
              </span>
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-gray-400">avg/delivery</p>
            <p className="text-xs text-gray-500">${AVG_DELIVERY_COST}</p>
          </div>
        </div>
        <button
          onClick={handleApprove}
          disabled={approving || totalItems === 0}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-semibold py-2.5 rounded-xl disabled:opacity-40"
        >
          <ShoppingCart size={16} />
          {approving ? 'Saving…' : `Approve Order (${totalItems} items)`}
        </button>
      </div>
    </div>
  )
}

// ─── Receive view (enhanced — discrepancy detection, claims, invoice photo) ──

interface ReceiveViewProps {
  orderId: number
  onBack: () => void
}

interface ReceiveLine {
  lineId: number
  productId: number
  itemNumber: string
  productName: string
  approvedQty: number
  receivedQty: number
  expiryDate: string
}

type ClaimType = 'damaged' | 'short_delivery' | 'wrong_product' | 'out_of_date'

const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
  damaged: 'Damaged in Transit',
  short_delivery: 'Short Delivery',
  wrong_product: 'Wrong Product Sent',
  out_of_date: 'Out of Date / Short-Dated',
}

const CLAIM_TEMPLATES: Record<ClaimType, string> = {
  damaged: 'Products arrived damaged and are not fit for sale. Please arrange credit or replacement.',
  short_delivery: 'We ordered more units than were received. Please issue a credit for the shortage.',
  wrong_product: 'The incorrect product was delivered. Please arrange collection and send the correct item.',
  out_of_date: 'Products arrived already expired or with insufficient shelf life for retail sale.',
}

function compressPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const MAX = 640
      let w = img.width, h = img.height
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX }
        else { w = Math.round(w * MAX / h); h = MAX }
      }
      canvas.width = w; canvas.height = h
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/jpeg', 0.7))
      URL.revokeObjectURL(img.src)
    }
    img.onerror = reject
    img.src = URL.createObjectURL(file)
  })
}

function ReceiveView({ orderId, onBack }: ReceiveViewProps) {
  const [lines, setLines] = useState<ReceiveLine[]>([])
  const initialized = useRef(false)
  const [confirming, setConfirming] = useState(false)
  const [done, setDone] = useState(false)
  const [receiveError, setReceiveError] = useState<string | null>(null)

  // Claim filing state
  const [claimLineIdx, setClaimLineIdx] = useState<number | null>(null)
  const [claimType, setClaimType] = useState<ClaimType>('short_delivery')
  const [claimDesc, setClaimDesc] = useState('')
  const [claimPhotoUrl, setClaimPhotoUrl] = useState('')
  const [claimPhotoFile, setClaimPhotoFile] = useState<File | null>(null)
  const claimFileRef = useRef<HTMLInputElement>(null)

  // Invoice photo state
  const [invoicePhotoUrl, setInvoicePhotoUrl] = useState('')
  const [invoicePhotoFile, setInvoicePhotoFile] = useState<File | null>(null)
  const invoiceFileRef = useRef<HTMLInputElement>(null)

  const order = useLiveQuery(() => db.orders.get(orderId), [orderId])
  const orderLines = useLiveQuery(
    () => db.orderLines.where('orderId').equals(orderId).toArray(),
    [orderId],
  )

  useEffect(() => {
    if (orderLines && !initialized.current) {
      initialized.current = true
      setLines(
        orderLines
          .filter((l) => l.approvedQty > 0)
          .map((l) => ({
            lineId: l.id!,
            productId: l.productId,
            itemNumber: l.itemNumber,
            productName: l.productName,
            approvedQty: l.approvedQty,
            receivedQty: l.approvedQty,
            expiryDate: '',
          })),
      )
    }
  }, [orderLines])

  function updateLine(i: number, patch: Partial<ReceiveLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }

  const discrepancies = lines.filter((l) => l.receivedQty !== l.approvedQty)
  const hasDiscrepancies = discrepancies.length > 0

  function openClaimForLine(idx: number) {
    const line = lines[idx]
    const isShort = line.receivedQty < line.approvedQty
    const type: ClaimType = isShort ? 'short_delivery' : 'damaged'
    setClaimLineIdx(idx)
    setClaimType(type)
    const shortInfo = isShort ? `Ordered ${line.approvedQty}, received ${line.receivedQty} (short ${line.approvedQty - line.receivedQty}).` : ''
    setClaimDesc(`${shortInfo} ${CLAIM_TEMPLATES[type]}`.trim())
    setClaimPhotoUrl('')
    setClaimPhotoFile(null)
  }

  function closeClaim() {
    setClaimLineIdx(null)
    setClaimDesc('')
    setClaimPhotoUrl('')
    setClaimPhotoFile(null)
  }

  async function submitClaim() {
    if (claimLineIdx === null) return
    const line = lines[claimLineIdx]
    const storeName = localStorage.getItem('milk-manager-store-name') || 'IGA Store'
    const lactalisEmail = localStorage.getItem('milk-manager-lactalis-email') || 'customer.service@lactalis.com.au'
    const today = new Date().toISOString().split('T')[0]
    const qty = Math.abs(line.approvedQty - line.receivedQty) || 1

    // Save claim record
    const claimId = await db.claimRecords.add({
      productId: line.productId,
      productName: line.productName,
      claimType,
      quantity: qty,
      orderId,
      invoiceRef: order?.lactalisOrderNumber ?? undefined,
      description: claimDesc,
      emailSentAt: today,
      createdAt: today,
    }) as number

    // Save claim photo if taken
    if (claimPhotoFile) {
      const base64 = await compressPhoto(claimPhotoFile)
      await db.photoRecords.add({
        orderId,
        claimId,
        productId: line.productId,
        photoType: 'claim_evidence',
        base64,
        capturedAt: new Date().toISOString(),
      })
    }

    // Open Gmail with pre-filled email
    const subject = `Product Claim — ${CLAIM_TYPE_LABELS[claimType]} — ${line.productName} — ${today}`
    const body = `Dear Lactalis Customer Service,

Store: ${storeName}
Date: ${today}
Order: ${order?.lactalisOrderNumber || 'N/A'}

Claim Type: ${CLAIM_TYPE_LABELS[claimType]}
Product: ${line.productName} (#${line.itemNumber})
Quantity: ${qty}

Details:
${claimDesc}

Please arrange credit or replacement at your earliest convenience.

Kind regards,
${storeName}`.trim()

    window.open(
      `https://mail.google.com/mail/u/0/?view=cm&to=${encodeURIComponent(lactalisEmail)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
      '_blank',
    )

    closeClaim()
  }

  async function handleConfirm() {
    setConfirming(true)
    setReceiveError(null)
    try {
      const today = new Date().toISOString().split('T')[0]
      for (const line of lines) {
        if (line.receivedQty > 0 && line.expiryDate) {
          await db.expiryBatches.add({
            productId: line.productId,
            productName: line.productName,
            orderId,
            quantity: line.receivedQty,
            expiryDate: line.expiryDate,
            receivedDate: today,
            status: 'active',
          })
        }
        await db.orderLines.update(line.lineId, { deliveredQty: line.receivedQty })
      }

      // Save invoice photo if taken
      if (invoicePhotoFile) {
        const base64 = await compressPhoto(invoicePhotoFile)
        await db.photoRecords.add({
          orderId,
          photoType: 'invoice',
          base64,
          capturedAt: new Date().toISOString(),
          notes: order?.lactalisOrderNumber ? `Order #${order.lactalisOrderNumber}` : undefined,
        })
      }

      await db.orders.update(orderId, { status: 'delivered' })
      setDone(true)
    } catch (e) {
      setReceiveError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setConfirming(false)
    }
  }

  if (done) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-12 px-6 text-center h-full">
        <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
          <CheckCircle2 size={28} className="text-green-600" />
        </div>
        <p className="text-base font-semibold text-gray-900">Order received!</p>
        <p className="text-sm text-gray-500">
          Expiry batches saved. Order marked as delivered.
          {invoicePhotoFile && ' Invoice photo stored.'}
        </p>
        {hasDiscrepancies && (
          <p className="text-xs text-amber-600">
            {discrepancies.length} discrepanc{discrepancies.length === 1 ? 'y' : 'ies'} noted
          </p>
        )}
        <button onClick={onBack} className="mt-2 bg-blue-600 text-white text-sm font-medium px-6 py-2.5 rounded-xl">
          Done
        </button>
      </div>
    )
  }

  // Inline claim form modal
  if (claimLineIdx !== null) {
    const line = lines[claimLineIdx]
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 bg-white shrink-0">
          <button onClick={closeClaim} className="p-1.5 -ml-1 text-gray-500" aria-label="Back">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <p className="text-sm font-semibold text-gray-900">File Claim</p>
            <p className="text-[11px] text-gray-400">{line.productName}</p>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-3 space-y-3">
          <div className="bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
            <p className="text-xs text-amber-700 font-medium">
              Ordered x{line.approvedQty} · Received x{line.receivedQty}
              {line.receivedQty < line.approvedQty && ` · Short x${line.approvedQty - line.receivedQty}`}
              {line.receivedQty > line.approvedQty && ` · Extra x${line.receivedQty - line.approvedQty}`}
            </p>
          </div>

          <div>
            <label className="text-xs text-gray-500 mb-1 block">Claim Type</label>
            <select
              value={claimType}
              onChange={(e) => {
                const t = e.target.value as ClaimType
                setClaimType(t)
                setClaimDesc(CLAIM_TEMPLATES[t])
              }}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700"
            >
              {(Object.entries(CLAIM_TYPE_LABELS) as [ClaimType, string][]).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-gray-500 mb-1 block">Description</label>
            <textarea
              rows={3}
              value={claimDesc}
              onChange={(e) => setClaimDesc(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none"
            />
          </div>

          {/* Evidence photo */}
          <input
            ref={claimFileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (!f) return
              setClaimPhotoFile(f)
              setClaimPhotoUrl(URL.createObjectURL(f))
            }}
          />
          {!claimPhotoUrl ? (
            <button
              onClick={() => claimFileRef.current?.click()}
              className="w-full h-16 rounded-xl border border-dashed border-gray-300 bg-gray-50 flex items-center justify-center gap-2 text-gray-400 text-xs"
            >
              <Camera size={16} /> Take Evidence Photo (optional)
            </button>
          ) : (
            <div className="relative">
              <img src={claimPhotoUrl} className="w-full rounded-xl object-contain max-h-32" alt="Claim evidence" />
              <button
                onClick={() => { setClaimPhotoFile(null); setClaimPhotoUrl('') }}
                className="absolute top-1 right-1 bg-black/50 text-white rounded-full p-1"
              >
                <X size={12} />
              </button>
            </div>
          )}
        </div>

        <div className="shrink-0 px-3 py-3 border-t border-gray-100 bg-white">
          <button
            onClick={submitClaim}
            className="w-full flex items-center justify-center gap-2 bg-red-600 text-white font-semibold py-2.5 rounded-xl"
          >
            <FileWarning size={16} /> Submit Claim & Open Email
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 bg-white shrink-0">
        <button onClick={onBack} className="p-1.5 -ml-1 text-gray-500" aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1">
          <p className="text-sm font-semibold text-gray-900">Review Delivery</p>
          <p className="text-[11px] text-gray-400">
            {order?.lactalisOrderNumber ? `Order #${order.lactalisOrderNumber}` : 'Enter received quantities'}
          </p>
        </div>
        {hasDiscrepancies && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
            {discrepancies.length} issue{discrepancies.length > 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-3">
        {/* Invoice photo capture */}
        <input
          ref={invoiceFileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (!f) return
            setInvoicePhotoFile(f)
            setInvoicePhotoUrl(URL.createObjectURL(f))
          }}
        />
        {!invoicePhotoUrl ? (
          <button
            onClick={() => invoiceFileRef.current?.click()}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed border-blue-200 bg-blue-50 text-blue-600 text-xs font-medium"
          >
            <Camera size={14} /> Scan Invoice Photo
          </button>
        ) : (
          <div className="relative">
            <img src={invoicePhotoUrl} className="w-full rounded-xl object-contain max-h-24" alt="Invoice" />
            <div className="absolute top-1 left-1 bg-blue-600 text-white text-[9px] px-1.5 py-0.5 rounded-full font-medium">
              Invoice
            </div>
            <button
              onClick={() => { setInvoicePhotoFile(null); setInvoicePhotoUrl('') }}
              className="absolute top-1 right-1 bg-black/50 text-white rounded-full p-1"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* Discrepancy summary banner */}
        {hasDiscrepancies && (
          <div className="bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
            <p className="text-xs text-amber-700 font-medium">
              {discrepancies.length} discrepanc{discrepancies.length === 1 ? 'y' : 'ies'} detected
            </p>
            <p className="text-[10px] text-amber-600 mt-0.5">
              Tap "File Claim" on flagged items to send to Lactalis
            </p>
          </div>
        )}

        {lines.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-8">Loading order lines…</p>
        )}
        {lines.map((line, i) => {
          const isDiscrepant = line.receivedQty !== line.approvedQty
          const isShort = line.receivedQty < line.approvedQty

          return (
            <div
              key={line.lineId}
              className={`bg-white border rounded-xl p-3 ${
                isDiscrepant ? 'border-amber-200' : 'border-gray-100'
              }`}
            >
              <div className="mb-2">
                <p className="text-sm font-medium text-gray-900">{line.productName}</p>
                <p className="text-[11px] text-gray-400">#{line.itemNumber} · Ordered: x{line.approvedQty}</p>
              </div>
              <div className="flex items-center gap-3 mb-2">
                <span className="text-xs text-gray-500 shrink-0">Received:</span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => updateLine(i, { receivedQty: Math.max(0, line.receivedQty - 1) })}
                    className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-gray-600"
                  >
                    <Minus size={12} />
                  </button>
                  <span className={`w-8 text-center text-sm font-semibold ${
                    isDiscrepant ? 'text-amber-600' : 'text-gray-900'
                  }`}>
                    {line.receivedQty}
                  </span>
                  <button
                    onClick={() => updateLine(i, { receivedQty: line.receivedQty + 1 })}
                    className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-gray-600"
                  >
                    <Plus size={12} />
                  </button>
                </div>
                {isDiscrepant && (
                  <span className={`text-[11px] font-medium ${isShort ? 'text-red-600' : 'text-blue-600'}`}>
                    {isShort
                      ? `Short x${line.approvedQty - line.receivedQty}`
                      : `Extra x${line.receivedQty - line.approvedQty}`}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 shrink-0">Expiry:</span>
                <input
                  type="date"
                  value={line.expiryDate}
                  onChange={(e) => updateLine(i, { expiryDate: e.target.value })}
                  className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-700"
                />
                {!line.expiryDate && (
                  <span className="text-[10px] text-gray-300 shrink-0">optional</span>
                )}
              </div>
              {/* Claim shortcut for discrepant items */}
              {isDiscrepant && (
                <button
                  onClick={() => openClaimForLine(i)}
                  className="mt-2 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-medium border border-red-100"
                >
                  <FileWarning size={12} /> File Claim
                </button>
              )}
            </div>
          )
        })}
        {receiveError && (
          <div className="bg-red-50 border border-red-100 rounded-xl px-3 py-2">
            <p className="text-xs text-red-600">{receiveError}</p>
          </div>
        )}
      </div>

      <div className="shrink-0 px-3 py-3 border-t border-gray-100 bg-white">
        <button
          onClick={handleConfirm}
          disabled={confirming || lines.length === 0}
          className="w-full flex items-center justify-center gap-2 bg-green-600 text-white font-semibold py-2.5 rounded-xl disabled:opacity-40"
        >
          {confirming ? (
            <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</>
          ) : (
            <><CheckCircle2 size={16} /> Confirm Delivery</>
          )}
        </button>
      </div>
    </div>
  )
}

// ─── Root container ───────────────────────────────────────────────────────────

type View = 'history' | 'build' | 'export' | 'receive'

export default function OrderBuilder() {
  const [view, setView] = useState<View>('history')
  const [exportOrderId, setExportOrderId] = useState<number | null>(null)

  function handleApproved(orderId: number) {
    setExportOrderId(orderId)
    setView('export')
  }

  function handleViewOrder(orderId: number) {
    setExportOrderId(orderId)
    setView('export')
  }

  if (view === 'build') {
    return (
      <BuildView
        onApproved={handleApproved}
        onCancel={() => setView('history')}
      />
    )
  }

  if (view === 'export' && exportOrderId !== null) {
    return (
      <ExportView
        orderId={exportOrderId}
        onBack={() => setView('history')}
        onReceive={() => setView('receive')}
      />
    )
  }

  if (view === 'receive' && exportOrderId !== null) {
    return (
      <ReceiveView
        orderId={exportOrderId}
        onBack={() => setView('export')}
      />
    )
  }

  return (
    <HistoryView
      onBuild={() => setView('build')}
      onViewOrder={handleViewOrder}
    />
  )
}
