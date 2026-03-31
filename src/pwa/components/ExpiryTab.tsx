/**
 * ExpiryTab.tsx — Session 15
 *
 * Views:
 *  'dashboard' — pending check-ins + active expiry batches by urgency + recent waste
 *  'checkin'   — confirm delivery for a submitted order (enter qty + expiry dates)
 */

import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Minus,
  Plus,
  Trash2,
} from 'lucide-react'
import { db } from '../lib/db'
import { parseLocalDate } from '../lib/constants'
import type { ExpiryBatch, WasteEntry } from '../lib/types'

// ─── Date helpers ─────────────────────────────────────────────────────────────

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dateInDays(daysFromToday: number): string {
  const d = new Date()
  d.setDate(d.getDate() + daysFromToday)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function daysUntil(dateStr: string): number {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = parseLocalDate(dateStr)
  return Math.ceil((target.getTime() - today.getTime()) / 86400000)
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '—'
  try {
    const d = parseLocalDate(dateStr)
    return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })
  } catch { return dateStr }
}

// ─── Expiry urgency groups ────────────────────────────────────────────────────

type ExpiryGroup = 'expired' | 'today' | 'urgent' | 'soon' | 'ok'

function getExpiryGroup(days: number): ExpiryGroup {
  if (days < 0)  return 'expired'
  if (days === 0) return 'today'
  if (days <= 2)  return 'urgent'
  if (days <= 7)  return 'soon'
  return 'ok'
}

const GROUP_CONFIG: Record<ExpiryGroup, {
  label: string; headerBg: string; headerText: string; badge: string
}> = {
  expired: { label: 'Expired',       headerBg: 'bg-gray-100',   headerText: 'text-gray-600',   badge: 'bg-gray-200 text-gray-600' },
  today:   { label: 'Expires Today', headerBg: 'bg-red-100',    headerText: 'text-red-700',    badge: 'bg-red-100 text-red-700' },
  urgent:  { label: '1–2 Days Left', headerBg: 'bg-orange-100', headerText: 'text-orange-700', badge: 'bg-orange-100 text-orange-700' },
  soon:    { label: '3–7 Days',      headerBg: 'bg-amber-100',  headerText: 'text-amber-700',  badge: 'bg-amber-100 text-amber-700' },
  ok:      { label: '8+ Days',       headerBg: 'bg-green-100',  headerText: 'text-green-700',  badge: 'bg-green-100 text-green-700' },
}

const GROUP_ORDER: ExpiryGroup[] = ['expired', 'today', 'urgent', 'soon', 'ok']

// ─── Write-off inline form ────────────────────────────────────────────────────

interface WriteOffFormProps {
  batch: ExpiryBatch
  onDone: () => void
  onCancel: () => void
}

function WriteOffForm({ batch, onDone, onCancel }: WriteOffFormProps) {
  const [qty, setQty] = useState(batch.quantity)
  const [reason, setReason] = useState<WasteEntry['reason']>('expired')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit() {
    if (qty <= 0) return
    setSaving(true)
    try {
      await db.wasteLog.add({
        productId:     batch.productId,
        productName:   batch.productName,
        expiryBatchId: batch.id,
        quantity:      qty,
        wastedDate:    todayStr(),
        reason,
        notes: notes.trim() || undefined,
      })
      const remaining = batch.quantity - qty
      if (remaining <= 0) {
        await db.expiryBatches.update(batch.id!, { status: 'wasted', quantity: 0 })
      } else {
        await db.expiryBatches.update(batch.id!, { quantity: remaining })
      }
      onDone()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-2 p-3 bg-gray-50 rounded-xl border border-gray-200 space-y-2">
      {/* Qty stepper */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-600">Write-off quantity</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setQty((q) => Math.max(1, q - 1))}
            className="w-7 h-7 flex items-center justify-center rounded-full bg-gray-200 text-gray-700"
          >
            <Minus size={12} />
          </button>
          <span className="w-8 text-center text-sm font-semibold">{qty}</span>
          <button
            onClick={() => setQty((q) => Math.min(batch.quantity, q + 1))}
            className="w-7 h-7 flex items-center justify-center rounded-full bg-gray-200 text-gray-700"
          >
            <Plus size={12} />
          </button>
        </div>
      </div>

      {/* Reason */}
      <div>
        <p className="text-xs text-gray-600 mb-1">Reason</p>
        <div className="flex gap-2">
          {(['expired', 'damaged', 'other'] as const).map((r) => (
            <button
              key={r}
              onClick={() => setReason(r)}
              className={`flex-1 py-1 text-xs font-medium rounded-lg border transition-colors capitalize ${
                reason === r
                  ? 'bg-red-600 text-white border-red-600'
                  : 'bg-white text-gray-600 border-gray-200'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Notes */}
      <input
        type="text"
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-red-400"
      />

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={onCancel}
          className="flex-1 py-1.5 text-xs font-medium border border-gray-200 rounded-lg text-gray-600"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={saving}
          className="flex-1 py-1.5 text-xs font-semibold bg-red-600 text-white rounded-lg disabled:opacity-40"
        >
          {saving ? 'Saving…' : `Write Off ${qty} unit${qty !== 1 ? 's' : ''}`}
        </button>
      </div>
    </div>
  )
}

// ─── Expiry batch card ────────────────────────────────────────────────────────

function BatchCard({ batch }: { batch: ExpiryBatch }) {
  const [showWriteOff, setShowWriteOff] = useState(false)
  const days = daysUntil(batch.expiryDate)
  const group = getExpiryGroup(days)
  const cfg = GROUP_CONFIG[group]

  const expiryLabel =
    days < 0  ? `Expired ${Math.abs(days)}d ago` :
    days === 0 ? 'Expires today' :
    days === 1 ? 'Expires tomorrow' :
                 `Expires in ${days}d`

  return (
    <div className="border-b border-gray-100 last:border-0">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{batch.productName}</p>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded-full ${cfg.badge}`}>
              {expiryLabel}
            </span>
            <span className="text-[11px] text-gray-400">
              {formatDate(batch.expiryDate)}
            </span>
            {batch.orderId && (
              <span className="text-[11px] text-gray-400">· Order #{batch.orderId}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="text-right">
            <p className="text-sm font-semibold text-gray-900">{batch.quantity}</p>
            <p className="text-[10px] text-gray-400">units</p>
          </div>
          <button
            onClick={() => setShowWriteOff((v) => !v)}
            className="p-1.5 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50"
            title="Write off"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {showWriteOff && (
        <div className="px-3 pb-3">
          <WriteOffForm
            batch={batch}
            onDone={() => setShowWriteOff(false)}
            onCancel={() => setShowWriteOff(false)}
          />
        </div>
      )}
    </div>
  )
}

// ─── Check-in view ────────────────────────────────────────────────────────────

interface CheckInLine {
  productId:   number
  productName: string
  itemNumber:  string
  approvedQty: number
  deliveredQty: number
  expiryDate:  string
}

interface CheckInViewProps {
  orderId: number
  onBack: () => void
}

function CheckInView({ orderId, onBack }: CheckInViewProps) {
  const [lines, setLines] = useState<CheckInLine[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  const order = useLiveQuery(() => db.orders.get(orderId), [orderId])
  const orderLines = useLiveQuery(
    () => db.orderLines.where('orderId').equals(orderId).toArray(),
    [orderId],
  )

  // Initialise form lines once order lines load
  if (orderLines && !lines) {
    const defaultExpiry = dateInDays(7)
    setLines(
      orderLines.map((ol) => ({
        productId:    ol.productId,
        productName:  ol.productName,
        itemNumber:   ol.itemNumber,
        approvedQty:  ol.approvedQty,
        deliveredQty: ol.approvedQty,
        expiryDate:   defaultExpiry,
      })),
    )
  }

  function setDelivered(idx: number, qty: number) {
    setLines((prev) => prev
      ? prev.map((l, i) => i === idx ? { ...l, deliveredQty: Math.max(0, qty) } : l)
      : prev
    )
  }

  function setExpiry(idx: number, date: string) {
    setLines((prev) => prev
      ? prev.map((l, i) => i === idx ? { ...l, expiryDate: date } : l)
      : prev
    )
  }

  async function handleConfirm() {
    if (!lines || !order) return
    setSaving(true)
    try {
      const today = todayStr()

      // Create an ExpiryBatch for each line with qty > 0 and a valid expiry date
      const batches = lines.filter((l) => l.deliveredQty > 0 && l.expiryDate)
      await db.expiryBatches.bulkAdd(
        batches.map((l) => ({
          productId:    l.productId,
          productName:  l.productName,
          orderId,
          quantity:     l.deliveredQty,
          expiryDate:   l.expiryDate,
          receivedDate: today,
          status: 'active' as const,
        })),
      )

      // Update order lines with deliveredQty
      for (const l of lines) {
        const ol = orderLines?.find((o) => o.productId === l.productId)
        if (ol?.id) await db.orderLines.update(ol.id, { deliveredQty: l.deliveredQty })
      }

      // Create stock snapshots — increase QOH by delivered quantity
      const batchId = `delivery_${orderId}_${today}`
      for (const l of lines) {
        if (l.deliveredQty <= 0) continue
        const product = await db.products.get(l.productId)
        if (!product) continue
        // Get latest QOH for this product
        const snaps = await db.stockSnapshots
          .where('productId').equals(l.productId)
          .toArray()
        const latestSnap = snaps.sort(
          (a, b) => new Date(b.importedAt).getTime() - new Date(a.importedAt).getTime()
        )[0]
        const prevQoh = latestSnap?.qoh ?? 0
        await db.stockSnapshots.add({
          productId: l.productId,
          barcode: product.barcode,
          qoh: prevQoh + l.deliveredQty,
          importedAt: new Date(),
          source: 'item_stock_report' as const,
          importBatchId: batchId,
        })
      }

      // Mark order as delivered
      await db.orders.update(orderId, { status: 'delivered' })

      setDone(true)
    } finally {
      setSaving(false)
    }
  }

  if (done) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
        <CheckCircle2 size={40} className="text-green-500" />
        <p className="text-base font-semibold text-gray-900">Delivery confirmed!</p>
        <p className="text-sm text-gray-500">Expiry batches saved for {lines?.filter((l) => l.deliveredQty > 0).length} products</p>
        <button
          onClick={onBack}
          className="mt-2 px-6 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl"
        >
          Back to Expiry
        </button>
      </div>
    )
  }

  if (!order || !lines) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-200 bg-white shrink-0">
        <button onClick={onBack} className="p-1.5 -ml-1 text-gray-500">
          <ArrowLeft size={18} />
        </button>
        <div>
          <p className="text-sm font-semibold text-gray-900">Confirm Delivery</p>
          <p className="text-[11px] text-gray-400">
            Order #{orderId} · {lines.length} products
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-auto pb-24">
        <p className="px-3 pt-3 pb-1 text-[11px] text-gray-400 font-medium uppercase tracking-wide">
          Enter delivered quantities + expiry dates
        </p>

        {lines.map((line, idx) => (
          <div key={line.productId} className="px-3 py-3 border-b border-gray-100">
            <p className="text-sm font-medium text-gray-900 mb-2 truncate">{line.productName}</p>

            <div className="grid grid-cols-2 gap-2">
              {/* Delivered qty */}
              <div>
                <p className="text-[11px] text-gray-500 mb-1">Delivered qty</p>
                <div className="flex items-center gap-1.5">
                  <button
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => setDelivered(idx, line.deliveredQty - 1)}
                    className="w-7 h-7 flex items-center justify-center rounded-full bg-gray-100 text-gray-600"
                  >
                    <Minus size={12} />
                  </button>
                  <span className="w-8 text-center text-sm font-semibold text-gray-900">
                    {line.deliveredQty}
                  </span>
                  <button
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => setDelivered(idx, line.deliveredQty + 1)}
                    className="w-7 h-7 flex items-center justify-center rounded-full bg-gray-100 text-gray-600"
                  >
                    <Plus size={12} />
                  </button>
                  {line.deliveredQty !== line.approvedQty && (
                    <span className="text-[10px] text-amber-600 ml-1">
                      (ordered {line.approvedQty})
                    </span>
                  )}
                </div>
              </div>

              {/* Expiry date */}
              <div>
                <p className="text-[11px] text-gray-500 mb-1">Expiry date</p>
                <input
                  type="date"
                  value={line.expiryDate}
                  min={todayStr()}
                  onChange={(e) => setExpiry(idx, e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Confirm bar */}
      <div className="absolute bottom-[49px] left-1/2 -translate-x-1/2 w-full max-w-[480px] bg-white border-t border-gray-200 px-3 py-2.5 shadow-lg z-20">
        <button
          onClick={handleConfirm}
          disabled={saving}
          className="w-full flex items-center justify-center gap-2 bg-green-600 text-white font-semibold py-2.5 rounded-xl disabled:opacity-40"
        >
          <ClipboardCheck size={16} />
          {saving ? 'Saving…' : 'Confirm Delivery & Save Expiry Dates'}
        </button>
      </div>
    </div>
  )
}

// ─── Dashboard view ───────────────────────────────────────────────────────────

interface DashboardProps {
  onCheckIn: (orderId: number) => void
}

function ExpiryDashboard({ onCheckIn }: DashboardProps) {
  const activeBatches = useLiveQuery(
    () => db.expiryBatches.where('status').equals('active').toArray(),
    [],
  )
  const submittedOrders = useLiveQuery(
    () => db.orders.where('status').equals('submitted').toArray(),
    [],
  )
  const recentWaste = useLiveQuery(
    () => db.wasteLog.orderBy('wastedDate').reverse().limit(5).toArray(),
    [],
  )

  if (!activeBatches || !submittedOrders) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // Group active batches by expiry urgency
  const grouped = GROUP_ORDER.reduce<Record<ExpiryGroup, ExpiryBatch[]>>(
    (acc, g) => { acc[g] = []; return acc },
    {} as Record<ExpiryGroup, ExpiryBatch[]>,
  )
  for (const b of activeBatches) {
    grouped[getExpiryGroup(daysUntil(b.expiryDate))].push(b)
  }
  // Sort each group by earliest expiry first
  for (const g of GROUP_ORDER) {
    grouped[g].sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))
  }

  const hasAnyBatches = activeBatches.length > 0
  const urgentCount = grouped.expired.length + grouped.today.length + grouped.urgent.length

  return (
    <div className="flex-1 overflow-auto pb-4">

      {/* ── Pending check-ins ─────────────────────────────────────────────── */}
      {submittedOrders.length > 0 && (
        <div className="mx-3 mt-3">
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Awaiting Delivery Check-In
          </p>
          <div className="bg-blue-50 border border-blue-200 rounded-xl overflow-hidden">
            {submittedOrders.map((order) => (
              <button
                key={order.id}
                onClick={() => onCheckIn(order.id!)}
                className="w-full flex items-center justify-between px-3 py-3 border-b border-blue-100 last:border-0 text-left active:bg-blue-100"
              >
                <div>
                  <p className="text-sm font-medium text-blue-900">
                    Order #{order.id} — {order.deliveryDate}
                  </p>
                  <p className="text-[11px] text-blue-600 mt-0.5">
                    Tap to confirm delivery &amp; enter expiry dates
                  </p>
                </div>
                <ClipboardCheck size={18} className="text-blue-500 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Expiry batches ────────────────────────────────────────────────── */}
      <div className="mx-3 mt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
            Active Stock
          </p>
          {urgentCount > 0 && (
            <span className="text-[11px] font-semibold text-red-600">
              {urgentCount} need attention
            </span>
          )}
        </div>

        {!hasAnyBatches ? (
          <div className="bg-white border border-gray-100 rounded-xl py-8 text-center">
            <CalendarClock size={28} className="mx-auto text-gray-200 mb-2" />
            <p className="text-sm text-gray-400">No expiry batches yet</p>
            <p className="text-xs text-gray-300 mt-1">
              Confirm a delivery above to start tracking
            </p>
          </div>
        ) : (
          GROUP_ORDER.map((group) => {
            const batches = grouped[group]
            if (batches.length === 0) return null
            const cfg = GROUP_CONFIG[group]
            return (
              <div key={group} className="mb-3">
                <div className={`px-3 py-1.5 rounded-t-xl flex items-center justify-between ${cfg.headerBg}`}>
                  <span className={`text-xs font-semibold ${cfg.headerText}`}>{cfg.label}</span>
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${cfg.badge}`}>
                    {batches.length}
                  </span>
                </div>
                <div className="bg-white border border-t-0 border-gray-100 rounded-b-xl overflow-hidden">
                  {batches.map((b) => <BatchCard key={b.id} batch={b} />)}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* ── Recent waste log ─────────────────────────────────────────────── */}
      {recentWaste && recentWaste.length > 0 && (
        <div className="mx-3 mt-2">
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Recent Write-Offs
          </p>
          <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
            {recentWaste.map((w) => (
              <div key={w.id} className="flex items-center justify-between px-3 py-2.5 border-b border-gray-100 last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800 truncate">{w.productName}</p>
                  <p className="text-[11px] text-gray-400">
                    {formatDate(w.wastedDate)} · {w.reason}
                    {w.notes && ` · ${w.notes}`}
                  </p>
                </div>
                <div className="ml-3 shrink-0 text-right">
                  <p className="text-sm font-semibold text-red-500">−{w.quantity}</p>
                  <p className="text-[10px] text-gray-400">units</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Empty state when nothing submitted and no batches ─────────────── */}
      {submittedOrders.length === 0 && !hasAnyBatches && (
        <div className="flex flex-col items-center justify-center h-64 gap-3 px-8 text-center">
          <AlertTriangle size={32} className="text-gray-200" />
          <p className="text-sm text-gray-400">No expiry data yet</p>
          <p className="text-xs text-gray-300">
            After an order is submitted via the portal, come back here to confirm the delivery and log expiry dates.
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function ExpiryTab() {
  const [view, setView] = useState<'dashboard' | 'checkin'>('dashboard')
  const [checkInOrderId, setCheckInOrderId] = useState<number | null>(null)

  function handleCheckIn(orderId: number) {
    setCheckInOrderId(orderId)
    setView('checkin')
  }

  function handleBack() {
    setCheckInOrderId(null)
    setView('dashboard')
  }

  if (view === 'checkin' && checkInOrderId !== null) {
    return <CheckInView orderId={checkInOrderId} onBack={handleBack} />
  }

  return <ExpiryDashboard onCheckIn={handleCheckIn} />
}
