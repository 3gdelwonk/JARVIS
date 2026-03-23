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
  X,
} from 'lucide-react'
import { generateForecasts, getSettings, type Forecast } from '../lib/forecastEngine'
import { db } from '../lib/db'
import { AVG_DELIVERY_COST, nextDeliveryDate, friendlyError } from '../lib/constants'
import type { Order } from '../lib/types'
import { submitOrder as relaySubmitOrder, checkRelay } from '../lib/lactalisRelay'

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

// ─── LongPressRow — hold to reveal delete ───────────────────────────────────

const HOLD_MS = 400

function LongPressRow({ children, onDelete, enabled }: {
  children: React.ReactNode
  onDelete: () => void
  enabled: boolean
}) {
  const [showDelete, setShowDelete] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const movedRef = useRef(false)

  function clearTimer() {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
  }

  function handleTouchStart() {
    if (!enabled) return
    movedRef.current = false
    timerRef.current = setTimeout(() => {
      if (!movedRef.current) setShowDelete(true)
    }, HOLD_MS)
  }

  function handleTouchMove() {
    movedRef.current = true
    clearTimer()
  }

  function handleTouchEnd() {
    clearTimer()
  }

  function handleContextMenu(e: React.MouseEvent) {
    if (!enabled) return
    e.preventDefault()
    setShowDelete(true)
  }

  function handleConfirmDelete() {
    setShowDelete(false)
    onDelete()
  }

  return (
    <div className="relative"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onContextMenu={handleContextMenu}
    >
      {children}

      {/* Delete overlay — shown on long press */}
      {showDelete && (
        <div className="absolute inset-0 flex items-center justify-end gap-2 px-3 bg-red-50/95 rounded-lg z-10">
          <span className="flex-1 text-xs text-red-700 font-medium">Delete this item?</span>
          <button onClick={() => setShowDelete(false)}
            className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg">
            Cancel
          </button>
          <button onClick={handleConfirmDelete}
            className="px-3 py-1.5 text-xs font-semibold text-white bg-red-500 rounded-lg">
            Delete
          </button>
        </div>
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
}

const ForecastRow = memo(function ForecastRow({ forecast: f, qty, onChange, imageUrl }: RowProps) {
  const [editing, setEditing] = useState(false)
  const [inputVal, setInputVal] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function startEdit() {
    setInputVal(String(qty))
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  function commitEdit() {
    onChange(f.productId, Math.max(0, parseInt(inputVal, 10) || 0))
    setEditing(false)
  }

  const stockLabel = f.currentStock !== null ? `${f.currentStock} in stock` : 'stock unknown'
  const stockoutLabel =
    f.daysUntilStockout !== null
      ? f.daysUntilStockout <= 0 ? 'Stocked out' : `${f.daysUntilStockout}d left`
      : null
  const costLine = qty > 0 ? `$${(qty * f.lactalisCostPrice).toFixed(2)}` : null

  return (
    <div className="px-3 py-2.5 border-b border-gray-100 last:border-0">
      <div className="flex items-start justify-between gap-2">
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

        <div className="flex items-center gap-1 shrink-0">
          <button onPointerDown={(e) => e.preventDefault()}
            onClick={() => onChange(f.productId, Math.max(0, qty - 1))}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 active:bg-gray-200 text-gray-600"
            aria-label="Decrease">
            <Minus size={14} />
          </button>

          {editing ? (
            <input ref={inputRef} type="text" inputMode="numeric" pattern="[0-9]*" value={inputVal}
              onChange={(e) => setInputVal(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={commitEdit}
              onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') { inputRef.current?.blur(); setEditing(false) } }}
              className="w-12 text-center text-sm font-semibold border border-blue-400 rounded py-0.5 outline-none" />
          ) : (
            <button onClick={startEdit}
              className={`w-12 text-center text-sm font-semibold py-0.5 rounded ${
                qty === 0 ? 'text-gray-300' : qty > f.suggestedQty * 1.5 ? 'text-amber-600' : 'text-gray-900'
              }`}
              aria-label="Edit quantity">
              {qty}
            </button>
          )}

          <button onPointerDown={(e) => e.preventDefault()}
            onClick={() => onChange(f.productId, qty + 1)}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 active:bg-gray-200 text-gray-600"
            aria-label="Increase">
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
  const orders = useLiveQuery(
    () => db.orders.orderBy('createdAt').reverse().toArray(),
    [],
  )

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
            <button
              key={order.id}
              onClick={() => onViewOrder(order.id!)}
              className="w-full text-left px-3 py-3 border-b border-gray-100 flex items-center justify-between gap-3 active:bg-gray-50"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">
                  {new Date(order.createdAt).toLocaleDateString('en-AU', {
                    weekday: 'short', day: 'numeric', month: 'short',
                  })}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  ${order.totalCostEstimate.toFixed(2)} est.
                </p>
              </div>
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[order.status]}`}>
                {order.status}
              </span>
            </button>
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

  const isEditable = order.status === 'draft' || order.status === 'approved'
  const activeLines = lines.filter((l) => l.approvedQty > 0)
  const totalCost = Math.round(activeLines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100
  const dateStr = new Date(order.createdAt).toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long',
  })

  async function updateLineQty(lineId: number, newQty: number) {
    if (newQty < 1) return
    const line = lines?.find(l => l.id === lineId)
    if (!line) return
    const newLineTotal = Math.round(newQty * line.unitPrice * 100) / 100
    await db.orderLines.update(lineId, { approvedQty: newQty, lineTotal: newLineTotal })
    // Recalculate order total
    const allLines = await db.orderLines.where('orderId').equals(orderId).toArray()
    const newTotal = Math.round(allLines.filter(l => l.approvedQty > 0).reduce((s, l) => s + l.lineTotal, 0) * 100) / 100
    await db.orders.update(orderId, { totalCostEstimate: newTotal })
  }

  async function deleteLine(lineId: number) {
    await db.orderLines.delete(lineId)
    const remaining = await db.orderLines.where('orderId').equals(orderId).toArray()
    if (remaining.filter(l => l.approvedQty > 0).length === 0) {
      await db.orders.update(orderId, { totalCostEstimate: 0, status: 'cancelled' })
      onBack()
      return
    }
    const newTotal = Math.round(remaining.filter(l => l.approvedQty > 0).reduce((s, l) => s + l.lineTotal, 0) * 100) / 100
    await db.orders.update(orderId, { totalCostEstimate: newTotal })
  }

  async function handleRelaySubmit() {
    setRelayStatus('submitting')
    setRelayError(null)
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
      setRelayError(err.message)
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
            {isEditable && (
              <p className="text-[10px] text-gray-300">Hold to delete</p>
            )}
          </div>

          {activeLines.length === 0 ? (
            <div className="py-8 text-center">
              <ShoppingCart size={28} className="mx-auto text-gray-200 mb-2" />
              <p className="text-sm text-gray-400">All items removed</p>
              <button onClick={onBack} className="mt-2 text-sm text-blue-600">Back to Orders</button>
            </div>
          ) : (
            activeLines.map((line) => (
              <LongPressRow key={line.id} onDelete={() => deleteLine(line.id!)} enabled={isEditable}>
                <div className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                  <ProductThumb imageUrl={productImageMap?.get(line.productId)} />
                  <div className="flex-1 min-w-0 ml-2">
                    <p className="text-sm text-gray-800 truncate">{line.productName}</p>
                    <p className="text-[11px] text-gray-400">#{line.itemNumber} · ${line.unitPrice.toFixed(2)}/unit</p>
                  </div>
                  {isEditable ? (
                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      <button onClick={() => updateLineQty(line.id!, line.approvedQty - 1)}
                        className="w-7 h-7 flex items-center justify-center rounded-full bg-gray-100 active:bg-gray-200 text-gray-600">
                        <Minus size={12} />
                      </button>
                      <span className="w-8 text-center text-sm font-semibold">{line.approvedQty}</span>
                      <button onClick={() => updateLineQty(line.id!, line.approvedQty + 1)}
                        className="w-7 h-7 flex items-center justify-center rounded-full bg-gray-100 active:bg-gray-200 text-gray-600">
                        <Plus size={12} />
                      </button>
                    </div>
                  ) : (
                    <div className="text-right shrink-0 ml-3">
                      <p className="text-sm font-semibold text-gray-900">x{line.approvedQty}</p>
                      <p className="text-[11px] text-gray-500">${line.lineTotal.toFixed(2)}</p>
                    </div>
                  )}
                </div>
              </LongPressRow>
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

function BuildView({ onApproved, onCancel }: BuildViewProps) {
  const [forecasts, setForecasts] = useState<Forecast[]>([])
  const [qtys, setQtys] = useState<Map<number, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [approving, setApproving] = useState(false)
  const [showOk, setShowOk] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showCamera, setShowCamera] = useState(false)
  const [scanToast, setScanToast] = useState<string | null>(null)
  const [highlightProductId, setHighlightProductId] = useState<number | null>(null)
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
        <button onClick={onCancel} className="p-1.5 -ml-1 text-gray-500" aria-label="Cancel">
          <ArrowLeft size={18} />
        </button>
        <p className="text-xs text-gray-500">{forecasts.length} products · {totalItems} to order</p>
        <div className="flex items-center gap-1.5">
          <button onClick={resetToSuggested}
            className="flex items-center gap-1 text-xs text-gray-500 px-2 py-1 rounded border border-gray-200">
            <RotateCcw size={12} />Reset
          </button>
          <button onClick={load}
            className="flex items-center gap-1 text-xs text-gray-500 px-2 py-1 rounded border border-gray-200">
            <RefreshCw size={12} />Refresh
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
          <div className="relative rounded-lg overflow-hidden bg-black" style={{ height: 180 }}>
            <video ref={cam.videoRef} playsInline muted className="w-full h-full object-cover" />
            {cam.cameraError && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/70">
                <p className="text-xs text-red-400 text-center px-4">{cam.cameraError}</p>
              </div>
            )}
            <button onClick={() => setShowCamera(false)}
              className="absolute top-2 right-2 bg-black/50 text-white rounded-full p-1">
              <X size={14} />
            </button>
            <div className="absolute inset-x-4 top-1/2 -translate-y-1/2 h-0.5 bg-red-500/60 rounded" />
          </div>
        )}
      </div>

      {/* Scan toast */}
      {scanToast && (
        <div className="mx-3 mt-2 px-3 py-2 rounded-lg bg-gray-800 text-white text-xs text-center">
          {scanToast}
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
                      onChange={setQty} imageUrl={productImageMap?.get(f.productId)} />
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
                        onChange={setQty} imageUrl={productImageMap?.get(f.productId)} />
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )
      })()}

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
