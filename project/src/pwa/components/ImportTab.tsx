import { useRef, useState } from 'react'
import {
  Upload, FileSpreadsheet, AlertTriangle, CheckCircle,
  Clock, ChevronDown, ChevronUp, FileText, Eye, Save,
} from 'lucide-react'
import {
  detectReportType,
  parseItemMaintenance,
  parseStockReport,
  type MaintenanceImportResult,
  type StockImportResult,
} from '../lib/csvImporter'
import {
  parseInvoiceText,
  saveInvoice,
  extractTextFromPDF,
  type ParsedInvoice,
} from '../lib/invoiceParser'

function formatTime(d: Date): string {
  return d.toLocaleString('en-AU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

// ─── Shared Drop Zone ────────────────────────────────────────────────────────

function DropZone({
  onFile, loading, label, accept,
}: {
  onFile: (file: File) => void
  loading: boolean
  label: string
  accept?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
      onClick={() => !loading && inputRef.current?.click()}
      className={`border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-colors ${
        dragging ? 'border-blue-500 bg-blue-50'
          : loading ? 'border-gray-200 bg-gray-50 cursor-not-allowed'
            : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
      }`}
    >
      <input ref={inputRef} type="file" accept={accept ?? '.csv,.xlsx,.xls'} className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
      <Upload size={22} className={`mx-auto mb-2 ${loading ? 'text-gray-300' : 'text-gray-400'}`} />
      {loading
        ? <p className="text-sm text-gray-500">Processing…</p>
        : <>
            <p className="text-sm font-medium text-gray-700">{label}</p>
            <p className="text-xs text-gray-400 mt-0.5">Tap or drag & drop</p>
          </>
      }
    </div>
  )
}

// ─── Smart Retail Section ────────────────────────────────────────────────────

async function detectFromFile(file: File): Promise<'item_maintenance' | 'item_stock' | 'unknown'> {
  const lower = file.name.toLowerCase()
  if (lower.includes('maintenance') || lower.includes('item_maint')) return 'item_maintenance'
  if (lower.includes('stock') || lower.includes('qoh')) return 'item_stock'

  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'xlsx' || ext === 'xls') {
    const buf = await file.arrayBuffer()
    const { read, utils } = await import('xlsx')
    const wb = read(buf, { type: 'array', sheetRows: 2 })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows = utils.sheet_to_json<Record<string, string>>(ws, { defval: '', raw: false })
    return detectReportType(rows)
  }

  const slice = await file.slice(0, 512).text()
  const firstLine = slice.replace(/^\uFEFF/, '').split('\n')[0].toLowerCase()
  if (firstLine.includes('supplier code') || firstLine.includes('normal cost')) return 'item_maintenance'
  if (firstLine.includes('qoh') || firstLine.includes('carton qty')) return 'item_stock'
  return 'unknown'
}

function SmartRetailSection() {
  const [loading, setLoading] = useState(false)
  const [maintResult, setMaintResult] = useState<MaintenanceImportResult | null>(null)
  const [stockResult, setStockResult] = useState<StockImportResult | null>(null)
  const [error, setError] = useState('')
  const [showAnomalies, setShowAnomalies] = useState(false)

  async function handleFile(file: File) {
    setLoading(true)
    setError('')
    setMaintResult(null)
    setStockResult(null)
    try {
      const type = await detectFromFile(file)
      if (type === 'item_maintenance') {
        setMaintResult(await parseItemMaintenance(file))
      } else if (type === 'item_stock') {
        setStockResult(await parseStockReport(file))
      } else {
        setError('Could not detect report type — expected Item Maintenance or Item Stock columns.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      <DropZone onFile={handleFile} loading={loading} label="Drop Smart Retail export here" />

      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
          <AlertTriangle size={15} className="text-red-500 shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {maintResult && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg space-y-1">
          <div className="flex items-center gap-2">
            <CheckCircle size={15} className="text-green-600" />
            <span className="text-sm font-medium text-green-800">Item Maintenance imported</span>
          </div>
          <div className="text-xs text-green-700 ml-5 space-y-0.5">
            <p>✓ {maintResult.updated} products updated</p>
            {maintResult.newProducts > 0 && <p>+ {maintResult.newProducts} new (see anomalies)</p>}
            <p className="text-green-600">↷ {maintResult.skipped} rows skipped</p>
          </div>
          {maintResult.anomalies.length > 0 && (
            <div className="mt-1.5">
              <button onClick={() => setShowAnomalies((v) => !v)}
                className="flex items-center gap-1 text-xs text-amber-700 font-medium ml-5">
                <AlertTriangle size={11} />
                {maintResult.anomalies.length} anomalies
                {showAnomalies ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              </button>
              {showAnomalies && (
                <ul className="mt-1 space-y-1 ml-5">
                  {maintResult.anomalies.map((a, i) => (
                    <li key={i} className="text-xs text-amber-800 bg-amber-50 rounded p-1.5">{a}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="flex items-center gap-1 text-[11px] text-green-600 ml-5">
            <Clock size={10} /> {formatTime(maintResult.lastImportedAt)}
          </p>
        </div>
      )}

      {stockResult && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg space-y-1">
          <div className="flex items-center gap-2">
            <CheckCircle size={15} className="text-green-600" />
            <span className="text-sm font-medium text-green-800">Stock Report imported</span>
          </div>
          <div className="text-xs text-green-700 ml-5 space-y-0.5">
            <p>✓ {stockResult.snapshots} snapshots saved</p>
            <p>✓ {stockResult.matched} products matched</p>
            {stockResult.unmatched > 0 && (
              <p className="text-amber-700">⚠ {stockResult.unmatched} unmatched barcodes</p>
            )}
          </div>
          <p className="flex items-center gap-1 text-[11px] text-green-600 ml-5">
            <Clock size={10} /> {formatTime(stockResult.lastImportedAt)}
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Invoice Section ─────────────────────────────────────────────────────────

const SAMPLE_TEXT = `Delivery Note 221209 for 19.1.2026 Purchase Order 1660698
PHYSICAL LOW FAT MILK CTN 1L 00014584 2 EA 4.92 4.92 2.46000
PAULS FARMHOUSE GOLD MILK 1.5L 00048186 2 EA 7.22 7.22 3.61000`

function InvoiceSection() {
  const [pasteText, setPasteText] = useState('')
  const [parsed, setParsed] = useState<ParsedInvoice | null>(null)
  const [parseError, setParseError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [pdfLoading, setPdfLoading] = useState(false)
  const [showLines, setShowLines] = useState(false)

  function handleParse() {
    setParseError('')
    setSaveMsg('')
    setParsed(null)
    const text = pasteText.trim()
    if (!text) { setParseError('Paste invoice text first.'); return }
    try {
      const result = parseInvoiceText(text)
      if (!result) {
        setParseError('Could not find a Document Number — check the pasted text is a complete Lactalis invoice.')
        return
      }
      if (result.lineCount === 0) {
        setParseError('No line items found. Verify the invoice text is complete.')
        return
      }
      setParsed(result)
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handlePDF(file: File) {
    setPdfLoading(true)
    setParseError('')
    try {
      const text = await extractTextFromPDF(file)
      setPasteText(text)
      // Auto-parse after extraction
      const result = parseInvoiceText(text)
      if (!result) {
        setParseError('Could not extract Document Number from PDF — paste the text manually instead.')
      } else if (result.lineCount === 0) {
        setParseError('PDF text extraction produced no line items — paste the text manually instead.')
      } else {
        setParsed(result)
      }
    } catch (e) {
      setParseError(`PDF extraction failed: ${e instanceof Error ? e.message : String(e)}. Paste the text manually.`)
    } finally {
      setPdfLoading(false)
    }
  }

  async function handleSave() {
    if (!parsed) return
    setSaving(true)
    setSaveMsg('')
    try {
      const res = await saveInvoice(parsed)
      setSaveMsg(res.saved
        ? `✓ Invoice ${parsed.documentNumber} saved — ${parsed.lineCount} lines, prices updated`
        : `⚠ ${res.reason}`)
      if (res.saved) setParsed(null)
    } catch (e) {
      setSaveMsg(`Error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const docTypeLabel = parsed
    ? parsed.documentType === 'invoice' ? 'Tax Invoice'
      : parsed.documentType === 'credit_note' ? 'Adjustment Note'
        : 'Credit Adjustment Note'
    : ''

  return (
    <div className="space-y-3">
      {/* PDF upload */}
      <DropZone
        onFile={handlePDF}
        loading={pdfLoading}
        label="Drop Lactalis PDF invoice here"
        accept=".pdf"
      />

      <div className="flex items-center gap-2 text-xs text-gray-400">
        <div className="flex-1 h-px bg-gray-200" />
        <span>or paste invoice text</span>
        <div className="flex-1 h-px bg-gray-200" />
      </div>

      {/* Paste area */}
      <textarea
        value={pasteText}
        onChange={(e) => { setPasteText(e.target.value); setParsed(null); setSaveMsg('') }}
        placeholder={`Paste invoice text here…\n\nExample:\n${SAMPLE_TEXT}`}
        rows={6}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-1 focus:ring-blue-400"
      />

      {/* Parse button */}
      <button
        onClick={handleParse}
        disabled={!pasteText.trim()}
        className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white text-sm font-medium py-2 rounded-lg disabled:opacity-40"
      >
        <Eye size={15} />
        Parse Invoice
      </button>

      {parseError && (
        <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
          <AlertTriangle size={15} className="text-red-500 shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{parseError}</p>
        </div>
      )}

      {/* Preview */}
      {parsed && (
        <div className="border border-blue-200 rounded-lg overflow-hidden">
          <div className="bg-blue-50 px-3 py-2 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-blue-900">
                {docTypeLabel} {parsed.documentNumber || '(no number)'}
              </p>
              <p className="text-xs text-blue-700">
                {parsed.deliveries.length} {parsed.deliveries.length === 1 ? 'delivery' : 'deliveries'} ·{' '}
                {parsed.lineCount} items ·{' '}
                ${parsed.totalAmount.toFixed(2)}
              </p>
            </div>
            <button
              onClick={() => setShowLines((v) => !v)}
              className="text-xs text-blue-600 flex items-center gap-1"
            >
              {showLines ? 'Hide' : 'Details'}
              {showLines ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          </div>

          {showLines && (
            <div className="divide-y divide-gray-100 max-h-64 overflow-auto">
              {parsed.deliveries.map((d) => (
                <div key={d.noteNumber} className="px-3 py-2">
                  <p className="text-xs font-semibold text-gray-700 mb-1">
                    Delivery {d.noteNumber} — {d.deliveryDate} (PO {d.purchaseOrderNumber})
                  </p>
                  {d.lines.map((l, i) => (
                    <div key={i} className="flex justify-between text-xs text-gray-600 py-0.5">
                      <span className="truncate mr-2">
                        {l.productName} <span className="text-gray-400">#{parseInt(l.productCode, 10)}</span>
                      </span>
                      <span className="shrink-0">×{l.quantity} {l.unitType} @ ${l.pricePerItem.toFixed(2)}</span>
                    </div>
                  ))}
                  {d.lines.length === 0 && (
                    <p className="text-xs text-gray-400 italic">No line items parsed</p>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="px-3 py-2 bg-gray-50 border-t border-blue-100">
            <button
              onClick={handleSave}
              disabled={saving || parsed.lineCount === 0}
              className="w-full flex items-center justify-center gap-2 bg-green-600 text-white text-sm font-medium py-2 rounded-lg disabled:opacity-40"
            >
              <Save size={15} />
              {saving ? 'Saving…' : 'Confirm & Save Invoice'}
            </button>
          </div>
        </div>
      )}

      {saveMsg && (
        <div className={`flex items-start gap-2 p-3 rounded-lg border text-sm ${
          saveMsg.startsWith('✓')
            ? 'bg-green-50 border-green-200 text-green-800'
            : 'bg-amber-50 border-amber-200 text-amber-800'
        }`}>
          {saveMsg.startsWith('✓') ? <CheckCircle size={15} className="shrink-0 mt-0.5" /> : <AlertTriangle size={15} className="shrink-0 mt-0.5" />}
          <p>{saveMsg}</p>
        </div>
      )}
    </div>
  )
}

// ─── Main ImportTab ───────────────────────────────────────────────────────────

export default function ImportTab() {
  return (
    <div className="p-4 space-y-6 pb-8">
      <section>
        <div className="flex items-center gap-2 mb-2">
          <FileSpreadsheet size={18} className="text-green-600" />
          <h2 className="text-base font-semibold text-gray-900">Smart Retail Import</h2>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Item Maintenance (prices) or Item Stock Report (QOH). Auto-detects which type.
        </p>
        <SmartRetailSection />
      </section>

      <div className="border-t border-gray-200" />

      <section>
        <div className="flex items-center gap-2 mb-2">
          <FileText size={18} className="text-blue-600" />
          <h2 className="text-base font-semibold text-gray-900">Lactalis Invoice Import</h2>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Upload a PDF or paste extracted invoice text. Saves line items and updates cost prices.
        </p>
        <InvoiceSection />
      </section>
    </div>
  )
}
