/**
 * OrderBuilder.tsx
 *
 * Three-view container:
 *  'history' — past orders list + "Build New Order"
 *  'build'   — forecast editor (urgency-grouped, qty steppers)
 *  'detail'  — order detail + submit via JARVISmart relay
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
  ImageOff,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShoppingCart,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { generateForecasts, getSettings, type Forecast } from '../lib/forecastEngine'
import { db } from '../lib/db'
import { AVG_DELIVERY_COST, nextDeliveryDate, friendlyError } from '../lib/constants'
import type { Order } from '../lib/types'
import { submitOrder as relaySubmitOrder, checkRelay } from '../lib/lactalisRelay'
import type { ItemPerformance } from '../lib/posRelay'
import { getSyncStatus, syncPullOnly } from '../lib/cloudSync'

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

// ─── Product image thumbnail ─────────────────────────────────────────────────

function ProductThumb({ imageUrl, size = 8 }: { imageUrl?: string; size?: number }) {
  return (
    <div className={`relative w-${size} h-${size} rounded-md overflow-hidden bg-gray-100 shrink-0 flex items-center justify-center`}>
      <ImageOff size={12} className="text-gray-300" />
      {imageUrl && (
        <img src={imageUrl} alt="" className="absolute inset-0 w-full h-full object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
      )}
    </div>
  )
}


// ─── ForecastRow ──────────────────────────────────────────────────────────────

interface RowProps {
  forecast: Forecast
  qty: number
  onChange: (id: number, qty: number) => void
  imageUrl?: string
  posData?: ItemPerformance | null
}

const ForecastRow = memo(function ForecastRow({ forecast: f, qty, onChange, imageUrl, posData }: RowProps) {
  const isLive = posData !== undefined && posData !== null
  const stockLabel = f.currentStock !== null
    ? `${f.currentStock} in stock`
    : 'stock unknown'
  const stockoutLabel =
    f.daysUntilStockout !== null
      ? f.daysUntilStockout <= 0 ? 'Stocked out' : `${f.daysUntilStockout}d left`
      : null
  const costLine = qty > 0 ? `$${(qty * f.lactalisCostPrice).toFixed(2)}` : null

  return (
    <div className="px-3 py-2.5 border-b border-gray-100 last:border-0">
      <div className="flex items-start gap-2">
        <ProductThumb imageUrl={imageUrl} />
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
            {isLive && <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 mr-0.5" title="Live POS" />}
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
            {posData && (
              <>
                <span className="text-[11px] text-gray-400">·</span>
                <span className={`text-[11px] font-medium ${
                  posData.gpPercent < 15 ? 'text-red-500' :
                  posData.gpPercent < 25 ? 'text-amber-500' : 'text-green-600'
                }`}>{posData.gpPercent.toFixed(1)}% GP</span>
              </>
            )}
          </div>
        </div>

        {/* Quantity stepper */}
        <div className="flex items-center shrink-0">
          <button
            onClick={() => onChange(f.productId, Math.max(0, qty - 1))}
            className={`w-8 h-8 flex items-center justify-center rounded-l-lg border transition-colors ${
              qty > 0
                ? 'border-blue-300 bg-blue-50 text-blue-600 active:bg-blue-100'
                : 'border-gray-200 bg-gray-50 text-gray-300'
            }`}
            aria-label="Decrease"
          >
            <Minus size={14} />
          </button>
          <input
            type="text" inputMode="numeric" pattern="[0-9]*"
            value={qty === 0 ? '' : String(qty)}
            placeholder="0"
            onTouchStart={(e) => {
              const el = e.currentTarget
              const startY = e.touches[0]?.clientY ?? 0
              const onTouchEnd = (te: TouchEvent) => {
                const endY = te.changedTouches[0]?.clientY ?? 0
                if (Math.abs(endY - startY) > 10) el.blur()
                el.removeEventListener('touchend', onTouchEnd)
              }
              el.addEventListener('touchend', onTouchEnd, { once: true })
            }}
            onChange={(e) => {
              const val = e.target.value.replace(/[^0-9]/g, '')
              onChange(f.productId, val === '' ? 0 : parseInt(val, 10))
            }}
            className={`w-10 h-8 text-center text-sm font-semibold border-y outline-none ${
              qty > 0 ? 'border-blue-300 bg-blue-50 text-gray-900' : 'border-gray-200 text-gray-400'
            }`}
          />
          <button
            onClick={() => onChange(f.productId, qty + 1)}
            className="w-8 h-8 flex items-center justify-center rounded-r-lg border border-blue-300 bg-blue-50 text-blue-600 active:bg-blue-100 transition-colors"
            aria-label="Increase"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
    </div>
  )
})

// ─── History view ─────────────────────────────────────────────────────────────

interface HistoryViewProps {
  onBuild: () => void
  onViewOrder: (id: number) => void
}

function HistoryView({ onBuild, onViewOrder }: HistoryViewProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [lastPull, setLastPull] = useState(() => getSyncStatus().lastPull)
  const [pulling, setPulling] = useState(false)

  const orders = useLiveQuery(
    () => db.orders.orderBy('createdAt').reverse().toArray(),
    [],
  )

  async function deleteOrder(orderId: number) {
    await db.orderLines.where('orderId').equals(orderId).delete()
    await db.orders.delete(orderId)
    setConfirmDeleteId(null)
  }

  async function handlePullRefresh() {
    setPulling(true)
    await syncPullOnly()
    setLastPull(getSyncStatus().lastPull)
    setPulling(false)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-gray-200 bg-white shrink-0">
        <button
          onClick={onBuild}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-semibold py-2.5 rounded-xl"
        >
          <ShoppingCart size={16} />
          Build New Order
        </button>
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-[10px] text-gray-400">
            {lastPull
              ? `Synced ${new Date(lastPull).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
              : 'Not synced yet'}
          </span>
          <button
            onClick={handlePullRefresh}
            disabled={pulling}
            className="flex items-center gap-1 text-[10px] text-blue-600 active:text-blue-800 disabled:opacity-50"
          >
            <RefreshCw size={10} className={pulling ? 'animate-spin' : ''} />
            {pulling ? 'Syncing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {!orders || orders.length === 0 ? (
          <div className="p-8 text-center">
            <ShoppingCart size={32} className="mx-auto text-gray-200 mb-3" />
            <p className="text-sm text-gray-400">No orders yet</p>
            <p className="text-xs text-gray-300 mt-1">Build your first order above</p>
          </div>
        ) : (
          orders.map((order) => (
            <div key={order.id} className="relative border-b border-gray-100">
              {/* Delete confirmation overlay */}
              {confirmDeleteId === order.id && (
                <div className="absolute inset-0 flex items-center justify-end gap-2 px-3 bg-red-50/95 z-10">
                  <span className="flex-1 text-xs text-red-700 font-medium">Delete this order?</span>
                  <button onClick={() => setConfirmDeleteId(null)}
                    className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg">
                    Cancel
                  </button>
                  <button onClick={() => deleteOrder(order.id!)}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-red-500 rounded-lg">
                    Delete
                  </button>
                </div>
              )}

              <div className="flex items-center gap-3 px-3 py-3">
                <button
                  onClick={() => onViewOrder(order.id!)}
                  className="flex-1 min-w-0 text-left active:bg-gray-50"
                >
                  <p className="text-sm font-medium text-gray-900">
                    {new Date(order.createdAt).toLocaleDateString('en-AU', {
                      weekday: 'short', day: 'numeric', month: 'short',
                    })}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    ${order.totalCostEstimate.toFixed(2)} est.
                  </p>
                </button>
                <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0 ${STATUS_BADGE[order.status]}`}>
                  {order.status}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(order.id!) }}
                  className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 active:bg-red-100 text-gray-400 active:text-red-600 shrink-0"
                  aria-label="Delete order"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ─── Order detail view ──────────────────────────────────────────────────────

interface OrderDetailProps {
  orderId: number
  onBack: () => void
}

function OrderDetailView({ orderId, onBack }: OrderDetailProps) {
  const [statusSaving, setStatusSaving] = useState(false)
  const [relayStatus, setRelayStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const [relayError, setRelayError] = useState<string | null>(null)
  const [relayHealth, setRelayHealth] = useState<{ connected: boolean; reason?: string } | null>(null)

  const order = useLiveQuery(() => db.orders.get(orderId), [orderId])
  const lines = useLiveQuery(
    () => db.orderLines.where('orderId').equals(orderId).toArray(),
    [orderId],
  )
  const productImageMap = useLiveQuery(
    () => db.products.toArray().then((ps) => new Map(ps.map((p) => [p.id!, p.imageUrl ?? '']))),
    [],
  )

  useEffect(() => {
    checkRelay().then(setRelayHealth)
  }, [])

  if (!order || !lines) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw size={20} className="text-gray-300 animate-spin" />
      </div>
    )
  }

  const activeLines = lines.filter((l) => l.approvedQty > 0)
  const totalCost = Math.round(activeLines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100
  const dateStr = new Date(order.createdAt).toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long',
  })

  async function handleRelaySubmit() {
    // Re-check relay health right before submitting
    setRelayStatus('submitting')
    setRelayError(null)

    let health: { connected: boolean; reason?: string }
    try {
      health = await checkRelay()
    } catch {
      health = { connected: false, reason: 'Could not reach JARVISmart' }
    }
    setRelayHealth(health)
    if (!health.connected) {
      setRelayStatus('error')
      setRelayError(`JARVISmart unreachable: ${health.reason || 'unknown'} — cannot submit`)
      return
    }

    // Request a wake lock so iOS doesn't kill the fetch while Playwright runs (~15-25s)
    let wakeLock: WakeLockSentinel | null = null
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await (navigator as any).wakeLock.request('screen')
      }
    } catch { /* wake lock is best-effort */ }

    try {
      const relayLines = activeLines.map(l => ({ itemNumber: l.itemNumber, qty: l.approvedQty }))
      const result = await relaySubmitOrder(relayLines)
      if (result.success) {
        setRelayStatus('success')
        await db.orders.update(orderId, { status: 'submitted', submittedAt: new Date() })
      } else {
        setRelayStatus('error')
        setRelayError(result.error || 'Unknown error')
      }
    } catch (err: any) {
      setRelayStatus('error')
      const msg: string = err.message || 'Unknown error'
      setRelayError(msg)
    } finally {
      wakeLock?.release().catch(() => {})
    }
  }

  async function markDelivered() {
    setStatusSaving(true)
    try {
      await db.orders.update(orderId, { status: 'delivered' })
    } finally {
      setStatusSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Back bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 bg-white shrink-0">
        <button onClick={onBack} className="p-1.5 -ml-1 text-gray-500" aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate">{dateStr}</p>
          <p className="text-[11px] text-gray-400">
            {activeLines.length} items · ${totalCost.toFixed(2)}
          </p>
        </div>
        <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0 ${STATUS_BADGE[order.status]}`}>
          {order.status}
        </span>
      </div>

      <div className="flex-1 overflow-auto">

        {/* Submit / status actions */}
        <div className="px-3 py-4 space-y-3 border-b border-gray-100">

          {/* Relay health indicator */}
          {relayHealth && (
            <div className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg ${
              relayHealth.connected
                ? 'bg-green-50 text-green-700'
                : 'bg-red-50 text-red-600'
            }`}>
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                relayHealth.connected ? 'bg-green-500' : 'bg-red-500'
              }`} />
              {relayHealth.connected ? 'JARVISmart connected' : `JARVISmart unreachable: ${relayHealth.reason}`}
            </div>
          )}

          {/* Submit button — draft/approved orders */}
          {(order.status === 'draft' || order.status === 'approved') && (
            <div>
              <button
                onClick={handleRelaySubmit}
                disabled={relayStatus === 'submitting' || relayStatus === 'success' || activeLines.length === 0}
                className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-colors ${
                  relayStatus === 'success'
                    ? 'bg-green-100 text-green-700'
                    : relayStatus === 'error'
                      ? 'bg-red-600 text-white'
                      : 'bg-blue-600 text-white'
                } disabled:opacity-50`}
              >
                <ShoppingCart size={16} />
                {relayStatus === 'submitting'
                  ? 'Submitting to Lactalis...'
                  : relayStatus === 'success'
                    ? 'Submitted to Checkout!'
                    : relayStatus === 'error'
                      ? 'Retry Submit'
                      : 'Submit Order'}
              </button>
              {relayError && (
                <p className="text-xs text-red-500 mt-1.5 px-1">{relayError}</p>
              )}
            </div>
          )}

          {/* Mark delivered — submitted orders */}
          {order.status === 'submitted' && (
            <button
              onClick={markDelivered}
              disabled={statusSaving}
              className="w-full py-2.5 border border-green-200 text-green-700 text-sm font-medium rounded-xl disabled:opacity-40"
            >
              {statusSaving ? '...' : 'Mark Delivered'}
            </button>
          )}
        </div>

        {/* Order lines */}
        <div className="px-3 py-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[11px] text-gray-400 font-medium uppercase tracking-wide">
              Order Lines ({activeLines.length})
            </p>
          </div>

          {activeLines.length === 0 ? (
            <div className="py-8 text-center">
              <ShoppingCart size={28} className="mx-auto text-gray-200 mb-2" />
              <p className="text-sm text-gray-400">No items in this order</p>
              <button onClick={onBack} className="mt-2 text-sm text-blue-600">Back to Orders</button>
            </div>
          ) : (
            activeLines.map((line) => (
              <div key={line.id} className="flex items-center gap-2 py-2 border-b border-gray-50 last:border-0">
                <ProductThumb imageUrl={productImageMap?.get(line.productId)} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800 truncate">{line.productName}</p>
                  <p className="text-[11px] text-gray-400">#{line.itemNumber} · ${line.unitPrice.toFixed(2)}/unit</p>
                </div>
                <div className="text-right shrink-0 ml-2">
                  <p className="text-sm font-semibold text-gray-900">x{line.approvedQty}</p>
                  <p className="text-[11px] text-gray-500">${line.lineTotal.toFixed(2)}</p>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Total */}
        <div className="px-3 py-3 border-t border-gray-100 flex justify-between items-center">
          <span className="text-sm font-medium text-gray-600">Estimated Total</span>
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

// ─── Barcode camera hook (from ScannerTab) ──────────────────────────────────

const nativeBarcodeSupported = typeof (window as { BarcodeDetector?: unknown }).BarcodeDetector !== 'undefined'

function useBarcodeCamera(onDetected: (barcode: string) => void) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const zxingControlsRef = useRef<{ stop: () => void } | null>(null)
  const shouldScanRef = useRef(true)
  const onDetectedRef = useRef(onDetected)
  const [cameraError, setCameraError] = useState('')

  useEffect(() => { onDetectedRef.current = onDetected })

  async function startCamera() {
    setCameraError('')
    try {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        })
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        })
      }
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      const videoTrack = stream.getVideoTracks()[0]
      if (videoTrack) {
        videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {})
      }
      if (nativeBarcodeSupported) {
        runDetection()
      } else {
        runZxingDetection()
      }
    } catch (e) {
      const name = (e as Error).name
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setCameraError('Camera permission denied')
      } else if (name === 'NotFoundError') {
        setCameraError('No camera found')
      } else {
        setCameraError('Camera unavailable')
      }
    }
  }

  function stopCamera() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    zxingControlsRef.current?.stop()
    zxingControlsRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  function runDetection() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detector = new (window as any).BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code'],
    })
    async function tick() {
      if (!shouldScanRef.current) return
      const video = videoRef.current
      if (!video || video.readyState < 2) { rafRef.current = requestAnimationFrame(tick); return }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const barcodes: any[] = await detector.detect(video)
        if (barcodes.length > 0 && shouldScanRef.current) {
          shouldScanRef.current = false
          onDetectedRef.current(barcodes[0].rawValue)
          return
        }
      } catch { /* detector not ready */ }
      if (shouldScanRef.current) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  async function runZxingDetection() {
    try {
      const { BrowserMultiFormatReader } = await import('@zxing/browser')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hints = new Map<any, unknown>([[3, true]])
      const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 100 })
      const controls = await reader.decodeFromVideoElement(
        videoRef.current!,
        (result) => {
          if (result && shouldScanRef.current) {
            shouldScanRef.current = false
            onDetectedRef.current(result.getText())
          }
        },
      )
      zxingControlsRef.current = controls
    } catch { /* ZXing unavailable */ }
  }

  function resumeScanning() {
    shouldScanRef.current = true
    if (streamRef.current) {
      if (nativeBarcodeSupported) {
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        if (videoRef.current?.paused) videoRef.current.play().catch(() => {})
        runDetection()
      } else {
        zxingControlsRef.current?.stop()
        zxingControlsRef.current = null
        runZxingDetection()
      }
    }
  }

  return { videoRef, cameraError, startCamera, stopCamera, resumeScanning, shouldScanRef, streamRef }
}

const DRAFT_KEY = 'milk-manager-order-draft'

function BuildView({ onApproved, onCancel }: BuildViewProps) {
  const [forecasts, setForecasts] = useState<Forecast[]>([])
  const [posMap, setPosMap] = useState<Map<string, ItemPerformance>>(new Map())
  const [qtys, setQtys] = useState<Map<number, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [approving, setApproving] = useState(false)
  const [showOk, setShowOk] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showCamera, setShowCamera] = useState(false)
  const [scanToast, setScanToast] = useState<string | null>(null)
  const [highlightProductId, setHighlightProductId] = useState<number | null>(null)
  const [draftRestored, setDraftRestored] = useState(false)
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  // Product barcode map for scanner lookup
  const productBarcodeMap = useLiveQuery(
    () => db.products.toArray().then((ps) => {
      const m = new Map<string, number>()
      for (const p of ps) {
        if (p.barcode) m.set(p.barcode, p.id!)
        if (p.invoiceCode) m.set(p.invoiceCode, p.id!)
      }
      return m
    }),
    [],
  )

  // Barcode scanner
  const handleBarcodeScan = useCallback((barcode: string) => {
    const productId = productBarcodeMap?.get(barcode)
    const match = productId != null ? forecasts.find((f) => f.productId === productId) : null
    // Also try matching by invoiceCode on forecasts directly
    const matchByCode = match ?? forecasts.find((f) => f.invoiceCode === barcode)
    const found = matchByCode
    if (found) {
      setQtys((prev) => {
        const next = new Map(prev)
        if ((next.get(found.productId) ?? 0) === 0) next.set(found.productId, 1)
        return next
      })
      setHighlightProductId(found.productId)
      setTimeout(() => setHighlightProductId(null), 2000)
      setTimeout(() => {
        rowRefs.current.get(found.productId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 100)
      setShowCamera(false)
      setScanToast(`Found: ${found.productName}`)
      setTimeout(() => setScanToast(null), 2500)
    } else {
      setScanToast(`No product found for barcode ${barcode}`)
      setTimeout(() => setScanToast(null), 2500)
      cam.resumeScanning()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forecasts, productBarcodeMap])

  const cam = useBarcodeCamera(handleBarcodeScan)

  useEffect(() => {
    if (showCamera) {
      cam.startCamera()
    } else {
      cam.stopCamera()
    }
    return () => { cam.stopCamera() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCamera])

  const productImageMap = useLiveQuery(
    () => db.products.toArray().then((ps) => new Map(ps.map((p) => [p.id!, p.imageUrl ?? '']))),
    [],
  )

  // Barcode by productId for search
  const productBarcodeById = useLiveQuery(
    () => db.products.toArray().then((ps) => new Map(ps.map((p) => [p.id!, p.barcode ?? '']))),
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
      const { forecasts: results, posMap: pm } = await generateForecasts(getSettings())
      clearTimeout(timer)
      if (timedOut) return
      setForecasts(results)
      setPosMap(pm)
      setQtys((prev) => {
        const next = new Map(prev)
        for (const f of results) {
          if (!next.has(f.productId)) next.set(f.productId, 0)
        }
        // Restore draft quantities from localStorage
        const saved = localStorage.getItem(DRAFT_KEY)
        if (saved) {
          try {
            const draft = JSON.parse(saved) as Record<string, number>
            let restored = false
            for (const [id, qty] of Object.entries(draft)) {
              const numId = Number(id)
              if (next.has(numId) && qty > 0) { next.set(numId, qty); restored = true }
            }
            if (restored) setDraftRestored(true)
          } catch { /* corrupt draft — ignore */ }
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

  // Auto-save draft to localStorage on qty changes
  useEffect(() => {
    if (loading) return
    const nonZero: Record<string, number> = {}
    for (const [id, qty] of qtys) {
      if (qty > 0) nonZero[String(id)] = qty
    }
    if (Object.keys(nonZero).length > 0) {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(nonZero))
    } else {
      localStorage.removeItem(DRAFT_KEY)
    }
  }, [qtys, loading])

  // Stable callback — prevents all ForecastRow memo invalidations on qty change
  const setQty = useCallback((productId: number, qty: number) => {
    setQtys((prev) => new Map(prev).set(productId, qty))
  }, [])

  function resetToZero() {
    const next = new Map<number, number>()
    for (const f of forecasts) next.set(f.productId, 0)
    setQtys(next)
    setDraftRestored(false)
  }

  function fillSuggested() {
    setQtys((prev) => {
      const next = new Map(prev)
      for (const f of forecasts) {
        if (f.suggestedQty > 0) next.set(f.productId, f.suggestedQty)
      }
      return next
    })
  }

  function handleCancel() {
    // Draft is already auto-saved to localStorage — just navigate back
    onCancel()
  }

  function handleApprove() {
    const lines = forecasts
      .map((f) => ({ f, qty: qtys.get(f.productId) ?? 0 }))
      .filter(({ qty }) => qty > 0)
    if (lines.length === 0) return
    setShowConfirm(true)
  }

  async function confirmAndSave() {
    const lines = forecasts
      .map((f) => ({ f, qty: qtys.get(f.productId) ?? 0 }))
      .filter(({ qty }) => qty > 0)
    if (lines.length === 0) return

    console.log('[OrderBuilder] Saving order:', lines.length, 'items',
      lines.map(({ f, qty }) => `${f.productName} ×${qty}`))

    setApproving(true)
    setShowConfirm(false)
    try {
      const totalCost = lines.reduce((s, { f, qty }) => s + qty * f.lactalisCostPrice, 0)
      const nextDelivery = nextDeliveryDate()
      const deliveryDateStr = `${nextDelivery.getFullYear()}-${String(nextDelivery.getMonth() + 1).padStart(2, '0')}-${String(nextDelivery.getDate()).padStart(2, '0')}`

      const orderId = (await db.orders.add({
        deliveryDate: deliveryDateStr,
        createdAt: new Date(),
        status: 'draft',
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

      localStorage.removeItem(DRAFT_KEY)
      onApproved(orderId)
    } catch (e) {
      setError(friendlyError(e))
      setApproving(false)
    }
  }

  const grouped = URGENCY_ORDER.reduce<Record<Urgency, Forecast[]>>(
    (acc, u) => { acc[u] = forecasts.filter((f) => getUrgency(f) === u); return acc },
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
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-white shrink-0">
        <button onClick={handleCancel} className="p-2 -ml-1 text-gray-500 active:bg-gray-100 rounded-lg" aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <p className="text-xs text-gray-500">{forecasts.length} products · {totalItems} to order</p>
        <div className="flex items-center gap-1">
          <button onClick={fillSuggested}
            className="flex items-center gap-1 text-xs text-blue-600 px-2 py-1.5 rounded-lg border border-blue-200 active:bg-blue-50"
            title="Fill all suggested quantities">
            <Sparkles size={12} />Fill
          </button>
          <button onClick={resetToZero}
            className="flex items-center gap-1 text-xs text-gray-500 px-2 py-1.5 rounded-lg border border-gray-200 active:bg-gray-50">
            <RotateCcw size={12} />Clear
          </button>
        </div>
      </div>

      {/* Search + Camera bar */}
      <div className="px-3 py-2 border-b border-gray-100 bg-white shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              placeholder="Search name, barcode, item #…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-8 py-1.5 border border-gray-300 rounded-lg text-sm"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400">
                <X size={14} />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowCamera((v) => !v)}
            className={`p-2 rounded-lg border ${showCamera ? 'bg-blue-50 border-blue-300 text-blue-600' : 'border-gray-300 text-gray-500'}`}
            aria-label="Scan barcode"
          >
            <Camera size={18} />
          </button>
        </div>

        {/* Camera overlay */}
        {showCamera && (
          <div className="relative rounded-xl overflow-hidden bg-black" style={{ height: 200 }}>
            <video ref={cam.videoRef} playsInline muted className="w-full h-full object-cover" />
            {cam.cameraError ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80">
                <p className="text-xs text-red-400 text-center px-4">{cam.cameraError}</p>
                <button onClick={() => setShowCamera(false)}
                  className="px-4 py-2 bg-white/20 text-white text-xs font-medium rounded-lg active:bg-white/30">
                  Close Camera
                </button>
              </div>
            ) : (
              <>
                {/* Scan guide lines */}
                <div className="absolute inset-x-8 top-1/2 -translate-y-1/2 pointer-events-none">
                  <div className="h-16 border-2 border-white/40 rounded-lg" />
                </div>
                {/* Status text */}
                <div className="absolute bottom-2 inset-x-0 text-center">
                  <span className="text-[11px] text-white/80 bg-black/50 px-3 py-1 rounded-full">
                    Point camera at barcode
                  </span>
                </div>
              </>
            )}
            {/* Close button — large touch target */}
            <button onClick={() => setShowCamera(false)}
              className="absolute top-2 right-2 flex items-center gap-1 bg-black/60 text-white rounded-lg px-3 py-2 active:bg-black/80">
              <X size={16} />
              <span className="text-xs font-medium">Close</span>
            </button>
          </div>
        )}
      </div>

      {/* Scan toast */}
      {scanToast && (
        <div className="mx-3 mt-2 px-3 py-2 rounded-lg bg-gray-800 text-white text-xs text-center">
          {scanToast}
        </div>
      )}

      {/* Draft restored banner */}
      {draftRestored && (
        <div className="mx-3 mt-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg flex items-center justify-between">
          <p className="text-[11px] text-blue-700 font-medium">Draft order restored</p>
          <button onClick={() => { resetToZero(); setDraftRestored(false) }}
            className="text-[11px] text-blue-600 font-medium px-2 py-0.5 rounded active:bg-blue-100">
            Discard
          </button>
        </div>
      )}

      {/* POS status banner */}
      {posMap.size === 0 && (
        <div className="mx-3 mt-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-[11px] text-amber-700">
            Live POS data unavailable — using last known stock levels. Check JARVISmart connection in Settings.
          </p>
        </div>
      )}

      {/* Forecast list */}
      {(() => {
        const query = searchQuery.trim().toLowerCase()
        const isSearching = query.length > 0
        const words = query.split(/\s+/).filter(Boolean)

        // When searching: flat filtered list. Otherwise: urgency groups
        if (isSearching) {
          const filtered = forecasts.filter((f) => {
            const name = f.productName.toLowerCase()
            const code = f.invoiceCode.toLowerCase()
            const item = f.itemNumber.toLowerCase()
            const barcode = (productBarcodeById?.get(f.productId) ?? '').toLowerCase()
            return words.every((w) => name.includes(w) || code.includes(w) || item.includes(w) || barcode.includes(w))
          })
          return (
            <div className="flex-1 overflow-auto pb-24">
              {filtered.length === 0 ? (
                <div className="py-8 text-center">
                  <p className="text-sm text-gray-400">No products match &ldquo;{searchQuery}&rdquo;</p>
                </div>
              ) : (
                filtered.map((f) => (
                  <div key={f.productId} ref={(el) => { if (el) rowRefs.current.set(f.productId, el) }}
                    className={highlightProductId === f.productId ? 'ring-2 ring-blue-400 ring-inset bg-blue-50 transition-all' : ''}>
                    <ForecastRow forecast={f} qty={qtys.get(f.productId) ?? 0}
                      onChange={setQty} imageUrl={productImageMap?.get(f.productId)}
                      posData={posMap.get(f.itemNumber) || posMap.get(f.itemNumber.replace(/^STR0*/, '')) || null} />
                  </div>
                ))
              )}
            </div>
          )
        }

        return (
          <div className="flex-1 overflow-auto pb-24">
            {URGENCY_ORDER.map((urgency) => {
              const items = grouped[urgency]
              if (items.length === 0) return null
              const isOk = urgency === 'ok'

              return (
                <div key={urgency}>
                  <button
                    onClick={() => isOk && setShowOk((v) => !v)}
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

                  {(!isOk || showOk) && items.map((f) => (
                    <div key={f.productId} ref={(el) => { if (el) rowRefs.current.set(f.productId, el) }}
                      className={highlightProductId === f.productId ? 'ring-2 ring-blue-400 ring-inset bg-blue-50 transition-all' : ''}>
                      <ForecastRow forecast={f} qty={qtys.get(f.productId) ?? 0}
                        onChange={setQty} imageUrl={productImageMap?.get(f.productId)}
                      posData={posMap.get(f.itemNumber) || posMap.get(f.itemNumber.replace(/^STR0*/, '')) || null} />
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )
      })()}

      {/* Confirmation modal */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={() => setShowConfirm(false)}>
          <div
            className="w-full max-w-[480px] bg-white rounded-t-2xl shadow-xl max-h-[70vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-gray-200 shrink-0">
              <p className="text-sm font-semibold text-gray-900">Confirm Order ({orderLines.length} items)</p>
              <p className="text-xs text-gray-500 mt-0.5">
                ${totalCostCalc.toFixed(2)} est.
              </p>
            </div>
            <div className="flex-1 overflow-auto px-4 py-2">
              {orderLines.map(({ f, qty }) => (
                <div key={f.productId} className="flex items-center justify-between py-1.5 border-b border-gray-50 last:border-0">
                  <p className="text-sm text-gray-800 truncate flex-1 mr-2">{f.productName}</p>
                  <div className="text-right shrink-0">
                    <span className="text-sm font-semibold text-gray-900">{qty}</span>
                    <span className="text-[11px] text-gray-400 ml-1.5">${(qty * f.lactalisCostPrice).toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="px-4 py-3 border-t border-gray-200 flex gap-2 shrink-0">
              <button
                onClick={() => setShowConfirm(false)}
                className="flex-1 py-2.5 rounded-xl border border-gray-300 text-sm font-medium text-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={confirmAndSave}
                disabled={approving}
                className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold disabled:opacity-40"
              >
                {approving ? 'Saving…' : 'Confirm Order'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Summary + Done bar */}
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
          <CheckCircle2 size={16} />
          {approving ? 'Saving…' : `Done (${totalItems} items)`}
        </button>
      </div>
    </div>
  )
}

// ─── Root container ───────────────────────────────────────────────────────────

type View = 'history' | 'build' | 'detail'

export default function OrderBuilder() {
  const [view, setView] = useState<View>('history')
  const [detailOrderId, setDetailOrderId] = useState<number | null>(null)

  function handleApproved(orderId: number) {
    setDetailOrderId(orderId)
    setView('detail')
  }

  function handleViewOrder(orderId: number) {
    setDetailOrderId(orderId)
    setView('detail')
  }

  if (view === 'build') {
    return (
      <BuildView
        onApproved={handleApproved}
        onCancel={() => setView('history')}
      />
    )
  }

  if (view === 'detail' && detailOrderId !== null) {
    return (
      <OrderDetailView
        orderId={detailOrderId}
        onBack={() => setView('history')}
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
