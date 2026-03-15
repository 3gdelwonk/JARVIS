/**
 * ScannerTab.tsx
 *
 * Two modes:
 *  A — Invoice Scanner: photograph a Lactalis invoice → Claude Vision parses → updates stock
 *  B — Waste Scanner:   photograph thrown-out products → Claude Vision identifies → log waste
 */

import { useRef, useState } from 'react'
import Anthropic from '@anthropic-ai/sdk'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Key,
  Minus,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { db } from '../lib/db'
import type { WasteEntry } from '../lib/types'

const API_KEY_STORAGE = 'milk-manager-api-key'

// ─── Prompts ──────────────────────────────────────────────────────────────────

const INVOICE_PARSE_PROMPT = `This is a Lactalis dairy product invoice for an Australian supermarket.
Extract all product line items. Return ONLY valid JSON:
{
  "documentNumber": "string",
  "deliveryDate": "YYYY-MM-DD",
  "lines": [
    { "productCode": "string", "productName": "string",
      "quantity": number, "unitType": "EA or CTN",
      "unitPrice": number, "extendedPrice": number }
  ]
}
Use null for any field not visible. Delivery date must be YYYY-MM-DD.`

const WASTE_PARSE_PROMPT = `This is a photo of dairy/milk products being thrown out or discarded in a supermarket.
Identify all visible products. Return ONLY valid JSON:
{
  "items": [
    { "productName": "string", "brand": "string or null",
      "productCode": "string or null", "estimatedQuantity": number }
  ]
}
Be conservative — only list products you can clearly identify. estimatedQuantity is visible units.`

// ─── Types ────────────────────────────────────────────────────────────────────

interface ParsedInvoiceLine {
  productCode: string | null
  productName: string | null
  quantity: number
  unitType: string | null
  unitPrice: number
  extendedPrice: number
  matchedProductId?: number
  matchedProductName?: string
}

interface ParsedInvoice {
  documentNumber: string | null
  deliveryDate: string | null
  lines: ParsedInvoiceLine[]
}

interface ParsedWasteItem {
  productName: string
  brand: string | null
  productCode: string | null
  estimatedQuantity: number
  matchedProductId?: number
  matchedProductName?: string
}

interface StagedWasteEntry {
  productName: string
  productId?: number
  qty: number
  reason: 'expired' | 'damaged' | 'other'
  wastedDate: string
}

// ─── API key gate ─────────────────────────────────────────────────────────────

function ApiKeySetup({ onSave }: { onSave: (key: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-4">
      <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center">
        <Key size={22} className="text-blue-600" />
      </div>
      <div>
        <p className="text-sm font-semibold text-gray-900">Enter your Anthropic API Key</p>
        <p className="text-xs text-gray-500 mt-1">
          Required for photo scanning. Stored only in this browser.
        </p>
      </div>
      <input
        type="password"
        placeholder="sk-ant-..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
      />
      <button
        onClick={() => { if (value.trim()) onSave(value.trim()) }}
        disabled={!value.trim()}
        className="w-full bg-blue-600 text-white text-sm font-medium py-2.5 rounded-xl disabled:opacity-40"
      >
        Save Key
      </button>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().split('T')[0]
}

async function imageToBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const [header, base64] = result.split(',')
      const mediaType = header.match(/data:(.*);/)?.[1] ?? 'image/jpeg'
      resolve({ base64, mediaType })
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ─── Invoice Scanner (Mode A) ─────────────────────────────────────────────────

function InvoiceScanner({ apiKey }: { apiKey: string }) {
  const [image, setImage] = useState<File | null>(null)
  const [preview, setPreview] = useState('')
  const [parsing, setParsing] = useState(false)
  const [parsed, setParsed] = useState<ParsedInvoice | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [savedCount, setSavedCount] = useState<number | null>(null)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const products = useLiveQuery(() => db.products.toArray(), [])

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImage(file)
    setPreview(URL.createObjectURL(file))
    setParsed(null)
    setError('')
    setSavedCount(null)
  }

  async function handleParse() {
    if (!image || !products) return
    setParsing(true)
    setError('')
    try {
      const { base64, mediaType } = await imageToBase64(image)
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
      const response = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: base64 } },
            { type: 'text', text: INVOICE_PARSE_PROMPT },
          ],
        }],
      })
      const text = response.content[0].type === 'text' ? response.content[0].text : ''
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('No JSON in response')
      const result: ParsedInvoice = JSON.parse(jsonMatch[0])

      // Match lines to products
      const productsByCode = new Map(products.map((p) => [p.invoiceCode.replace(/^0+/, ''), p]))
      result.lines = result.lines.map((line) => {
        const code = (line.productCode ?? '').replace(/^0+/, '')
        const match = productsByCode.get(code)
        return match
          ? { ...line, matchedProductId: match.id, matchedProductName: match.name }
          : line
      })
      setParsed(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Parse failed')
    } finally {
      setParsing(false)
    }
  }

  async function handleConfirm() {
    if (!parsed) return
    setConfirming(true)
    let saved = 0
    try {
      // Insert invoice record
      const invoiceId = (await db.invoiceRecords.add({
        documentNumber: parsed.documentNumber ?? `SCAN-${Date.now()}`,
        documentType: 'invoice',
        dateOrdered: parsed.deliveryDate ?? todayStr(),
        invoiceDate: parsed.deliveryDate ?? todayStr(),
        totalAmount: parsed.lines.reduce((s, l) => s + (l.extendedPrice ?? 0), 0),
        parsedAt: new Date(),
      })) as number

      // Insert lines + update stock
      for (const line of parsed.lines) {
        await db.invoiceLines.add({
          invoiceRecordId: invoiceId,
          deliveryNoteNumber: '',
          deliveryDate: parsed.deliveryDate ?? todayStr(),
          purchaseOrderNumber: '',
          productCode: line.productCode ?? '',
          productName: line.productName ?? '',
          quantity: line.quantity,
          unitType: (line.unitType as 'EA' | 'CTN') ?? 'EA',
          listPrice: line.unitPrice,
          extendedPrice: line.extendedPrice,
          pricePerItem: line.unitPrice,
        })

        if (line.matchedProductId) {
          // Get latest QOH
          const snapshots = await db.stockSnapshots
            .where('productId').equals(line.matchedProductId)
            .toArray()
          const latest = snapshots.sort(
            (a, b) => new Date(b.importedAt).getTime() - new Date(a.importedAt).getTime()
          )[0]
          const prevQoh = latest?.qoh ?? 0

          await db.stockSnapshots.add({
            productId: line.matchedProductId,
            barcode: '',
            qoh: prevQoh + line.quantity,
            importedAt: new Date(),
            source: 'item_stock_report',
            importBatchId: `scanner-${invoiceId}`,
          })
          saved++
        }
      }
      setSavedCount(saved)
      setParsed(null)
      setImage(null)
      setPreview('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setConfirming(false)
    }
  }

  function reset() {
    setImage(null)
    setPreview('')
    setParsed(null)
    setError('')
    setSavedCount(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  if (savedCount !== null) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-12 px-6 text-center">
        <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
          <CheckCircle2 size={28} className="text-green-600" />
        </div>
        <p className="text-base font-semibold text-gray-900">Invoice saved!</p>
        <p className="text-sm text-gray-500">{savedCount} product stocks updated</p>
        <button onClick={reset} className="mt-2 bg-blue-600 text-white text-sm font-medium px-6 py-2.5 rounded-xl">
          Scan Another
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Photo capture */}
      <input ref={fileRef} type="file" accept="image/*" capture="environment"
        className="hidden" onChange={handleFile} />

      {!preview ? (
        <button
          onClick={() => fileRef.current?.click()}
          className="w-full h-36 rounded-2xl border-2 border-dashed border-blue-300 bg-blue-50 flex flex-col items-center justify-center gap-2 text-blue-600"
        >
          <Camera size={28} />
          <span className="text-sm font-medium">Take Photo of Invoice</span>
        </button>
      ) : (
        <div className="relative">
          <img src={preview} alt="Invoice" className="w-full rounded-2xl object-contain max-h-48" />
          <button onClick={reset} className="absolute top-2 right-2 bg-black/50 text-white rounded-full p-1">
            <X size={14} />
          </button>
        </div>
      )}

      {preview && !parsed && (
        <button
          onClick={handleParse}
          disabled={parsing}
          className="w-full bg-blue-600 text-white text-sm font-semibold py-3 rounded-xl disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {parsing && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
          {parsing ? 'Parsing Invoice…' : 'Parse Invoice'}
        </button>
      )}

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-100 rounded-xl px-3 py-2.5">
          <AlertCircle size={14} className="text-red-500 mt-0.5 shrink-0" />
          <p className="text-xs text-red-600">{error}</p>
        </div>
      )}

      {parsed && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              {parsed.lines.length} lines parsed
            </p>
            {parsed.documentNumber && (
              <span className="text-[11px] text-gray-400">#{parsed.documentNumber}</span>
            )}
          </div>

          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            {parsed.lines.map((line, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-2 border-b border-gray-50 last:border-0">
                {line.matchedProductId
                  ? <CheckCircle2 size={13} className="text-green-500 shrink-0" />
                  : <AlertCircle size={13} className="text-amber-400 shrink-0" />
                }
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800 truncate">
                    {line.matchedProductName ?? line.productName ?? 'Unknown'}
                  </p>
                  <p className="text-[11px] text-gray-400">
                    {line.productCode} · {line.unitType} · ${line.unitPrice?.toFixed(2)}
                  </p>
                </div>
                <span className="text-sm font-semibold text-gray-700 shrink-0">×{line.quantity}</span>
              </div>
            ))}
          </div>

          <button
            onClick={handleConfirm}
            disabled={confirming}
            className="w-full bg-green-600 text-white text-sm font-semibold py-3 rounded-xl disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {confirming && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            {confirming ? 'Saving…' : 'Confirm & Update Stock'}
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Waste Scanner (Mode B) ───────────────────────────────────────────────────

function WasteScanner({ apiKey }: { apiKey: string }) {
  const [image, setImage] = useState<File | null>(null)
  const [preview, setPreview] = useState('')
  const [parsing, setParsing] = useState(false)
  const [parsedItems, setParsedItems] = useState<ParsedWasteItem[] | null>(null)
  const [reviewItems, setReviewItems] = useState<StagedWasteEntry[]>([])
  const [sessionLog, setSessionLog] = useState<StagedWasteEntry[]>([])
  const [saving, setSaving] = useState(false)
  const [savedCount, setSavedCount] = useState<number | null>(null)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const products = useLiveQuery(() => db.products.toArray(), [])

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImage(file)
    setPreview(URL.createObjectURL(file))
    setParsedItems(null)
    setReviewItems([])
    setError('')
    if (fileRef.current) fileRef.current.value = ''
  }

  async function handleIdentify() {
    if (!image || !products) return
    setParsing(true)
    setError('')
    try {
      const { base64, mediaType } = await imageToBase64(image)
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
      const response = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: base64 } },
            { type: 'text', text: WASTE_PARSE_PROMPT },
          ],
        }],
      })
      const text = response.content[0].type === 'text' ? response.content[0].text : ''
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('No JSON in response')
      const result: { items: ParsedWasteItem[] } = JSON.parse(jsonMatch[0])

      // Match to DB products
      const productsByName = products.map((p) => ({ id: p.id!, name: p.name.toLowerCase() }))
      const matched = result.items.map((item) => {
        const nameLower = item.productName.toLowerCase()
        const match = productsByName.find(
          (p) => p.name.includes(nameLower) || nameLower.includes(p.name.split(' ').slice(0, 2).join(' ').toLowerCase())
        )
        return match ? { ...item, matchedProductId: match.id, matchedProductName: products.find(p => p.id === match.id)?.name } : item
      })
      setParsedItems(matched)
      setReviewItems(matched.map((item) => ({
        productName: item.matchedProductName ?? item.productName,
        productId: item.matchedProductId,
        qty: item.estimatedQuantity > 0 ? item.estimatedQuantity : 1,
        reason: 'expired' as const,
        wastedDate: todayStr(),
      })))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Identify failed')
    } finally {
      setParsing(false)
    }
  }

  function updateReviewItem(i: number, patch: Partial<StagedWasteEntry>) {
    setReviewItems((prev) => prev.map((item, idx) => idx === i ? { ...item, ...patch } : item))
  }

  function removeReviewItem(i: number) {
    setReviewItems((prev) => prev.filter((_, idx) => idx !== i))
  }

  function addToSession() {
    setSessionLog((prev) => [...prev, ...reviewItems])
    setImage(null)
    setPreview('')
    setParsedItems(null)
    setReviewItems([])
    setSavedCount(null)
  }

  async function logAllWaste() {
    if (sessionLog.length === 0) return
    setSaving(true)
    try {
      for (const entry of sessionLog) {
        const wasteEntry: WasteEntry = {
          productId: entry.productId ?? 0,
          productName: entry.productName,
          quantity: entry.qty,
          wastedDate: entry.wastedDate,
          reason: entry.reason,
        }
        await db.wasteLog.add(wasteEntry)

        // Decrement matching active expiry batch if product is known
        if (entry.productId) {
          const batches = await db.expiryBatches
            .where('productId').equals(entry.productId)
            .filter((b) => b.status === 'active')
            .toArray()
          let remaining = entry.qty
          for (const batch of batches.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))) {
            if (remaining <= 0) break
            const deduct = Math.min(batch.quantity, remaining)
            const newQty = batch.quantity - deduct
            await db.expiryBatches.update(batch.id!, {
              quantity: newQty,
              status: newQty <= 0 ? 'wasted' : 'active',
            })
            remaining -= deduct
          }
        }
      }
      setSavedCount(sessionLog.length)
      setSessionLog([])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (savedCount !== null) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-12 px-6 text-center">
        <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
          <CheckCircle2 size={28} className="text-green-600" />
        </div>
        <p className="text-base font-semibold text-gray-900">Waste logged!</p>
        <p className="text-sm text-gray-500">{savedCount} entries saved</p>
        <button
          onClick={() => setSavedCount(null)}
          className="mt-2 bg-blue-600 text-white text-sm font-medium px-6 py-2.5 rounded-xl"
        >
          Log More
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Session counter */}
      {sessionLog.length > 0 && (
        <div className="bg-amber-50 border border-amber-100 rounded-xl px-3 py-2 flex items-center justify-between">
          <p className="text-xs text-amber-700 font-medium">{sessionLog.length} items staged</p>
          <button
            onClick={logAllWaste}
            disabled={saving}
            className="text-xs bg-amber-500 text-white px-3 py-1.5 rounded-lg font-medium disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Log All Waste'}
          </button>
        </div>
      )}

      {/* Photo capture */}
      <input ref={fileRef} type="file" accept="image/*" capture="environment"
        className="hidden" onChange={handleFile} />

      {!preview ? (
        <button
          onClick={() => fileRef.current?.click()}
          className="w-full h-36 rounded-2xl border-2 border-dashed border-red-300 bg-red-50 flex flex-col items-center justify-center gap-2 text-red-500"
        >
          <Camera size={28} />
          <span className="text-sm font-medium">Photo Thrown-Out Products</span>
        </button>
      ) : (
        <div className="relative">
          <img src={preview} alt="Products" className="w-full rounded-2xl object-contain max-h-48" />
          <button onClick={() => { setImage(null); setPreview(''); setParsedItems(null); setReviewItems([]) }}
            className="absolute top-2 right-2 bg-black/50 text-white rounded-full p-1">
            <X size={14} />
          </button>
        </div>
      )}

      {preview && !parsedItems && (
        <button
          onClick={handleIdentify}
          disabled={parsing}
          className="w-full bg-red-600 text-white text-sm font-semibold py-3 rounded-xl disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {parsing && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
          {parsing ? 'Identifying Products…' : 'Identify Products'}
        </button>
      )}

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-100 rounded-xl px-3 py-2.5">
          <AlertCircle size={14} className="text-red-500 mt-0.5 shrink-0" />
          <p className="text-xs text-red-600">{error}</p>
        </div>
      )}

      {/* Review items from this photo */}
      {parsedItems && reviewItems.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            {parsedItems.length} products identified — adjust & add
          </p>

          {reviewItems.map((item, i) => (
            <div key={i} className="bg-white border border-gray-100 rounded-xl p-3 flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    {parsedItems[i]?.matchedProductId
                      ? <CheckCircle2 size={12} className="text-green-500 shrink-0" />
                      : <AlertCircle size={12} className="text-amber-400 shrink-0" />
                    }
                    <p className="text-sm font-medium text-gray-900 truncate">{item.productName}</p>
                  </div>
                </div>
                <button onClick={() => removeReviewItem(i)} className="p-1 text-gray-300 hover:text-red-400">
                  <Trash2 size={13} />
                </button>
              </div>

              <div className="flex items-center gap-3">
                {/* Qty stepper */}
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => updateReviewItem(i, { qty: Math.max(1, item.qty - 1) })}
                    className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-gray-600"
                  >
                    <Minus size={12} />
                  </button>
                  <span className="w-8 text-center text-sm font-semibold text-gray-900">{item.qty}</span>
                  <button
                    onClick={() => updateReviewItem(i, { qty: item.qty + 1 })}
                    className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-gray-600"
                  >
                    <Plus size={12} />
                  </button>
                </div>

                {/* Reason */}
                <select
                  value={item.reason}
                  onChange={(e) => updateReviewItem(i, { reason: e.target.value as StagedWasteEntry['reason'] })}
                  className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5"
                >
                  <option value="expired">Expired</option>
                  <option value="damaged">Damaged</option>
                  <option value="other">Other</option>
                </select>

                {/* Date */}
                <input
                  type="date"
                  value={item.wastedDate}
                  onChange={(e) => updateReviewItem(i, { wastedDate: e.target.value })}
                  className="text-xs border border-gray-200 rounded-lg px-2 py-1.5"
                />
              </div>
            </div>
          ))}

          <button
            onClick={addToSession}
            className="w-full bg-blue-600 text-white text-sm font-semibold py-3 rounded-xl"
          >
            Add to Session ({reviewItems.length})
          </button>
        </div>
      )}

      {/* Staged session summary */}
      {sessionLog.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Staged this session
          </p>
          <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
            {sessionLog.map((entry, i) => (
              <div key={i} className="flex items-center justify-between px-3 py-2 border-b border-gray-50 last:border-0">
                <p className="text-sm text-gray-800 truncate flex-1">{entry.productName}</p>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                    entry.reason === 'expired' ? 'bg-red-100 text-red-700'
                    : entry.reason === 'damaged' ? 'bg-amber-100 text-amber-700'
                    : 'bg-gray-100 text-gray-600'
                  }`}>{entry.reason}</span>
                  <span className="text-sm font-semibold text-gray-700">×{entry.qty}</span>
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={logAllWaste}
            disabled={saving}
            className="w-full bg-green-600 text-white text-sm font-semibold py-3 rounded-xl disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving && <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            {saving ? 'Saving…' : `Log All Waste (${sessionLog.length})`}
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ScannerTab() {
  const [apiKey, setApiKey] = useState<string | null>(() => localStorage.getItem(API_KEY_STORAGE))
  const [mode, setMode] = useState<'invoice' | 'waste'>('invoice')

  function saveApiKey(key: string) {
    localStorage.setItem(API_KEY_STORAGE, key)
    setApiKey(key)
  }

  if (!apiKey) return <ApiKeySetup onSave={saveApiKey} />

  return (
    <div className="flex flex-col h-full">
      {/* Mode pill selector */}
      <div className="px-3 py-2 border-b border-gray-100 shrink-0">
        <div className="flex bg-gray-100 rounded-xl p-0.5">
          <button
            onClick={() => setMode('invoice')}
            className={`flex-1 text-xs font-medium py-1.5 rounded-lg transition-colors ${
              mode === 'invoice' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500'
            }`}
          >
            Invoice
          </button>
          <button
            onClick={() => setMode('waste')}
            className={`flex-1 text-xs font-medium py-1.5 rounded-lg transition-colors ${
              mode === 'waste' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500'
            }`}
          >
            Waste
          </button>
        </div>
        <div className="flex items-center justify-end mt-1">
          <button
            onClick={() => { localStorage.removeItem(API_KEY_STORAGE); setApiKey(null) }}
            className="text-[10px] text-gray-400 hover:text-gray-600 flex items-center gap-0.5"
          >
            <X size={10} /> Remove API key
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {mode === 'invoice'
          ? <InvoiceScanner apiKey={apiKey} />
          : <WasteScanner apiKey={apiKey} />
        }
      </div>
    </div>
  )
}
