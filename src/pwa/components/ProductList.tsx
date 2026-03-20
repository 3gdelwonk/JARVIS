import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ChevronDown, ChevronUp, ExternalLink, ImageOff, RefreshCw, Search } from 'lucide-react'
import { db, backfillBakedImages } from '../lib/db'
import { PRODUCT_IMAGE_MAP } from '../data/productImageMap'
import { round2, calcMarginPct } from '../lib/constants'
import type { Product, StockSnapshot } from '../lib/types'

const money = round2

function calcMargin(sellPrice: number, costPrice: number): string {
  const pct = calcMarginPct(sellPrice, costPrice)
  return pct === null ? '—' : pct.toFixed(1)
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

type DeptFilter = 'all' | 'dairy' | 'liquor' | 'general'

interface EditState {
  minStockLevel: string
  maxStockLevel: string
  defaultOrderQty: string
  targetDaysOfStock: string
  sellPrice: string
}

function StockGauge({ qoh, min, max }: { qoh: number | null; min: number; max?: number }) {
  if (qoh === null || (min === 0 && !max)) return null
  const pct = max && max > 0
    ? Math.min(100, (qoh / max) * 100)
    : min > 0 ? Math.min(100, (qoh / (min * 2)) * 100) : 0
  const color = max && max > 0
    ? qoh < min ? 'bg-red-400' : qoh > max ? 'bg-amber-400' : 'bg-green-400'
    : qoh < min ? 'bg-red-400' : 'bg-green-400'
  return (
    <div className="mt-1 h-1 bg-gray-200 rounded-full overflow-hidden" title={`QOH ${qoh} / min ${min}${max ? ` / max ${max}` : ''}`}>
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function ProductRow({ product, qoh }: { product: Product; qoh: number | null }) {
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [edit, setEdit] = useState<EditState>({
    minStockLevel: String(product.minStockLevel),
    maxStockLevel: String(product.maxStockLevel ?? ''),
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
        maxStockLevel: String(product.maxStockLevel ?? ''),
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
      const maxStock = edit.maxStockLevel.trim() !== '' ? Number(edit.maxStockLevel) || undefined : undefined
      await db.products.update(product.id!, {
        minStockLevel: Number(edit.minStockLevel) || 0,
        maxStockLevel: maxStock,
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
        {/* Product image thumbnail */}
        <div className="relative w-10 h-10 rounded-lg overflow-hidden bg-gray-100 shrink-0 flex items-center justify-center">
          <ImageOff size={14} className="text-gray-300" />
          {product.imageUrl && (
            <img src={product.imageUrl} alt={product.name} className="absolute inset-0 w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          )}
        </div>
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
          <StockGauge qoh={qoh} min={product.minStockLevel} max={product.maxStockLevel} />
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
              <label htmlFor={`max-stock-${product.id}`} className="text-[11px] text-gray-500 font-medium">Max Stock Level</label>
              <input
                id={`max-stock-${product.id}`}
                type="number"
                min="0"
                placeholder="optional"
                value={edit.maxStockLevel}
                onChange={(e) => setEdit((s) => ({ ...s, maxStockLevel: e.target.value }))}
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

async function fetchImagesFromOpenFoodFacts(products: Product[]) {
  let matched = 0
  let skipped = 0
  for (const p of products) {
    if (!p.barcode || p.barcode.length < 8) continue
    // Never overwrite baked-in Lactalis images
    if (PRODUCT_IMAGE_MAP[p.itemNumber]) continue
    const url = `https://world.openfoodfacts.org/api/v0/product/${p.barcode}.json`
    let json: Record<string, unknown> | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
        if (!res.ok) break
        json = await res.json()
        break
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1000))
        else skipped++
      }
    }
    if (json) {
      const imageUrl: string | undefined =
        (json as { product?: { image_front_url?: string; image_url?: string; image_front_small_url?: string } })?.product?.image_front_url ||
        (json as { product?: { image_url?: string } })?.product?.image_url ||
        (json as { product?: { image_front_small_url?: string } })?.product?.image_front_small_url
      if (imageUrl) {
        try {
          const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) })
          const blob = await imgRes.blob()
          // Compress to 96x96 JPEG thumbnail to reduce IndexedDB storage
          const base64 = await new Promise<string>((resolve, reject) => {
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload = () => {
              const canvas = document.createElement('canvas')
              canvas.width = 96
              canvas.height = 96
              const ctx = canvas.getContext('2d')!
              ctx.drawImage(img, 0, 0, 96, 96)
              resolve(canvas.toDataURL('image/jpeg', 0.7))
              URL.revokeObjectURL(img.src)
            }
            img.onerror = reject
            img.src = URL.createObjectURL(blob)
          })
          await db.products.update(p.id!, { imageUrl: base64 })
          matched++
        } catch {
          skipped++
        }
      }
    }
    // Rate-limit delay between requests
    await new Promise((r) => setTimeout(r, 250))
  }
  return { matched, skipped, total: products.length }
}

export default function ProductList() {
  const [search, setSearch] = useState('')
  const [deptFilter, setDeptFilter] = useState<DeptFilter>('all')
  const [fetchingImages, setFetchingImages] = useState(false)
  const [fetchMsg, setFetchMsg] = useState('')

  // Auto-recover missing images on mount (only for products without baked-in images)
  useEffect(() => {
    db.products
      .filter((p) => p.active !== false && !p.imageUrl && !PRODUCT_IMAGE_MAP[p.itemNumber] && !!p.barcode && p.barcode.length >= 8)
      .toArray()
      .then((missing) => {
        if (missing.length > 0) fetchImagesFromOpenFoodFacts(missing)
      })
  }, [])

  async function handleResetImages() {
    setFetchingImages(true)
    setFetchMsg('')
    await backfillBakedImages()
    setFetchMsg('Images restored')
    setFetchingImages(false)
  }

  async function handleFetchImages(products: Product[]) {
    setFetchingImages(true)
    setFetchMsg('')
    const withBarcodes = products.filter((p) => p.barcode && p.barcode.length >= 8 && !PRODUCT_IMAGE_MAP[p.itemNumber])
    const { matched, skipped, total } = await fetchImagesFromOpenFoodFacts(withBarcodes)
    setFetchMsg(`${matched} / ${total} found${skipped > 0 ? `, ${skipped} skipped` : ''}`)
    setFetchingImages(false)
  }

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
  const filtered = products.filter((p) => {
    const matchQuery = !query ||
      p.name.toLowerCase().includes(query) ||
      p.itemNumber.includes(query) ||
      p.invoiceCode.includes(query)
    const matchDept = deptFilter === 'all' || (p.department ?? 'dairy') === deptFilter
    return matchQuery && matchDept
  })

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
        {/* Department filter */}
        <div className="flex gap-1.5 mt-1.5 overflow-x-auto pb-0.5">
          {(['all', 'dairy', 'liquor', 'general'] as const).map((dept) => (
            <button
              key={dept}
              onClick={() => setDeptFilter(dept)}
              className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium shrink-0 transition-colors ${
                deptFilter === dept
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {dept === 'all' ? 'All' : dept.charAt(0).toUpperCase() + dept.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between mt-1">
          <p className="text-[11px] text-gray-500">{filtered.length} of {products.length} products</p>
          <div className="flex items-center gap-2">
            <button
              onClick={handleResetImages}
              disabled={fetchingImages}
              className="text-[11px] text-gray-500 disabled:text-gray-400"
              title="Restore baked-in Lactalis product images"
            >
              Reset Images
            </button>
            <button
              onClick={() => handleFetchImages(products)}
              disabled={fetchingImages}
              className="flex items-center gap-1 text-[11px] text-blue-600 disabled:text-gray-400"
              title="Fetch images for new products without baked-in images"
            >
              <RefreshCw size={10} className={fetchingImages ? 'animate-spin' : ''} />
              {fetchingImages ? 'Fetching…' : fetchMsg || 'Fetch New'}
            </button>
          </div>
        </div>
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
