import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  ChevronRight, ChevronDown, ChevronUp, TrendingUp,
  RefreshCw, BarChart2, FileText,
} from 'lucide-react'
import {
  getInvoiceSummaries,
  getInvoiceLines,
  analyzeHistory,
  updateDefaultQtysFromHistory,
  type InvoiceSummary,
  type ProductStats,
  type OverallStats,
} from '../lib/historyAnalyzer'
import type { InvoiceLine } from '../lib/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(d: string) {
  if (!d) return '—'
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}

function fmtMoney(n: number) {
  return `$${n.toFixed(2)}`
}

const DOC_TYPE_BADGE: Record<string, string> = {
  invoice: 'bg-green-100 text-green-800',
  credit_note: 'bg-orange-100 text-orange-800',
  adjustment: 'bg-red-100 text-red-800',
}
const DOC_TYPE_LABEL: Record<string, string> = {
  invoice: 'Invoice',
  credit_note: 'Adj. Note',
  adjustment: 'Credit Adj.',
}

// ─── Overall Stats Bar ───────────────────────────────────────────────────────

function StatsBar({ stats }: { stats: OverallStats }) {
  const topDays = Object.entries(stats.dayOfWeekPattern)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([d, n]) => `${d.slice(0, 3)} (${n})`)
    .join(', ')

  return (
    <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 grid grid-cols-2 gap-2 text-sm">
      <div>
        <p className="text-[11px] text-blue-500 font-medium uppercase tracking-wide">Invoices</p>
        <p className="font-semibold text-blue-900">{stats.totalInvoices}</p>
      </div>
      <div>
        <p className="text-[11px] text-blue-500 font-medium uppercase tracking-wide">Deliveries</p>
        <p className="font-semibold text-blue-900">{stats.totalDeliveries}</p>
      </div>
      <div>
        <p className="text-[11px] text-blue-500 font-medium uppercase tracking-wide">Weekly Avg Spend</p>
        <p className="font-semibold text-blue-900">{fmtMoney(stats.weeklyAvgSpend)}</p>
      </div>
      <div>
        <p className="text-[11px] text-blue-500 font-medium uppercase tracking-wide">Avg / Delivery</p>
        <p className="font-semibold text-blue-900">{fmtMoney(stats.avgSpendPerDelivery)}</p>
      </div>
      {stats.dateRange && (
        <div className="col-span-2">
          <p className="text-[11px] text-blue-500 font-medium uppercase tracking-wide">Date Range</p>
          <p className="text-blue-800 text-xs">{fmt(stats.dateRange.from)} → {fmt(stats.dateRange.to)}</p>
        </div>
      )}
      {topDays && (
        <div className="col-span-2">
          <p className="text-[11px] text-blue-500 font-medium uppercase tracking-wide">Top Delivery Days</p>
          <p className="text-blue-800 text-xs">{topDays}</p>
        </div>
      )}
      <div className="col-span-2">
        <p className="text-[11px] text-blue-500 font-medium uppercase tracking-wide">Total Spend (invoiced)</p>
        <p className="font-semibold text-blue-900">{fmtMoney(stats.totalSpend)}</p>
      </div>
    </div>
  )
}

// ─── Invoice drill-down ───────────────────────────────────────────────────────

function InvoiceDetail({ invoiceId, onBack }: { invoiceId: number; onBack: () => void }) {
  const lines = useLiveQuery(
    () => getInvoiceLines(invoiceId),
    [invoiceId],
  )

  if (!lines) return <div className="p-4 text-sm text-gray-500">Loading…</div>

  // Group by delivery note
  const byNote = new Map<string, InvoiceLine[]>()
  for (const l of lines) {
    const arr = byNote.get(l.deliveryNoteNumber) ?? []
    arr.push(l)
    byNote.set(l.deliveryNoteNumber, arr)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-gray-200 flex items-center gap-2">
        <button onClick={onBack} className="text-blue-600 text-sm font-medium flex items-center gap-1">
          ← Back
        </button>
        <span className="text-gray-400">|</span>
        <span className="text-sm font-semibold text-gray-800">{lines.length} line items</span>
      </div>
      <div className="flex-1 overflow-auto">
        {[...byNote.entries()].map(([noteNum, noteLines]) => {
          const subTotal = noteLines.reduce((s, l) => s + l.extendedPrice, 0)
          const date = noteLines[0]?.deliveryDate ?? ''
          return (
            <div key={noteNum}>
              <div className="px-3 py-1.5 bg-gray-100 flex items-center justify-between sticky top-0">
                <span className="text-xs font-semibold text-gray-600">
                  Delivery {noteNum} — {fmt(date)}
                </span>
                <span className="text-xs text-gray-500">{fmtMoney(subTotal)}</span>
              </div>
              {noteLines.map((l, i) => (
                <div key={i} className="px-3 py-2 border-b border-gray-50 flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-800 truncate">{l.productName}</p>
                    <p className="text-xs text-gray-400">
                      #{parseInt(l.productCode, 10)} · {l.quantity} {l.unitType}
                      {l.lineDiscount ? ` · disc $${l.lineDiscount.toFixed(2)}` : ''}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-medium text-gray-800">{fmtMoney(l.extendedPrice)}</p>
                    <p className="text-xs text-gray-500">@ {fmtMoney(l.pricePerItem)}</p>
                  </div>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Invoice list ────────────────────────────────────────────────────────────

function InvoiceList({ onSelect }: { onSelect: (id: number, num: string) => void }) {
  const summaries = useLiveQuery<InvoiceSummary[]>(() => getInvoiceSummaries(), [])

  if (!summaries) return <div className="p-4 text-sm text-gray-500">Loading…</div>
  if (!summaries.length) {
    return (
      <div className="p-8 text-center text-gray-400 text-sm">
        <FileText size={32} className="mx-auto mb-2 text-gray-300" />
        No invoices imported yet.{'\n'}Go to Import → Lactalis Invoice to add one.
      </div>
    )
  }

  return (
    <div className="divide-y divide-gray-100">
      {summaries.map((s) => (
        <button
          key={s.id}
          onClick={() => onSelect(s.id, s.documentNumber)}
          className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-gray-50 active:bg-gray-100"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900">#{s.documentNumber}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${DOC_TYPE_BADGE[s.documentType]}`}>
                {DOC_TYPE_LABEL[s.documentType]}
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              {fmt(s.invoiceDate)} · {s.deliveryCount} {s.deliveryCount === 1 ? 'delivery' : 'deliveries'} · {s.lineCount} items
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-sm font-semibold text-gray-800">{fmtMoney(s.totalAmount)}</p>
            <ChevronRight size={14} className="text-gray-400 ml-auto mt-0.5" />
          </div>
        </button>
      ))}
    </div>
  )
}

// ─── Product stats list ───────────────────────────────────────────────────────

function ProductStatRow({ s }: { s: ProductStats }) {
  const [open, setOpen] = useState(false)

  const freqColor = s.frequencyPct >= 80
    ? 'text-green-700' : s.frequencyPct >= 50
      ? 'text-blue-700' : s.frequencyPct >= 25
        ? 'text-amber-700' : 'text-gray-500'

  return (
    <div className="border-b border-gray-100 last:border-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-3 py-2.5 flex items-start gap-2 hover:bg-gray-50"
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{s.productName}</p>
          <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-500 flex-wrap">
            <span className={`font-medium ${freqColor}`}>{s.frequencyPct.toFixed(0)}% freq</span>
            <span className="text-gray-300">·</span>
            <span>avg {s.avgQtyPerDelivery} · med {s.medianQtyPerDelivery}</span>
            <span className="text-gray-300">·</span>
            <span>@ {fmtMoney(s.latestCost)}</span>
            {s.priceChanges > 0 && (
              <span className="text-amber-600">↕{s.priceChanges} price change{s.priceChanges > 1 ? 's' : ''}</span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs font-semibold text-gray-700">{fmtMoney(s.totalSpend)}</p>
          <p className="text-[10px] text-gray-400">{s.deliveriesOrdered} orders</p>
          {open ? <ChevronUp size={13} className="ml-auto text-gray-400" /> : <ChevronDown size={13} className="ml-auto text-gray-400" />}
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 bg-gray-50 border-t border-gray-100">
          <div className="grid grid-cols-3 gap-2 mt-2 text-center">
            {[
              ['Min', s.minQty],
              ['Median', s.medianQtyPerDelivery],
              ['Max', s.maxQty],
            ].map(([label, val]) => (
              <div key={label} className="bg-white rounded-lg p-2 border border-gray-200">
                <p className="text-[10px] text-gray-500 uppercase">{label}</p>
                <p className="text-base font-semibold text-gray-800">{val}</p>
              </div>
            ))}
          </div>
          <div className="mt-2 space-y-0.5 max-h-32 overflow-auto">
            {s.deliveries.slice().reverse().map((d, i) => (
              <div key={i} className="flex justify-between text-xs text-gray-600">
                <span>{fmt(d.date)}</span>
                <span>×{d.qty} {d.unitType}</span>
                <span className="text-gray-500">@ {fmtMoney(d.cost)}</span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-gray-400 mt-1">
            First seen {fmt(s.firstSeen)} · Last seen {fmt(s.lastSeen)}
          </p>
        </div>
      )}
    </div>
  )
}

function ProductAnalysis() {
  const [data, setData] = useState<{ overall: OverallStats; products: ProductStats[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [updateMsg, setUpdateMsg] = useState('')
  const [search, setSearch] = useState('')

  async function load() {
    setLoading(true)
    const result = await analyzeHistory()
    setData(result)
    setLoading(false)
  }

  async function handleUpdateQtys() {
    setUpdating(true)
    const n = await updateDefaultQtysFromHistory()
    setUpdateMsg(`Updated default order qty for ${n} products from invoice medians`)
    setUpdating(false)
    // Reload stats
    const result = await analyzeHistory()
    setData(result)
  }

  if (!data && !loading) {
    return (
      <div className="p-6 text-center">
        <BarChart2 size={36} className="mx-auto mb-3 text-gray-300" />
        <p className="text-sm text-gray-500 mb-4">
          Analyse invoice history to see per-product stats, delivery patterns, and pricing trends.
        </p>
        <button
          onClick={load}
          className="px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg"
        >
          Analyse History
        </button>
      </div>
    )
  }

  if (loading) return <div className="p-6 text-center text-sm text-gray-500">Analysing…</div>

  if (!data) return null

  const filtered = search
    ? data.products.filter(
        (p) =>
          p.productName.toLowerCase().includes(search.toLowerCase()) ||
          p.itemNumber.includes(search),
      )
    : data.products

  return (
    <div className="flex flex-col h-full">
      {/* Stats bar */}
      <div className="px-3 pt-3">
        <StatsBar stats={data.overall} />
      </div>

      {/* Update qty button */}
      <div className="px-3 pt-2">
        <button
          onClick={handleUpdateQtys}
          disabled={updating}
          className="w-full flex items-center justify-center gap-2 border border-blue-300 text-blue-700 text-xs font-medium py-1.5 rounded-lg disabled:opacity-50"
        >
          <RefreshCw size={12} className={updating ? 'animate-spin' : ''} />
          {updating ? 'Updating…' : 'Update Default Qtys from Invoice Medians'}
        </button>
        {updateMsg && <p className="text-xs text-green-700 mt-1 text-center">{updateMsg}</p>}
      </div>

      {/* Product search */}
      <div className="px-3 pt-2 pb-1">
        <input
          type="search"
          placeholder="Filter products…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
        />
        <p className="text-[11px] text-gray-400 mt-1">
          {filtered.length} products · sorted by total spend
        </p>
      </div>

      {/* Product list */}
      <div className="flex-1 overflow-auto border-t border-gray-100 mt-1">
        {filtered.map((s) => (
          <ProductStatRow key={s.productCode} s={s} />
        ))}
        {filtered.length === 0 && (
          <p className="p-6 text-center text-sm text-gray-400">No products match</p>
        )}
      </div>
    </div>
  )
}

// ─── Main HistoryTab ──────────────────────────────────────────────────────────

type View = 'invoices' | 'analysis'

export default function HistoryTab() {
  const [view, setView] = useState<View>('invoices')
  const [selectedInvoice, setSelectedInvoice] = useState<{ id: number; num: string } | null>(null)

  // Invoice drill-down
  if (selectedInvoice) {
    return (
      <div className="flex flex-col h-full">
        <InvoiceDetail
          invoiceId={selectedInvoice.id}
          onBack={() => setSelectedInvoice(null)}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Sub-tabs */}
      <div className="flex border-b border-gray-200 bg-white shrink-0">
        {([
          ['invoices', FileText, 'Invoices'],
          ['analysis', TrendingUp, 'Analysis'],
        ] as const).map(([id, Icon, label]) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium transition-colors border-b-2 ${
              view === id
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        {view === 'invoices' && (
          <InvoiceList onSelect={(id, num) => setSelectedInvoice({ id, num })} />
        )}
        {view === 'analysis' && <ProductAnalysis />}
      </div>
    </div>
  )
}
