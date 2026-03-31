import { useRef, useState, useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Upload, FileSpreadsheet, AlertTriangle, CheckCircle,
  Clock, ChevronDown, ChevronUp, FileText, Eye, Save, Package, Database, Mail, RefreshCw,
} from 'lucide-react'
import { connectGmail, disconnectGmail, isGmailConnected, syncGmailOrders, getGmailLastSync, prepareGmailClient } from '../lib/gmailSync'
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
import { db } from '../lib/db'

function formatTime(d: Date): string {
  return d.toLocaleString('en-AU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

function fmtDate(d: Date | null): string {
  if (!d) return 'none yet'
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

// ─── Data Status ─────────────────────────────────────────────────────────────

function DataStatus() {
  const status = useLiveQuery(async () => {
    const [products, snapshots, invoices] = await Promise.all([
      db.products.toArray(),
      db.stockSnapshots.toArray(),
      db.invoiceRecords.toArray(),
    ])
    const priced = products.filter((p) => p.lactalisCostPrice > 0)
    const latestProduct = priced.reduce<Date | null>(
      (best, p) => (!best || new Date(p.updatedAt) > best ? new Date(p.updatedAt) : best), null,
    )
    const latestSnap = snapshots.reduce<Date | null>(
      (best, s) => (!best || new Date(s.importedAt) > best ? new Date(s.importedAt) : best), null,
    )
    const latestInvoice = invoices.reduce<string | null>(
      (best, i) => (!best || i.invoiceDate > best ? i.invoiceDate : best), null,
    )
    return {
      products: priced.length,
      latestProduct,
      snapshots: snapshots.length,
      latestSnap,
      invoices: invoices.length,
      latestInvoice,
    }
  }, [])

  if (!status) return null

  const hasData = status.products > 0 || status.snapshots > 0 || status.invoices > 0

  const rows: Array<{ icon: React.ReactNode; label: string; count: number; date: string }> = [
    {
      icon: <Package size={13} />,
      label: 'Products with prices',
      count: status.products,
      date: fmtDate(status.latestProduct),
    },
    {
      icon: <Database size={13} />,
      label: 'Stock snapshots',
      count: status.snapshots,
      date: fmtDate(status.latestSnap),
    },
    {
      icon: <FileText size={13} />,
      label: 'Invoices',
      count: status.invoices,
      date: status.latestInvoice
        ? fmtDate(new Date(status.latestInvoice))
        : 'none yet',
    },
  ]

  return (
    <div className={`rounded-xl border p-3 mb-4 ${hasData ? 'bg-blue-50 border-blue-100' : 'bg-gray-50 border-gray-200'}`}>
      <p className={`text-[11px] font-semibold uppercase tracking-wide mb-2 ${hasData ? 'text-blue-600' : 'text-gray-400'}`}>
        Stored Data
      </p>
      {hasData ? (
        <div className="space-y-1">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center gap-1.5 text-xs text-blue-800">
              <span className={r.count > 0 ? 'text-blue-500' : 'text-gray-300'}>{r.icon}</span>
              <span className={r.count > 0 ? 'text-blue-900' : 'text-gray-400'}>
                {r.count > 0 ? `${r.count} ${r.label}` : `No ${r.label.toLowerCase()}`}
              </span>
              {r.count > 0 && (
                <>
                  <span className="text-blue-300">·</span>
                  <span className="text-blue-500 text-[11px]">{r.date}</span>
                </>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-400">No data imported yet — your imports will be saved here permanently.</p>
      )}
    </div>
  )
}

// ─── Shared Drop Zone ────────────────────────────────────────────────────────

function DropZone({
  onFiles, loading, label, accept, multiple, fileCount, progressCount,
}: {
  onFiles: (files: File[]) => void
  loading: boolean
  label: string
  accept?: string
  multiple?: boolean
  fileCount?: number
  progressCount?: number
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault(); setDragging(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length) onFiles(multiple ? files : [files[0]])
      }}
      onClick={() => !loading && inputRef.current?.click()}
      className={`border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-colors ${
        dragging ? 'border-blue-500 bg-blue-50'
          : loading ? 'border-gray-200 bg-gray-50 cursor-not-allowed'
            : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
      }`}
    >
      <input ref={inputRef} type="file" accept={accept ?? '.csv,.xlsx,.xls'} className="hidden"
        multiple={multiple}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) onFiles(multiple ? files : [files[0]])
          e.target.value = ''
        }} />
      <Upload size={22} className={`mx-auto mb-2 ${loading ? 'text-gray-300' : 'text-gray-400'}`} />
      {loading
        ? <p className="text-sm text-gray-500">
            {fileCount && fileCount > 1
              ? `Processing ${progressCount ?? 0}/${fileCount}…`
              : 'Processing…'}
          </p>
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
  const [fileCount, setFileCount] = useState(0)
  const [progressCount, setProgressCount] = useState(0)
  const [maintResult, setMaintResult] = useState<MaintenanceImportResult | null>(null)
  const [stockResult, setStockResult] = useState<StockImportResult | null>(null)
  const [error, setError] = useState('')
  const [showAnomalies, setShowAnomalies] = useState(false)

  async function handleFiles(files: File[]) {
    setLoading(true)
    setFileCount(files.length)
    setProgressCount(0)
    setError('')
    setMaintResult(null)
    setStockResult(null)
    try {
      let mergedMaint: MaintenanceImportResult | null = null
      let mergedStock: StockImportResult | null = null
      const errors: string[] = []

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        try {
          const type = await detectFromFile(file)
          if (type === 'item_maintenance') {
            const r = await parseItemMaintenance(file)
            if (!mergedMaint) {
              mergedMaint = r
            } else {
              mergedMaint.updated += r.updated
              mergedMaint.newProducts += r.newProducts
              mergedMaint.skipped += r.skipped
              mergedMaint.anomalies = mergedMaint.anomalies.concat(r.anomalies)
              mergedMaint.detectedColumns = mergedMaint.detectedColumns.concat(
                r.detectedColumns.filter((c) => !mergedMaint!.detectedColumns.includes(c))
              )
              mergedMaint.lastImportedAt = r.lastImportedAt
            }
          } else if (type === 'item_stock') {
            const r = await parseStockReport(file)
            if (!mergedStock) {
              mergedStock = r
            } else {
              mergedStock.snapshots += r.snapshots
              mergedStock.matched += r.matched
              mergedStock.unmatched += r.unmatched
              mergedStock.lastImportedAt = r.lastImportedAt
            }
          } else {
            errors.push(`${file.name}: could not detect report type`)
          }
        } catch (e) {
          errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`)
        }
        setProgressCount(i + 1)
      }

      if (mergedMaint) setMaintResult(mergedMaint)
      if (mergedStock) setStockResult(mergedStock)
      if (errors.length) setError(errors.join('\n'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      <DropZone onFiles={handleFiles} loading={loading} label="Drop Smart Retail exports here" multiple
        fileCount={fileCount} progressCount={progressCount} />

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
          {maintResult.detectedColumns.length > 0 && (
            <details className="mt-1.5 ml-5">
              <summary className="text-xs text-gray-500 cursor-pointer select-none">
                Detected columns ({maintResult.detectedColumns.filter((c) => c.startsWith('✓')).length}/{maintResult.detectedColumns.length} matched)
              </summary>
              <ul className="mt-1 space-y-0.5">
                {maintResult.detectedColumns.map((c, i) => (
                  <li key={i} className={`text-[11px] ${c.startsWith('✓') ? 'text-green-700' : 'text-red-600 font-medium'}`}>{c}</li>
                ))}
              </ul>
            </details>
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

type PdfFileResult = {
  file: string
  parsed?: ParsedInvoice
  error?: string
}

function InvoiceSection() {
  const [pasteText, setPasteText] = useState('')
  const [parsed, setParsed] = useState<ParsedInvoice | null>(null)
  const [parseError, setParseError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfFileCount, setPdfFileCount] = useState(0)
  const [pdfProgress, setPdfProgress] = useState(0)
  const [showLines, setShowLines] = useState(false)
  const [rawTextPreview, setRawTextPreview] = useState('')
  // Multi-file batch results
  const [batchResults, setBatchResults] = useState<PdfFileResult[]>([])
  const [batchSaveMsg, setBatchSaveMsg] = useState('')

  function handleParse() {
    setParseError('')
    setSaveMsg('')
    setParsed(null)
    setRawTextPreview('')
    setBatchResults([])
    setBatchSaveMsg('')
    const text = pasteText.trim()
    if (!text) { setParseError('Paste invoice text first.'); return }
    try {
      const result = parseInvoiceText(text)
      if (!result) {
        setParseError('Could not find a Document Number — check the pasted text is a complete Lactalis invoice.')
        return
      }
      if (result.lineCount === 0 && result.unparsedLines.length === 0) {
        setParseError('No line items found. Verify the invoice text is complete.')
        return
      }
      if (result.lineCount === 0) {
        setParseError('Product codes were found but line items could not be fully parsed — see the warning below.')
      }
      setParsed(result)
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handlePDFs(files: File[]) {
    setPdfLoading(true)
    setPdfFileCount(files.length)
    setPdfProgress(0)
    setParseError('')
    setParsed(null)
    setRawTextPreview('')
    setBatchResults([])
    setBatchSaveMsg('')
    setSaveMsg('')

    // Single file — keep original flow with paste-text + preview
    if (files.length === 1) {
      const file = files[0]
      try {
        const text = await extractTextFromPDF(file)
        setPasteText(text)
        setRawTextPreview(text.slice(0, 1000))
        const result = parseInvoiceText(text)
        if (!result) {
          setParseError('Could not extract Document Number from PDF — paste the text manually instead.')
        } else if (result.lineCount === 0 && result.unparsedLines.length === 0) {
          setParseError('PDF text extraction produced no line items — paste the text manually instead.')
        } else {
          if (result.lineCount === 0) {
            setParseError('Product codes were found but line items could not be fully parsed — see the warning below.')
          }
          setParsed(result)
        }
      } catch (e) {
        setParseError(`PDF extraction failed: ${e instanceof Error ? e.message : String(e)}. Paste the text manually.`)
      } finally {
        setPdfLoading(false)
      }
      return
    }

    // Multi-file batch
    const results: PdfFileResult[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      try {
        const text = await extractTextFromPDF(file)
        const result = parseInvoiceText(text)
        if (!result) {
          results.push({ file: file.name, error: 'No Document Number found' })
        } else if (result.lineCount === 0) {
          results.push({ file: file.name, error: 'No line items parsed' })
        } else {
          results.push({ file: file.name, parsed: result })
        }
      } catch (e) {
        results.push({ file: file.name, error: e instanceof Error ? e.message : String(e) })
      }
      setPdfProgress(i + 1)
    }
    setBatchResults(results)

    // Auto-save all successfully parsed invoices
    const successes = results.filter((r) => r.parsed)
    let saved = 0
    let skipped = 0
    const saveErrors: string[] = []
    for (const r of successes) {
      try {
        const res = await saveInvoice(r.parsed!)
        if (res.saved) saved++
        else skipped++
      } catch (e) {
        saveErrors.push(`${r.file}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const parts: string[] = []
    if (saved) parts.push(`${saved} invoice${saved > 1 ? 's' : ''} saved`)
    if (skipped) parts.push(`${skipped} skipped (duplicate)`)
    if (saveErrors.length) parts.push(`${saveErrors.length} save error${saveErrors.length > 1 ? 's' : ''}`)
    setBatchSaveMsg(parts.join(', '))

    setPdfLoading(false)
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

  const batchTotalFiles = batchResults.length
  const batchSuccessCount = batchResults.filter((r) => r.parsed).length
  const batchErrorCount = batchResults.filter((r) => r.error).length
  const batchTotalLines = batchResults.reduce((sum, r) => sum + (r.parsed?.lineCount ?? 0), 0)

  return (
    <div className="space-y-3">
      {/* PDF upload */}
      <DropZone
        onFiles={handlePDFs}
        loading={pdfLoading}
        label="Drop Lactalis PDF invoices here"
        accept=".pdf"
        multiple
        fileCount={pdfFileCount}
        progressCount={pdfProgress}
      />

      {/* Batch results */}
      {batchResults.length > 0 && (
        <div className="border border-blue-200 rounded-lg overflow-hidden">
          <div className="bg-blue-50 px-3 py-2">
            <p className="text-sm font-semibold text-blue-900">
              Batch Import: {batchTotalFiles} files
            </p>
            <p className="text-xs text-blue-700">
              {batchSuccessCount} parsed · {batchTotalLines} total items
              {batchErrorCount > 0 && ` · ${batchErrorCount} failed`}
            </p>
          </div>
          <div className="divide-y divide-gray-100 max-h-48 overflow-auto">
            {batchResults.map((r, i) => (
              <div key={i} className="px-3 py-1.5 flex items-center gap-2">
                {r.parsed
                  ? <CheckCircle size={13} className="text-green-600 shrink-0" />
                  : <AlertTriangle size={13} className="text-red-500 shrink-0" />}
                <span className="text-xs text-gray-700 truncate flex-1">{r.file}</span>
                {r.parsed && (
                  <span className="text-[11px] text-gray-500 shrink-0">
                    #{r.parsed.documentNumber} · {r.parsed.lineCount} items
                  </span>
                )}
                {r.error && (
                  <span className="text-[11px] text-red-600 shrink-0">{r.error}</span>
                )}
              </div>
            ))}
          </div>
          {batchSaveMsg && (
            <div className="px-3 py-2 bg-green-50 border-t border-green-200">
              <p className="text-xs text-green-800 flex items-center gap-1">
                <CheckCircle size={12} /> {batchSaveMsg}
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-gray-400">
        <div className="flex-1 h-px bg-gray-200" />
        <span>or paste invoice text</span>
        <div className="flex-1 h-px bg-gray-200" />
      </div>

      {/* Paste area */}
      <textarea
        value={pasteText}
        onChange={(e) => { setPasteText(e.target.value); setParsed(null); setSaveMsg(''); setRawTextPreview(''); setBatchResults([]) }}
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

      {/* Raw PDF text preview — diagnostic tool for bad extractions */}
      {rawTextPreview && (
        <details className="border border-gray-200 rounded-lg overflow-hidden">
          <summary className="px-3 py-2 bg-gray-50 text-xs text-gray-600 cursor-pointer select-none flex items-center gap-1">
            <Eye size={11} /> Raw PDF text preview (first 1000 chars)
          </summary>
          <pre className="px-3 py-2 text-[11px] font-mono text-gray-700 whitespace-pre-wrap break-all max-h-48 overflow-auto">
            {rawTextPreview}
          </pre>
        </details>
      )}

      {/* Preview (single file) */}
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

          {parsed.unparsedLines.length > 0 && (
            <div className="px-3 py-2 bg-amber-50 border-t border-amber-200">
              <p className="text-xs font-medium text-amber-800 mb-1 flex items-center gap-1">
                <AlertTriangle size={11} />
                {parsed.unparsedLines.length} product code{parsed.unparsedLines.length > 1 ? 's' : ''} found but couldn't be fully parsed — skipped
              </p>
              <ul className="space-y-0.5">
                {parsed.unparsedLines.map((l, i) => (
                  <li key={i} className="text-[11px] font-mono text-amber-900 bg-amber-100 rounded px-1.5 py-0.5 break-all">{l}</li>
                ))}
              </ul>
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

// ─── Gmail Section ────────────────────────────────────────────────────────────

function GmailSection() {
  const [connected, setConnected] = useState(isGmailConnected)
  const [email, setEmail] = useState<string | null>(null)

  // Pre-load GIS + token client so requestAccessToken() fires synchronously on tap (mobile fix)
  useEffect(() => { prepareGmailClient().catch(console.warn) }, [])
  const [syncing, setSyncing] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [lastSync, setLastSync] = useState<string | null>(getGmailLastSync)
  const [result, setResult] = useState<{ count: number; processed: number; found: number; errors: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleConnect() {
    setConnecting(true)
    setError(null)
    try {
      const addr = await connectGmail()
      setEmail(addr)
      setConnected(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setConnecting(false)
    }
  }

  async function handleSync() {
    setSyncing(true)
    setError(null)
    setResult(null)
    try {
      const r = await syncGmailOrders()
      setResult(r)
      setLastSync(getGmailLastSync())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSyncing(false)
    }
  }

  function handleDisconnect() {
    disconnectGmail()
    setConnected(false)
    setEmail(null)
    setResult(null)
  }

  return (
    <div className="space-y-3">
      {/* Status card */}
      <div className={`rounded-xl border p-3 ${connected ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-200'}`}>
        <div className="flex items-center gap-2">
          <Mail size={14} className={connected ? 'text-green-600' : 'text-gray-400'} />
          <span className="text-sm font-medium text-gray-800">
            {connected
              ? email ? `Connected as ${email}` : 'Gmail connected'
              : 'Not connected'}
          </span>
        </div>
        {lastSync && connected && (
          <p className="text-[11px] text-gray-500 mt-1 ml-5">
            Last sync: {new Date(lastSync).toLocaleString('en-AU', {
              day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
            })}
          </p>
        )}
      </div>

      {!connected ? (
        <button
          onClick={handleConnect}
          disabled={connecting || !localStorage.getItem('milk-manager-gmail-client-id')}
          className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg disabled:opacity-40"
        >
          {connecting ? <RefreshCw size={14} className="animate-spin" /> : <Mail size={14} />}
          {connecting ? 'Connecting...' : 'Connect Gmail'}
        </button>
      ) : (
        <button
          onClick={handleSync}
          disabled={syncing}
          className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg disabled:opacity-40"
        >
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Syncing...' : 'Sync Orders from Gmail'}
        </button>
      )}

      {!connected && !localStorage.getItem('milk-manager-gmail-client-id') && (
        <p className="text-[11px] text-amber-600">
          Set your Gmail OAuth Client ID in Settings → Gmail Sync first.
        </p>
      )}

      {result && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg space-y-1">
          <div className="flex items-center gap-2">
            <CheckCircle size={14} className="text-green-600" />
            <span className="text-sm font-medium text-green-800">Sync complete</span>
          </div>
          <p className="text-xs text-green-700 ml-5">
            {result.found} email{result.found !== 1 ? 's' : ''} found, {result.processed} scanned, {result.count} order{result.count !== 1 ? 's' : ''} imported
          </p>
          {result.errors.length > 0 && (
            <div className="ml-5 mt-1 space-y-0.5">
              {result.errors.map((e, i) => (
                <p key={i} className="text-[11px] text-amber-700">{e}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
          <AlertTriangle size={14} className="text-red-500 shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {connected && (
        <button
          onClick={handleDisconnect}
          className="text-[11px] text-gray-400 underline w-full text-center"
        >
          Disconnect Gmail
        </button>
      )}
    </div>
  )
}

// ─── Main ImportTab ───────────────────────────────────────────────────────────

export default function ImportTab() {
  return (
    <div className="p-4 space-y-6 pb-8">
      <DataStatus />
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

      <div className="border-t border-gray-200" />

      <section>
        <div className="flex items-center gap-2 mb-2">
          <Mail size={18} className="text-purple-600" />
          <h2 className="text-base font-semibold text-gray-900">Gmail Order History</h2>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Import order history directly from Lactalis confirmation emails in your Gmail.
        </p>
        <GmailSection />
      </section>
    </div>
  )
}
