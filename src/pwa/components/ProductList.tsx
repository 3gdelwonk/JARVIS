import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ChevronDown, ChevronUp, ExternalLink, Search } from 'lucide-react'
import { db } from '../lib/db'
import type { Product, StockSnapshot } from '../lib/types'

// Money helper — avoids floating point errors
const money = (val: number) => Math.round(val * 100) / 100

function calcMargin(sellPrice: number, costPrice: number): string {
  if (sellPrice <= 0) return '—'
  return ((sellPrice - costPrice) / sellPrice * 100).toFixed(1)
}

const FREQUENCY_LABELS: Record<string, string> = {
  every: 'Every',
  most: 'Most',
  some: 'Some',
  occasional: 'Occ.',
}

const FREQUENCY_COLORS: Record<string, string> = {
  every: 'bg-green-100 text-green-800',
  most: 'bg-blue-100 text-blue-800',
  some: 'bg-yellow-100 text-yellow-800',
  occasional: 'bg-gray-100 text-gray-600',
}

const CATEGORY_ORDER = ['fresh', 'flavoured', 'uht', 'specialty'] as const
const CATEGORY_LABELS: Record<string, string> = {
  fresh: 'Fresh Milk',
  flavoured: 'Flavoured Milk',
  uht: 'UHT / Longlife',
  specialty: 'Specialty',
}

interface EditState {
  minStockLevel: string
  defaultOrderQty: string
  targetDaysOfStock: string
  sellPrice: string
}

function ProductRow({ product, qoh }: { product: Product; qoh: number | null }) {
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [edit, setEdit] = useState<EditState>({
    minStockLevel: String(product.minStockLevel),
    defaultOrderQty: String(product.defaultOrderQty),
    targetDaysOfStock: String(product.targetDaysOfStock),
    sellPrice: String(product.sellPrice),
  })

  const margin = calcMargin(product.sellPrice, money(product.lactalisCostPrice))
  const marginNum = product.sellPrice > 0
    ? (product.sellPrice - product.lactalisCostPrice) / product.sellPrice * 100
    : null
  const marginColor = marginNum === null
    ? 'text-gray-400'
    : marginNum < 20
      ? 'text-red-600 font-semibold'
      : marginNum < 28
        ? 'text-amber-600'
        : 'text-green-700'

  const freqKey = product.orderFrequency ?? 'some'

  // Sync edit fields when product data changes externally (live query update),
  // but only while the panel is closed — don't clobber an in-progress edit.
  useEffect(() => {
    if (!expanded) {
      setEdit({
        minStockLevel: String(product.minStockLevel),
        defaultOrderQty: String(product.defaultOrderQty),
        targetDaysOfStock: String(product.targetDaysOfStock),
        sellPrice: String(product.sellPrice),
      })
    }
  }, [product, expanded])

  async function handleSave() {
    // L5 — warn if sell price changes by more than 20%
    const newSell = money(Number(edit.sellPrice) || 0)
    const oldSell = product.sellPrice
    if (oldSell > 0 && newSell > 0) {
      const changePct = Math.abs(newSell - oldSell) / oldSell * 100
      if (changePct > 20) {
        const ok = window.confirm(
          `Sell price changing from $${oldSell.toFixed(2)} to $${newSell.toFixed(2)} (${changePct.toFixed(0)}% change). Continue?`
        )
        if (!ok) return
      }
    }

    setSaving(true)
    try {
      await db.products.update(product.id!, {
        minStockLevel: Number(edit.minStockLevel) || 0,
        defaultOrderQty: Number(edit.defaultOrderQty) || 0,
        targetDaysOfStock: Number(edit.targetDaysOfStock) || 4,
        sellPrice: newSell,
        updatedAt: new Date(),
      })
      setExpanded(false)
    } catch (err) {
      console.error('Failed to save product:', err)
    } finally {
      setSaving(false)
    }
  }

  function verifyItemNumber() {
    window.open('https://www.lactalis.com.au', '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="border-b border-gray-100 last:border-0">
      {/* Row */}
      <button
        className="w-full text-left px-3 py-2.5 flex items-start gap-2 active:bg-gray-50"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-900 truncate">{product.name}</span>
            {product.isGstBearing && (
              <span className="text-[10px] px-1 py-0.5 bg-purple-100 text-purple-700 rounded">GST</span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-xs text-gray-500">#{product.itemNumber}</span>
            <span className="text-xs text-gray-400">·</span>
            <span className="text-xs text-gray-600">Cost ${product.lactalisCostPrice.toFixed(2)}</span>
            <span className="text-xs text-gray-400">·</span>
            <span className="text-xs text-gray-600">
              Sell {product.sellPrice > 0 ? `$${product.sellPrice.toFixed(2)}` : '—'}
            </span>
            <span className="text-xs text-gray-400">·</span>
            <span className={`text-xs ${marginColor}`}>{margin}%</span>
            <span className="text-xs text-gray-400">·</span>
            <span className="text-xs text-gray-500">QOH {qoh !== null ? qoh : '—'}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${FREQUENCY_COLORS[freqKey] ?? FREQUENCY_COLORS.some}`}>
            {FREQUENCY_LABELS[freqKey] ?? freqKey}
          </span>
          {expanded ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
        </div>
      </button>

      {/* Expanded edit panel */}
      {expanded && (
        <div className="px-3 pb-3 bg-gray-50 border-t border-gray-100">
          <div className="grid grid-cols-2 gap-2 mt-2">
            <div className="flex flex-col gap-0.5">
              <label htmlFor={`min-stock-${product.id}`} className="text-[11px] text-gray-500 font-medium">Min Stock Level</label>
              <input
                id={`min-stock-${product.id}`}
                type="number"
                min="0"
                value={edit.minStockLevel}
                onChange={(e) => setEdit((s) => ({ ...s, minStockLevel: e.target.value }))}
                className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <label htmlFor={`default-qty-${product.id}`} className="text-[11px] text-gray-500 font-medium">Default Order Qty</label>
              <input
                id={`default-qty-${product.id}`}
                type="number"
                min="0"
                value={edit.defaultOrderQty}
                onChange={(e) => setEdit((s) => ({ ...s, defaultOrderQty: e.target.value }))}
                className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <label htmlFor={`target-days-${product.id}`} className="text-[11px] text-gray-500 font-medium">Target Days of Stock</label>
              <input
                id={`target-days-${product.id}`}
                type="number"
                min="1"
                value={edit.targetDaysOfStock}
                onChange={(e) => setEdit((s) => ({ ...s, targetDaysOfStock: e.target.value }))}
                className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <label htmlFor={`sell-price-${product.id}`} className="text-[11px] text-gray-500 font-medium">Sell Price ($)</label>
              <input
                id={`sell-price-${product.id}`}
                type="number"
                min="0"
                step="0.01"
                value={edit.sellPrice}
                onChange={(e) => setEdit((s) => ({ ...s, sellPrice: e.target.value }))}
                className="border border-gray-300 rounded px-2 py-1 text-sm w-full"
              />
            </div>
          </div>

          <div className="flex gap-2 mt-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 bg-blue-600 text-white text-sm font-medium py-1.5 rounded disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={verifyItemNumber}
              className="flex items-center gap-1 px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-700"
            >
              <ExternalLink size={13} />
              Verify #{product.itemNumber}
            </button>
            <button
              onClick={() => setExpanded(false)}
              className="px-3 py-1.5 text-sm text-gray-500"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function ProductList() {
  const [search, setSearch] = useState('')

  const products = useLiveQuery(() => db.products.toArray(), [])
  const stockMap = useLiveQuery(async () => {
    const snapshots = await db.stockSnapshots.toArray()
    const latest = new Map<number, StockSnapshot>()
    for (const s of snapshots) {
      const prev = latest.get(s.productId)
      if (!prev || new Date(s.importedAt).getTime() > new Date(prev.importedAt).getTime()) {
        latest.set(s.productId, s)
      }
    }
    const map = new Map<number, number>()
    for (const [pid, snap] of latest) map.set(pid, snap.qoh)
    return map
  }, [])

  if (!products) {
    return <div className="p-4 text-gray-500 text-sm">Loading products…</div>
  }

  const query = search.trim().toLowerCase()
  const filtered = query
    ? products.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.itemNumber.includes(query) ||
          p.invoiceCode.includes(query),
      )
    : products

  const grouped = CATEGORY_ORDER.reduce<Record<string, Product[]>>((acc, cat) => {
    const items = filtered.filter((p) => p.category === cat)
    if (items.length) acc[cat] = items
    return acc
  }, {})

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="px-3 py-2 border-b border-gray-200 bg-white sticky top-0 z-10">
        <div className="relative">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            placeholder="Search by name or item number…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 border border-gray-300 rounded-lg text-sm"
          />
        </div>
        <p className="text-[11px] text-gray-500 mt-1">{filtered.length} of {products.length} products</p>
      </div>

      {/* Product list */}
      <div className="flex-1 overflow-auto">
        {Object.entries(grouped).map(([cat, items]) => (
          <div key={cat}>
            <div className="px-3 py-1.5 bg-gray-100 sticky top-0 z-10 flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                {CATEGORY_LABELS[cat]}
              </span>
              <span className="text-xs text-gray-500">{items.length} SKUs</span>
            </div>
            {items.map((p) => (
              <ProductRow key={p.id} product={p} qoh={stockMap?.get(p.id!) ?? null} />
            ))}
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="p-8 text-center text-gray-400 text-sm">
            No products match "{search}"
          </div>
        )}
      </div>
    </div>
  )
}
