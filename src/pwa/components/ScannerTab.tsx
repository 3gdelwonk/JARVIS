/**
 * ScannerTab.tsx
 *
 * Four modes:
 *  A — Invoice Scanner:   photograph a Lactalis invoice → Gemini Vision parses → updates stock
 *  B — Waste Scanner:     barcode scan (default) or photo AI → log waste
 *  C — Add to Order:      live camera barcode scan → product lookup → add to draft order
 *  D — Claim Scanner:     fill claim form → open Gmail draft to Lactalis
 */

import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  AlertCircle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  ExternalLink,
  ImageOff,
  Key,
  Minus,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { db } from '../lib/db'
import { nextDeliveryDate } from '../lib/constants'
import type { WasteEntry } from '../lib/types'

const API_KEY_STORAGE = 'milk-manager-gemini-key'

// ─── Gemini Vision helper ─────────────────────────────────────────────────────

async function callGeminiVision(prompt: string, base64: string, mediaType: string): Promise<string> {
  const apiKey = localStorage.getItem(API_KEY_STORAGE)
  if (!apiKey) throw new Error('No Gemini API key set — add it in Settings')
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mediaType, data: base64 } }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    },
  )
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Gemini error ${res.status}: ${errBody.slice(0, 200)}`)
  }
  const json = await res.json()
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Empty response from Gemini')
  return text
}

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
        <p className="text-sm font-semibold text-gray-900">Enter your Gemini API Key</p>
        <p className="text-xs text-gray-500 mt-1">
          Required for photo scanning. Free at{' '}
          <a href="https://aistudio.google.com" target="_blank" rel="noopener noreferrer" className="text-blue-500 underline">
            aistudio.google.com
          </a>
          . Stored only in this browser.
        </p>
      </div>
      <input
        type="password"
        placeholder="AIza..."
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

function InvoiceScanner() {
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
      const text = await callGeminiVision(INVOICE_PARSE_PROMPT, base64, mediaType)
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

// ─── Shared barcode camera hook ────────────────────────────────────────────────

const nativeBarcodeSupported = typeof (window as { BarcodeDetector?: unknown }).BarcodeDetector !== 'undefined'

function useBarcodeCamera(onDetected: (barcode: string) => void) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const zxingControlsRef = useRef<{ stop: () => void } | null>(null)
  const shouldScanRef = useRef(true)
  const onDetectedRef = useRef(onDetected)
  const [cameraError, setCameraError] = useState('')

  // Keep callback ref up to date so detectors always call the latest handler
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
        stream = await navigator.mediaDevices.getUserMedia({ video: true })
      }
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      // Enable continuous autofocus on devices that support it (Chrome/Android).
      // Silently ignored elsewhere — focusMode is not in TS lib.dom yet, hence the cast.
      const videoTrack = stream.getVideoTracks()[0]
      if (videoTrack) {
        videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
          .catch(() => {})
      }
      if (nativeBarcodeSupported) {
        runDetection()
      } else {
        runZxingDetection()
      }
    } catch (e) {
      const name = (e as Error).name
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setCameraError('Camera permission denied — grant access in browser settings, or use manual entry below')
      } else if (name === 'NotFoundError') {
        setCameraError('No camera found — use manual entry below')
      } else {
        setCameraError('Camera unavailable — use manual entry below')
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
      if (!video || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const barcodes: any[] = await detector.detect(video)
        if (barcodes.length > 0 && shouldScanRef.current) {
          shouldScanRef.current = false
          onDetectedRef.current(barcodes[0].rawValue)
          return
        }
      } catch { /* detector not ready yet */ }
      if (shouldScanRef.current) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  async function runZxingDetection() {
    try {
      const { BrowserMultiFormatReader } = await import('@zxing/browser')
      const reader = new BrowserMultiFormatReader()
      const controls = await reader.decodeFromVideoElement(
        videoRef.current!,
        (result) => {
          if (result && shouldScanRef.current) {
            shouldScanRef.current = false
            zxingControlsRef.current?.stop()
            onDetectedRef.current(result.getText())
          }
        },
      )
      zxingControlsRef.current = controls
    } catch { /* ZXing unavailable — manual entry still works */ }
  }

  function resumeScanning() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    zxingControlsRef.current?.stop()
    zxingControlsRef.current = null
    shouldScanRef.current = true
    if (streamRef.current) {
      if (videoRef.current && videoRef.current.paused) {
        videoRef.current.play().catch(() => {})
      }
      if (nativeBarcodeSupported) {
        runDetection()
      } else {
        runZxingDetection()
      }
    }
  }

  return { videoRef, cameraError, startCamera, stopCamera, resumeScanning, shouldScanRef, streamRef }
}

// ─── Waste Scanner (Mode B) ───────────────────────────────────────────────────

type WasteMode = 'barcode' | 'photo'
type BarcodeScanState = 'scanning' | 'found' | 'notfound' | 'logged'

function WasteScanner() {
  // ── Shared ──
  const [wasteMode, setWasteMode] = useState<WasteMode>('barcode')

  // ── Barcode mode state ──
  const [bcState, setBcState] = useState<BarcodeScanState>('scanning')
  const [bcBarcode, setBcBarcode] = useState('')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [bcProduct, setBcProduct] = useState<any | null>(null)
  const [bcProductName, setBcProductName] = useState('')
  const [bcQty, setBcQty] = useState(1)
  const [bcReason, setBcReason] = useState<StagedWasteEntry['reason']>('expired')
  const [bcDate, setBcDate] = useState(todayStr)
  const [bcSaving, setBcSaving] = useState(false)
  const [bcError, setBcError] = useState('')

  // ── Photo mode state ──
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

  const { videoRef, cameraError, startCamera, stopCamera, resumeScanning, shouldScanRef } =
    useBarcodeCamera(handleWasteBarcode)

  // Start/stop barcode camera whenever mode switches to/from 'barcode'
  useEffect(() => {
    if (wasteMode !== 'barcode') return
    shouldScanRef.current = true
    setBcState('scanning')
    startCamera()
    return () => {
      shouldScanRef.current = false
      stopCamera()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wasteMode])

  // ── Barcode mode handlers ──

  async function handleWasteBarcode(barcode: string) {
    setBcBarcode(barcode)
    const found =
      (await db.products.where('barcode').equals(barcode).first()) ??
      (await db.products.where('invoiceCode').equals(barcode).first())
    if (found) {
      setBcProduct(found)
      setBcQty(1)
      setBcReason('expired')
      setBcDate(todayStr())
      setBcState('found')
    } else {
      setBcProductName('')
      setBcQty(1)
      setBcReason('expired')
      setBcDate(todayStr())
      setBcState('notfound')
    }
  }

  async function logBarcodeWaste() {
    const productId = bcProduct?.id as number | undefined
    const productName = (bcProduct?.name ?? bcProductName).trim()
    if (!productName) { setBcError('Enter a product name'); return }
    setBcError('')
    setBcSaving(true)
    try {
      const wasteEntry: WasteEntry = {
        productId: productId ?? 0,
        productName,
        quantity: bcQty,
        wastedDate: bcDate,
        reason: bcReason,
      }
      await db.wasteLog.add(wasteEntry)

      if (productId) {
        const batches = await db.expiryBatches
          .where('productId').equals(productId)
          .filter((b) => b.status === 'active')
          .toArray()
        let remaining = bcQty
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

      setBcState('logged')
      setTimeout(() => {
        setBcState('scanning')
        setBcBarcode('')
        setBcProduct(null)
        setBcProductName('')
        setBcQty(1)
        setBcReason('expired')
        setBcDate(todayStr())
        resumeScanning()
      }, 1200)
    } catch (e) {
      setBcError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBcSaving(false)
    }
  }

  function bcScanAgain() {
    setBcState('scanning')
    setBcBarcode('')
    setBcProduct(null)
    setBcProductName('')
    setBcQty(1)
    setBcError('')
    resumeScanning()
  }

  // ── Photo mode handlers ──

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
      const text = await callGeminiVision(WASTE_PARSE_PROMPT, base64, mediaType)
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

  // ── Mode toggle UI ──

  const modeToggle = (
    <div className="flex bg-gray-100 rounded-xl p-0.5">
      <button
        onClick={() => setWasteMode('barcode')}
        className={`flex-1 text-xs font-medium py-1.5 rounded-lg transition-colors ${
          wasteMode === 'barcode' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500'
        }`}
      >
        Barcode Scan
      </button>
      <button
        onClick={() => setWasteMode('photo')}
        className={`flex-1 text-xs font-medium py-1.5 rounded-lg transition-colors ${
          wasteMode === 'photo' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500'
        }`}
      >
        Photo (AI)
      </button>
    </div>
  )

  // ── Barcode mode render ──

  if (wasteMode === 'barcode') {
    // Single return — <video> always stays in DOM so videoRef.current never goes null
    // between state transitions. Hidden via CSS rather than conditional rendering.
    return (
      <div className="flex flex-col gap-4 p-4">
        {modeToggle}

        {/* Video viewfinder — always mounted, hidden when reviewing a result */}
        <div className={`relative rounded-2xl overflow-hidden bg-black aspect-video${bcState !== 'scanning' ? ' hidden' : ''}`}>
          {!cameraError ? (
            <>
              <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-48 h-32 border-2 border-white/60 rounded-xl" />
              </div>
              <p className="absolute bottom-3 left-0 right-0 text-center text-[11px] text-white/70">
                Point camera at product barcode
              </p>
            </>
          ) : (
            <div className="bg-amber-50 border border-amber-100 rounded-xl p-3">
              <p className="text-xs text-amber-700">{cameraError}</p>
            </div>
          )}
        </div>

        {/* Camera error shown outside the viewfinder when not scanning */}
        {bcState !== 'scanning' && cameraError && (
          <div className="bg-amber-50 border border-amber-100 rounded-xl p-3">
            <p className="text-xs text-amber-700">{cameraError}</p>
          </div>
        )}

        {/* Brief success flash after logging */}
        {bcState === 'logged' && (
          <div className="flex flex-col items-center justify-center gap-3 py-10">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle2 size={24} className="text-green-600" />
            </div>
            <p className="text-sm font-semibold text-gray-900">Waste logged!</p>
          </div>
        )}

        {/* Product review card (found or not found) */}
        {(bcState === 'found' || bcState === 'notfound') && (
          <div className="bg-white border border-gray-100 rounded-xl p-4 flex flex-col gap-3">
            {bcState === 'found' && bcProduct ? (
              <div className="flex items-center gap-3">
                <div className="relative w-14 h-14 rounded-lg bg-gray-100 overflow-hidden flex items-center justify-center shrink-0">
                  <ImageOff size={16} className="text-gray-300" />
                  {bcProduct.imageUrl && (
                    <img
                      src={bcProduct.imageUrl}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{bcProduct.name}</p>
                  <p className="text-[11px] text-gray-400">#{bcProduct.invoiceCode}</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <AlertCircle size={16} className="text-amber-400 shrink-0" />
                  <p className="text-sm text-gray-700">Barcode not in database</p>
                </div>
                <p className="text-[11px] text-gray-400 font-mono">{bcBarcode}</p>
                <input
                  type="text"
                  placeholder="Product name"
                  value={bcProductName}
                  onChange={(e) => setBcProductName(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>
            )}

            {/* Qty + Reason + Date */}
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setBcQty((q) => Math.max(1, q - 1))}
                  className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-gray-600"
                >
                  <Minus size={12} />
                </button>
                <span className="w-8 text-center text-sm font-semibold text-gray-900">{bcQty}</span>
                <button
                  onClick={() => setBcQty((q) => q + 1)}
                  className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-gray-600"
                >
                  <Plus size={12} />
                </button>
              </div>
              <select
                value={bcReason}
                onChange={(e) => setBcReason(e.target.value as StagedWasteEntry['reason'])}
                className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5"
              >
                <option value="expired">Expired</option>
                <option value="damaged">Damaged</option>
                <option value="other">Other</option>
              </select>
              <input
                type="date"
                value={bcDate}
                onChange={(e) => setBcDate(e.target.value)}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1.5"
              />
            </div>

            {bcError && <p className="text-xs text-red-500">{bcError}</p>}

            <div className="flex gap-2">
              <button
                onClick={bcScanAgain}
                className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600 font-medium"
              >
                Scan Again
              </button>
              <button
                onClick={logBarcodeWaste}
                disabled={bcSaving || (bcState === 'notfound' && !bcProductName.trim())}
                className="flex-1 py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {bcSaving && <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Log Waste
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Photo mode render ──

  if (savedCount !== null) {
    return (
      <div className="flex flex-col gap-4 p-4">
        {modeToggle}
        <div className="flex flex-col items-center justify-center gap-4 py-8 text-center">
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
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {modeToggle}

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

// ─── Add to Order Scanner (Mode C) ───────────────────────────────────────────

type ScanState = 'scanning' | 'found' | 'notfound' | 'added'

function AddToOrderScanner() {
  const [scanState, setScanState] = useState<ScanState>('scanning')
  const [detectedBarcode, setDetectedBarcode] = useState('')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [product, setProduct] = useState<any | null>(null)
  const [qty, setQty] = useState(1)
  const [addError, setAddError] = useState('')
  const [manualInput, setManualInput] = useState('')

  const { videoRef, cameraError, startCamera, stopCamera, resumeScanning, shouldScanRef } =
    useBarcodeCamera(handleBarcode)

  useEffect(() => {
    shouldScanRef.current = true
    startCamera()
    return () => {
      shouldScanRef.current = false
      stopCamera()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleBarcode(barcode: string) {
    setDetectedBarcode(barcode)
    const found =
      (await db.products.where('barcode').equals(barcode).first()) ??
      (await db.products.where('invoiceCode').equals(barcode).first())
    if (found) {
      setProduct(found)
      setQty(1)
      setScanState('found')
    } else {
      setScanState('notfound')
    }
  }

  async function handleManualBarcode() {
    const val = manualInput.trim()
    if (!val) return
    shouldScanRef.current = false
    await handleBarcode(val)
  }

  async function handleAddToOrder() {
    if (!product) return
    setAddError('')
    try {
      let order = await db.orders.where('status').equals('draft').last()
      if (!order) {
        const nextDel = nextDeliveryDate()
        const dateStr = `${nextDel.getFullYear()}-${String(nextDel.getMonth() + 1).padStart(2, '0')}-${String(nextDel.getDate()).padStart(2, '0')}`
        const newId = (await db.orders.add({
          deliveryDate: dateStr,
          createdAt: new Date(),
          approvedAt: new Date(),
          status: 'draft',
          totalCostEstimate: 0,
        })) as number
        order = await db.orders.get(newId)
      }

      const lines = await db.orderLines.where('orderId').equals(order!.id!).toArray()
      const existingLine = lines.find((l) => l.productId === product.id)
      if (existingLine) {
        const newQty = existingLine.approvedQty + qty
        await db.orderLines.update(existingLine.id!, {
          approvedQty: newQty,
          lineTotal: newQty * (product.lactalisCostPrice ?? 0),
        })
      } else {
        await db.orderLines.add({
          orderId: order!.id!,
          productId: product.id!,
          itemNumber: product.invoiceCode,
          productName: product.name,
          suggestedQty: qty,
          approvedQty: qty,
          unitPrice: product.lactalisCostPrice ?? 0,
          lineTotal: qty * (product.lactalisCostPrice ?? 0),
        })
      }

      setScanState('added')
      setTimeout(() => scanAgain(), 1500)
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Failed to add to order')
    }
  }

  function scanAgain() {
    setProduct(null)
    setDetectedBarcode('')
    setManualInput('')
    setQty(1)
    setAddError('')
    setScanState('scanning')
    resumeScanning()
  }

  // ── Single return — <video> always stays in DOM so videoRef.current never
  //    goes null between state transitions. Hidden via CSS, not unmounted. ────
  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Video viewfinder — always mounted, hidden when reviewing a result */}
      <div className={`relative rounded-2xl overflow-hidden bg-black aspect-video${scanState !== 'scanning' ? ' hidden' : ''}`}>
        {!cameraError ? (
          <>
            <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-48 h-32 border-2 border-white/60 rounded-xl" />
            </div>
            <p className="absolute bottom-3 left-0 right-0 text-center text-[11px] text-white/70">
              Point camera at a barcode
            </p>
          </>
        ) : (
          <div className="bg-amber-50 border border-amber-100 rounded-xl p-3">
            <p className="text-xs text-amber-700">{cameraError}</p>
          </div>
        )}
      </div>

      {/* Camera error shown outside viewfinder when not scanning */}
      {scanState !== 'scanning' && cameraError && (
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-3">
          <p className="text-xs text-amber-700">{cameraError}</p>
        </div>
      )}

      {/* Success flash */}
      {scanState === 'added' && (
        <div className="flex flex-col items-center justify-center gap-3 py-12 px-6 text-center">
          <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
            <CheckCircle2 size={28} className="text-green-600" />
          </div>
          <p className="text-base font-semibold text-gray-900">Added to draft order!</p>
          <p className="text-sm text-gray-500">{product?.name}</p>
        </div>
      )}

      {/* Result card — found */}
      {scanState === 'found' && product && (
        <div className="bg-white border border-gray-100 rounded-xl p-4 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="relative w-14 h-14 rounded-lg bg-gray-100 overflow-hidden flex items-center justify-center shrink-0">
              <ImageOff size={16} className="text-gray-300" />
              {product.imageUrl && (
                <img src={product.imageUrl} alt="" className="absolute inset-0 w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900 truncate">{product.name}</p>
              <p className="text-[11px] text-gray-400">#{product.invoiceCode}</p>
              {product.orderUnit && (
                <p className="text-[11px] text-gray-400">{product.orderUnit}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">Qty:</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setQty((q) => Math.max(1, q - 1))}
                className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-600">
                <Minus size={13} />
              </button>
              <span className="w-8 text-center text-sm font-semibold text-gray-900">{qty}</span>
              <button onClick={() => setQty((q) => q + 1)}
                className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-600">
                <Plus size={13} />
              </button>
            </div>
          </div>
          {addError && <p className="text-xs text-red-500">{addError}</p>}
          <div className="flex gap-2">
            <button onClick={scanAgain}
              className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600 font-medium">
              Scan Again
            </button>
            <button onClick={handleAddToOrder}
              className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold">
              Add to Order
            </button>
          </div>
        </div>
      )}

      {/* Result card — not found */}
      {scanState === 'notfound' && (
        <div className="bg-white border border-gray-100 rounded-xl p-4 flex flex-col gap-3 items-center text-center">
          <AlertCircle size={28} className="text-amber-400" />
          <p className="text-sm font-semibold text-gray-900">Product not found</p>
          <p className="text-xs text-gray-500 font-mono">{detectedBarcode}</p>
          <button onClick={scanAgain}
            className="w-full py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold">
            Scan Again
          </button>
        </div>
      )}

      {/* Manual barcode entry fallback */}
      {scanState === 'scanning' && <div className="flex gap-2">
        <input
          type="text"
          placeholder="Enter barcode manually…"
          value={manualInput}
          onChange={(e) => setManualInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleManualBarcode() }}
          className="flex-1 border border-gray-300 rounded-xl px-3 py-2 text-sm"
        />
        <button
          onClick={handleManualBarcode}
          disabled={!manualInput.trim()}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-xl disabled:opacity-40"
        >
          Look Up
        </button>
      </div>}
    </div>
  )
}

// ─── Claim Scanner (Mode D) ───────────────────────────────────────────────────

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

function ClaimScanner() {
  const [step, setStep] = useState<'type' | 'details' | 'preview'>('type')
  const [claimType, setClaimType] = useState<ClaimType | null>(null)
  const [productName, setProductName] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [invoiceRef, setInvoiceRef] = useState('')
  const [description, setDescription] = useState('')
  const [image, setImage] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [identifying, setIdentifying] = useState(false)
  const [identifyError, setIdentifyError] = useState('')
  const [emailOpened, setEmailOpened] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const storeName = localStorage.getItem('milk-manager-store-name') || 'IGA Store'
  const lactalisEmail = localStorage.getItem('milk-manager-lactalis-email') || 'customer.service@lactalis.com.au'

  async function handlePhotoIdentify() {
    if (!image) return
    setIdentifying(true)
    setIdentifyError('')
    try {
      const { base64, mediaType } = await imageToBase64(image)
      const text = await callGeminiVision(
        'Identify the dairy/milk product in this photo. Return ONLY valid JSON: {"productName": "string"}',
        base64,
        mediaType,
      )
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0])
        if (result.productName) setProductName(result.productName)
      }
    } catch (e) {
      setIdentifyError(e instanceof Error ? e.message : 'Identify failed')
    } finally {
      setIdentifying(false)
    }
  }

  function selectClaimType(type: ClaimType) {
    setClaimType(type)
    setDescription(CLAIM_TEMPLATES[type])
    setStep('details')
  }

  function buildEmailBody() {
    return `Dear Lactalis Customer Service,

Store: ${storeName}
Date: ${todayStr()}

Claim Type: ${CLAIM_TYPE_LABELS[claimType!]}
Product: ${productName}
Quantity: ${quantity}
Order/Invoice Reference: ${invoiceRef || 'N/A'}

Details:
${description}

Please arrange credit or replacement at your earliest convenience.

Kind regards,
${storeName}`.trim()
  }

  function openGmail() {
    const subject = `Product Claim — ${CLAIM_TYPE_LABELS[claimType!]} — ${productName} — ${todayStr()}`
    const body = buildEmailBody()
    const url = `https://mail.google.com/mail/u/0/?view=cm&to=${encodeURIComponent(lactalisEmail)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    window.open(url, '_blank')
    db.claimRecords.add({
      productName,
      claimType: claimType!,
      quantity: Number(quantity) || 1,
      invoiceRef: invoiceRef || undefined,
      description,
      emailSentAt: todayStr(),
      createdAt: todayStr(),
    })
    setEmailOpened(true)
  }

  function resetClaim() {
    setStep('type')
    setClaimType(null)
    setProductName('')
    setQuantity('1')
    setInvoiceRef('')
    setDescription('')
    setPreviewUrl('')
    setImage(null)
    setEmailOpened(false)
    setIdentifyError('')
  }

  // Step 1: Select claim type
  if (step === 'type') {
    return (
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Select Claim Type</p>
        {(Object.entries(CLAIM_TYPE_LABELS) as [ClaimType, string][]).map(([type, label]) => (
          <button
            key={type}
            onClick={() => selectClaimType(type)}
            className="w-full text-left px-4 py-3 bg-white border border-gray-200 rounded-xl text-sm font-medium text-gray-800 hover:border-blue-300 hover:bg-blue-50 transition-colors"
          >
            {label}
          </button>
        ))}
      </div>
    )
  }

  // Step 2: Fill details
  if (step === 'details') {
    return (
      <div className="flex flex-col gap-3 p-4">
        <button onClick={() => setStep('type')} className="flex items-center gap-1 text-xs text-gray-500 self-start">
          <ArrowLeft size={12} /> Change type
        </button>
        <p className="text-xs font-semibold text-gray-700">{CLAIM_TYPE_LABELS[claimType!]}</p>

        {/* Optional photo */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (!file) return
            setImage(file)
            setPreviewUrl(URL.createObjectURL(file))
          }}
        />
        {!previewUrl ? (
          <button
            onClick={() => fileRef.current?.click()}
            className="w-full h-20 rounded-xl border border-dashed border-gray-300 bg-gray-50 flex items-center justify-center gap-2 text-gray-400 text-xs"
          >
            <Camera size={16} /> Take Photo (optional — to identify product)
          </button>
        ) : (
          <div className="relative">
            <img src={previewUrl} className="w-full rounded-xl object-contain max-h-32" alt="Claim" />
            <button
              onClick={() => { setImage(null); setPreviewUrl('') }}
              className="absolute top-1 right-1 bg-black/50 text-white rounded-full p-1"
            >
              <X size={12} />
            </button>
            {!productName && (
              <button
                onClick={handlePhotoIdentify}
                disabled={identifying}
                className="absolute bottom-1 right-1 bg-blue-600 text-white text-xs px-2 py-1 rounded-lg disabled:opacity-50"
              >
                {identifying ? 'Identifying…' : 'Identify Product'}
              </button>
            )}
          </div>
        )}
        {identifyError && <p className="text-xs text-red-500">{identifyError}</p>}

        {/* Form fields */}
        <input
          type="text"
          placeholder="Product name *"
          value={productName}
          onChange={(e) => setProductName(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        />
        <div className="flex gap-2">
          <input
            type="number"
            placeholder="Qty"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <input
            type="text"
            placeholder="Invoice/order ref (optional)"
            value={invoiceRef}
            onChange={(e) => setInvoiceRef(e.target.value)}
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <textarea
          rows={3}
          placeholder="Claim description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none"
        />
        <button
          onClick={() => setStep('preview')}
          disabled={!productName.trim()}
          className="w-full bg-blue-600 text-white text-sm font-semibold py-3 rounded-xl disabled:opacity-40"
        >
          Preview Email
        </button>
      </div>
    )
  }

  // Step 3: Preview + send
  return (
    <div className="flex flex-col gap-3 p-4">
      <button onClick={() => setStep('details')} className="flex items-center gap-1 text-xs text-gray-500 self-start">
        <ArrowLeft size={12} /> Edit details
      </button>
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Email Preview</p>

      <div className="bg-gray-50 rounded-xl p-3">
        <p className="text-[11px] text-gray-400 mb-0.5">To: {lactalisEmail}</p>
        <p className="text-[11px] font-medium text-gray-700 mb-2">
          Subject: Product Claim — {CLAIM_TYPE_LABELS[claimType!]} — {productName} — {todayStr()}
        </p>
        <pre className="text-xs text-gray-600 whitespace-pre-wrap leading-relaxed font-sans">
          {buildEmailBody()}
        </pre>
      </div>

      {emailOpened ? (
        <div className="flex flex-col items-center gap-3 py-4">
          <CheckCircle2 size={28} className="text-green-600" />
          <p className="text-sm font-medium text-gray-800">Gmail draft opened — review and send</p>
          <button onClick={resetClaim} className="text-sm text-blue-600">
            Submit Another Claim
          </button>
        </div>
      ) : (
        <button
          onClick={openGmail}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white text-sm font-semibold py-3 rounded-xl"
        >
          <ExternalLink size={15} />
          Open in Gmail
        </button>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ScannerTab() {
  const [apiKey, setApiKey] = useState<string | null>(() => localStorage.getItem(API_KEY_STORAGE))
  const [mode, setMode] = useState<'invoice' | 'waste' | 'addtoorder' | 'claim'>('invoice')

  function saveApiKey(key: string) {
    localStorage.setItem(API_KEY_STORAGE, key)
    setApiKey(key)
  }

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
          <button
            onClick={() => setMode('addtoorder')}
            className={`flex-1 text-xs font-medium py-1.5 rounded-lg transition-colors ${
              mode === 'addtoorder' ? 'bg-white text-green-600 shadow-sm' : 'text-gray-500'
            }`}
          >
            Add Order
          </button>
          <button
            onClick={() => setMode('claim')}
            className={`flex-1 text-xs font-medium py-1.5 rounded-lg transition-colors ${
              mode === 'claim' ? 'bg-white text-orange-600 shadow-sm' : 'text-gray-500'
            }`}
          >
            Claim
          </button>
        </div>
        {(mode === 'invoice' || mode === 'waste') && (
          <div className="flex items-center justify-end mt-1">
            <button
              onClick={() => { localStorage.removeItem(API_KEY_STORAGE); setApiKey(null) }}
              className="text-[10px] text-gray-400 hover:text-gray-600 flex items-center gap-0.5"
            >
              <X size={10} /> Remove API key
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {mode === 'addtoorder'
          ? <AddToOrderScanner />
          : mode === 'claim'
            ? <ClaimScanner />
            : mode === 'waste'
              ? <WasteScanner />
              : !apiKey
                ? <ApiKeySetup onSave={saveApiKey} />
                : <InvoiceScanner />
        }
      </div>
    </div>
  )
}
