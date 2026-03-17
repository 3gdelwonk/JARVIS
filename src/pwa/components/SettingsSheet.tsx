/**
 * SettingsSheet.tsx — Forecast settings bottom sheet
 *
 * Slide-up panel for adjusting ForecastSettings:
 *  - Lead time days (1–3)
 *  - Safety stock multiplier (0–3, step 0.1)
 *  - Target days of stock (1–14)
 *  - Global order multiplier (0.5–2.0, step 0.05)
 */

import { useRef, useState } from 'react'
import { Clipboard, Download, Upload, X, RotateCcw } from 'lucide-react'
import {
  getSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  type ForecastSettings,
} from '../lib/forecastEngine'
import { exportAllData, downloadBackup, importAllData } from '../lib/dataExport'

interface Props {
  onClose: () => void
}

export default function SettingsSheet({ onClose }: Props) {
  const [s, setS] = useState<ForecastSettings>(() => getSettings())
  const [backupStatus, setBackupStatus] = useState<string | null>(null)
  const [transferJson, setTransferJson] = useState<string | null>(null)
  const [hasCopied, setHasCopied] = useState(false)
  const [pasteMode, setPasteMode] = useState(false)
  const [pastedText, setPastedText] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const restoreInputRef = useRef<HTMLInputElement>(null)
  const [geminiKey, setGeminiKey] = useState(() => localStorage.getItem('milk-manager-gemini-key') ?? '')
  const [geminiKeySaved, setGeminiKeySaved] = useState(false)
  const [storeName, setStoreName] = useState(() => localStorage.getItem('milk-manager-store-name') ?? '')
  const [lactalisEmail, setLactalisEmail] = useState(() => localStorage.getItem('milk-manager-lactalis-email') ?? '')
  const [storeInfoSaved, setStoreInfoSaved] = useState(false)
  const [workerUrl, setWorkerUrl] = useState(() => localStorage.getItem('milk-manager-worker-url') ?? '')
  const [workerUrlSaved, setWorkerUrlSaved] = useState(false)
  const [extSecret, setExtSecret] = useState(() => localStorage.getItem('milk-manager-ext-secret') ?? '')
  const [extSecretSaved, setExtSecretSaved] = useState(false)
  const [bookmarkletCopied, setBookmarkletCopied] = useState(false)

  async function handleBackup() {
    try {
      setBackupStatus('Exporting…')
      const json = await exportAllData()
      const date = new Date().toISOString().slice(0, 10)
      const filename = `milk-manager-backup-${date}.json`
      const blob = new Blob([json], { type: 'application/json' })

      let shared = false
      if (navigator.canShare?.({ files: [new File([blob], filename)] })) {
        try {
          await navigator.share({ files: [new File([blob], filename, { type: 'application/json' })], title: 'Milk Manager Backup' })
          shared = true
          localStorage.setItem('milk-manager-last-backup', new Date().toISOString())
          setBackupStatus('Shared ✓')
        } catch (shareErr) {
          if ((shareErr as Error).name === 'AbortError') {
            setBackupStatus(null)
            return
          }
          // Share failed on desktop — fall through to download
        }
      }
      if (!shared) {
        downloadBackup(json)
        localStorage.setItem('milk-manager-last-backup', new Date().toISOString())
        setBackupStatus('Backup downloaded')
        setTransferJson(json)
      }
    } catch (e) {
      setBackupStatus(`Error: ${(e as Error).message}`)
    }
  }

  function handleRestoreClick() {
    restoreInputRef.current?.click()
  }

  async function handleRestoreFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      setBackupStatus('Restoring…')
      const text = await file.text()
      await importAllData(text)
      setBackupStatus('Restore complete')
    } catch (err) {
      setBackupStatus(`Restore failed: ${(err as Error).message}`)
    }
    // Reset file input so same file can be re-selected
    e.target.value = ''
  }

  async function handleCopyJson() {
    if (!transferJson) return
    await navigator.clipboard.writeText(transferJson)
    setHasCopied(true)
    setTimeout(() => setHasCopied(false), 2000)
  }

  async function handlePasteImport() {
    setPasteError(null)
    try {
      setBackupStatus('Restoring…')
      await importAllData(pastedText)
      setBackupStatus('Restore complete')
      setPasteMode(false)
      setPastedText('')
    } catch (err) {
      setPasteError(`Import failed: ${(err as Error).message}`)
      setBackupStatus(null)
    }
  }

  function set<K extends keyof ForecastSettings>(key: K, value: ForecastSettings[K]) {
    setS((prev) => ({ ...prev, [key]: value }))
  }

  function handleSave() {
    saveSettings(s)
    onClose()
  }

  function handleReset() {
    setS({ ...DEFAULT_SETTINGS })
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] bg-white rounded-t-2xl z-50 shadow-2xl">
        {/* Handle bar */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-gray-300 rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Forecast Settings</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-gray-100 text-gray-500"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Controls */}
        <div className="px-4 py-4 space-y-5 overflow-y-auto max-h-[70vh]">

          {/* Lead time */}
          <div>
            <div className="flex justify-between items-baseline mb-1">
              <label htmlFor="setting-lead-time" className="text-sm font-medium text-gray-700">Lead Time</label>
              <span className="text-sm font-semibold text-blue-600">
                {s.leadTimeDays} day{s.leadTimeDays !== 1 ? 's' : ''}
              </span>
            </div>
            <input
              id="setting-lead-time"
              type="range"
              min={1}
              max={3}
              step={1}
              value={s.leadTimeDays}
              onChange={(e) => set('leadTimeDays', Number(e.target.value))}
              className="w-full accent-blue-600"
            />
            <p className="text-[11px] text-gray-400 mt-0.5">
              Hours between placing order and delivery, expressed in days. Default: 1.
            </p>
          </div>

          {/* Safety stock multiplier */}
          <div>
            <div className="flex justify-between items-baseline mb-1">
              <label htmlFor="setting-safety-stock" className="text-sm font-medium text-gray-700">Safety Stock Multiplier</label>
              <span className="text-sm font-semibold text-blue-600">
                ×{s.safetyStockMultiplier.toFixed(1)}
              </span>
            </div>
            <input
              id="setting-safety-stock"
              type="range"
              min={0}
              max={3}
              step={0.1}
              value={s.safetyStockMultiplier}
              onChange={(e) => set('safetyStockMultiplier', Number(e.target.value))}
              className="w-full accent-blue-600"
            />
            <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
              <span>0 = no buffer</span>
              <span>1.5 = FMCG standard</span>
              <span>3 = very conservative</span>
            </div>
          </div>

          {/* Target days of stock */}
          <div>
            <div className="flex justify-between items-baseline mb-1">
              <label htmlFor="setting-target-days" className="text-sm font-medium text-gray-700">Target Days of Stock</label>
              <span className="text-sm font-semibold text-blue-600">
                {s.targetDaysOfStock} days
              </span>
            </div>
            <input
              id="setting-target-days"
              type="range"
              min={1}
              max={14}
              step={1}
              value={s.targetDaysOfStock}
              onChange={(e) => set('targetDaysOfStock', Number(e.target.value))}
              className="w-full accent-blue-600"
            />
            <p className="text-[11px] text-gray-400 mt-0.5">
              How many days of stock to carry after each delivery. Default: 4. Per-product
              overrides take priority.
            </p>
          </div>

          {/* Global multiplier */}
          <div>
            <div className="flex justify-between items-baseline mb-1">
              <label htmlFor="setting-global-mult" className="text-sm font-medium text-gray-700">Global Order Multiplier</label>
              <span className="text-sm font-semibold text-blue-600">
                ×{s.globalMultiplier.toFixed(2)}
              </span>
            </div>
            <input
              id="setting-global-mult"
              type="range"
              min={0.5}
              max={2.0}
              step={0.05}
              value={s.globalMultiplier}
              onChange={(e) => set('globalMultiplier', Number(e.target.value))}
              className="w-full accent-blue-600"
            />
            <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
              <span>0.5× = reduce all</span>
              <span>1.0 = as forecast</span>
              <span>2.0× = double all</span>
            </div>
          </div>

          {/* Formula reminder */}
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-[11px] text-gray-500 font-mono leading-relaxed">
              qty = (targetDays × avgDaily) + ({s.safetyStockMultiplier.toFixed(1)}σ × √{s.leadTimeDays}) − stock
              <br />
              × {s.globalMultiplier.toFixed(2)} global
            </p>
          </div>

          {/* Gemini API Key */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-sm font-medium text-gray-700 mb-0.5">Gemini API Key</p>
            <p className="text-[11px] text-gray-400 mb-2">
              Used for invoice &amp; waste photo scanning. Free at{' '}
              <a href="https://aistudio.google.com" target="_blank" rel="noopener noreferrer" className="text-blue-500 underline">
                aistudio.google.com
              </a>
            </p>
            <input
              type="password"
              placeholder="AIza..."
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono mb-2"
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  localStorage.setItem('milk-manager-gemini-key', geminiKey.trim())
                  setGeminiKeySaved(true)
                  setTimeout(() => setGeminiKeySaved(false), 2000)
                }}
                disabled={!geminiKey.trim()}
                className="flex-1 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg disabled:opacity-40"
              >
                {geminiKeySaved ? 'Saved ✓' : 'Save Key'}
              </button>
              {geminiKey && (
                <button
                  onClick={() => { localStorage.removeItem('milk-manager-gemini-key'); setGeminiKey('') }}
                  className="px-3 py-2 border border-red-200 text-red-600 text-sm rounded-lg"
                >
                  Remove
                </button>
              )}
            </div>
          </div>

          {/* Store Info */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-sm font-medium text-gray-700 mb-0.5">Store Info</p>
            <p className="text-[11px] text-gray-400 mb-2">
              Used when generating claim emails to Lactalis.
            </p>
            <div className="flex flex-col gap-2 mb-2">
              <input
                type="text"
                placeholder="Store name (e.g. IGA Camberwell)"
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
              <input
                type="email"
                placeholder="Lactalis claims email"
                value={lactalisEmail}
                onChange={(e) => setLactalisEmail(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
              {!lactalisEmail && (
                <p className="text-[11px] text-gray-400">Default: customer.service@lactalis.com.au</p>
              )}
            </div>
            <button
              onClick={() => {
                localStorage.setItem('milk-manager-store-name', storeName.trim())
                localStorage.setItem(
                  'milk-manager-lactalis-email',
                  lactalisEmail.trim() || 'customer.service@lactalis.com.au',
                )
                setStoreInfoSaved(true)
                setTimeout(() => setStoreInfoSaved(false), 2000)
              }}
              className="w-full py-2 bg-blue-600 text-white text-sm font-medium rounded-lg"
            >
              {storeInfoSaved ? 'Saved ✓' : 'Save Store Info'}
            </button>
          </div>

          {/* Worker URL (Cloud Relay) */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-sm font-medium text-gray-700 mb-0.5">Cloud Relay</p>
            <p className="text-[11px] text-gray-400 mb-2">
              Worker URL for cloud schedule sync and order relay via the desktop extension.
            </p>
            <input
              type="text"
              placeholder="https://your-worker.workers.dev"
              value={workerUrl}
              onChange={(e) => setWorkerUrl(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono mb-2"
            />
            <button
              onClick={() => {
                localStorage.setItem('milk-manager-worker-url', workerUrl.trim())
                setWorkerUrlSaved(true)
                setTimeout(() => setWorkerUrlSaved(false), 2000)
              }}
              className="w-full py-2 bg-blue-600 text-white text-sm font-medium rounded-lg"
            >
              {workerUrlSaved ? 'Saved' : 'Save Worker URL'}
            </button>
          </div>

          {/* Lactalis Bookmarklet */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-sm font-medium text-gray-700 mb-0.5">Lactalis Bookmarklet</p>
            <p className="text-[11px] text-gray-400 mb-2">
              Sync schedules and submit orders from your phone browser — no extension needed.
              Log into mylactalis.com.au on your phone, then tap the bookmarklet.
            </p>
            <input
              type="password"
              placeholder="Extension secret"
              value={extSecret}
              onChange={(e) => setExtSecret(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono mb-2"
            />
            <div className="flex gap-2 mb-2">
              <button
                onClick={() => {
                  localStorage.setItem('milk-manager-ext-secret', extSecret.trim())
                  setExtSecretSaved(true)
                  setTimeout(() => setExtSecretSaved(false), 2000)
                }}
                disabled={!extSecret.trim()}
                className="flex-1 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg disabled:opacity-40"
              >
                {extSecretSaved ? 'Saved' : 'Save Secret'}
              </button>
              <button
                onClick={async () => {
                  const w = workerUrl.trim() || localStorage.getItem('milk-manager-worker-url') || ''
                  const k = extSecret.trim()
                  if (!w || !k) return
                  const config = encodeURIComponent(JSON.stringify({ w, k }))
                  const js = `javascript:void(function(){var s=document.createElement('script');s.src='https://3gdelwonk.github.io/JARVIS/lactalis-bridge.js#${config}';document.head.appendChild(s)})()`
                  await navigator.clipboard.writeText(js)
                  setBookmarkletCopied(true)
                  setTimeout(() => setBookmarkletCopied(false), 2000)
                }}
                disabled={!workerUrl.trim() || !extSecret.trim()}
                className="flex-1 py-2 border border-blue-300 text-blue-600 text-sm font-medium rounded-lg disabled:opacity-40"
              >
                {bookmarkletCopied ? 'Copied!' : 'Copy Bookmarklet'}
              </button>
            </div>
            {(!workerUrl.trim() || !extSecret.trim()) && (
              <p className="text-[11px] text-amber-600 mb-1">
                Set both Worker URL (above) and Extension Secret to generate the bookmarklet.
              </p>
            )}
            <details className="text-[11px] text-gray-400">
              <summary className="cursor-pointer text-blue-500">Installation instructions</summary>
              <div className="mt-1.5 space-y-1">
                <p><strong>iOS Safari:</strong> Copy the bookmarklet, create any bookmark, edit it, and replace the URL with the copied text.</p>
                <p><strong>Android Chrome:</strong> Copy the bookmarklet, add any page as a bookmark, edit the bookmark, and replace the URL with the copied text.</p>
                <p>Then log into mylactalis.com.au and tap the bookmark to activate.</p>
              </div>
            </details>
          </div>

          {/* Backup / Restore */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-sm font-medium text-gray-700 mb-0.5">Backup & Transfer</p>
            <p className="text-[11px] text-gray-400 mb-2">Share your data to any device via AirDrop, Messages, or email</p>
            <div className="flex gap-2 mb-2">
              <button
                onClick={handleBackup}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700"
              >
                <Download size={14} />
                Export & Share
              </button>
              <button
                onClick={() => { setPasteMode(false); handleRestoreClick() }}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border rounded-lg text-sm ${!pasteMode ? 'border-gray-400 bg-gray-50 text-gray-800 font-medium' : 'border-gray-300 text-gray-700'}`}
              >
                <Upload size={14} />
                File
              </button>
              <button
                onClick={() => setPasteMode((m) => !m)}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border rounded-lg text-sm ${pasteMode ? 'border-blue-400 bg-blue-50 text-blue-700 font-medium' : 'border-gray-300 text-gray-700'}`}
              >
                <Clipboard size={14} />
                Paste
              </button>
              <input
                ref={restoreInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={handleRestoreFile}
              />
            </div>
            {pasteMode && (
              <div className="space-y-1.5">
                <textarea
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                  placeholder="Paste JSON backup here…"
                  className="w-full h-24 text-[11px] font-mono border border-gray-200 rounded-lg p-2 resize-none text-gray-700"
                />
                {pasteError && <p className="text-[11px] text-red-500">{pasteError}</p>}
                <button
                  onClick={handlePasteImport}
                  disabled={!pastedText.trim()}
                  className="w-full py-2 bg-blue-600 text-white text-sm font-medium rounded-lg disabled:opacity-40"
                >
                  Import
                </button>
              </div>
            )}
            {backupStatus && (
              <div className="mt-1.5 flex items-center gap-2">
                <p className="text-[11px] text-gray-500">{backupStatus}</p>
                {backupStatus === 'Restore complete' && (
                  <button
                    onClick={() => window.location.reload()}
                    className="text-[11px] bg-blue-600 text-white px-2 py-0.5 rounded"
                  >
                    Reload App
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Transfer to Phone modal */}
          {transferJson && (
            <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setTransferJson(null)}>
              <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl p-4" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-base font-semibold text-gray-900">Transfer to Phone</p>
                  <button onClick={() => setTransferJson(null)} className="p-1 rounded-full hover:bg-gray-100 text-gray-500">
                    <X size={18} />
                  </button>
                </div>

                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Option A — Copy &amp; Paste</p>
                <textarea
                  readOnly
                  value={transferJson}
                  className="w-full h-16 text-[10px] font-mono border border-gray-200 rounded-lg p-2 resize-none text-gray-500 bg-gray-50"
                />
                <button
                  onClick={handleCopyJson}
                  className="mt-1.5 w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl"
                >
                  <Clipboard size={15} />
                  {hasCopied ? 'Copied ✓' : 'Copy JSON to Clipboard'}
                </button>
                <p className="text-[11px] text-gray-400 mt-1.5">
                  Paste into iMessage, WhatsApp, or email to yourself. Then on your phone: open the app → Backup → Paste.
                </p>

                <div className="border-t border-gray-100 mt-3 pt-3">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Option B — File</p>
                  <p className="text-[11px] text-gray-400">
                    File already downloaded. Save it to iCloud Drive or Google Drive, then on your phone: open the app → Backup → Restore → pick the file.
                  </p>
                </div>
              </div>
            </div>
          )}

        </div>

        {/* Footer buttons */}
        <div className="flex gap-2 px-4 py-4 border-t border-gray-100">
          <button
            onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-600"
          >
            <RotateCcw size={14} />
            Defaults
          </button>
          <button
            onClick={handleSave}
            className="flex-1 bg-blue-600 text-white text-sm font-semibold py-2 rounded-lg"
          >
            Save Settings
          </button>
        </div>
      </div>
    </>
  )
}
