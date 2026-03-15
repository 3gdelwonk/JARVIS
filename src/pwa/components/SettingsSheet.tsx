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
import { Download, Upload, X, RotateCcw } from 'lucide-react'
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
  const restoreInputRef = useRef<HTMLInputElement>(null)

  async function handleBackup() {
    try {
      setBackupStatus('Exporting…')
      const json = await exportAllData()
      const date = new Date().toISOString().slice(0, 10)
      const filename = `milk-manager-backup-${date}.json`
      const blob = new Blob([json], { type: 'application/json' })
      // Use native share sheet on mobile (iOS/Android)
      if (navigator.canShare?.({ files: [new File([blob], filename)] })) {
        const file = new File([blob], filename, { type: 'application/json' })
        await navigator.share({ files: [file], title: 'Milk Manager Backup' })
        localStorage.setItem('milk-manager-last-backup', new Date().toISOString())
        setBackupStatus('Shared ✓')
      } else {
        downloadBackup(json)
        localStorage.setItem('milk-manager-last-backup', new Date().toISOString())
        setBackupStatus('Backup downloaded')
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setBackupStatus(`Error: ${(e as Error).message}`)
      } else {
        setBackupStatus(null)
      }
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

          {/* Backup / Restore */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-sm font-medium text-gray-700 mb-0.5">Backup & Transfer</p>
            <p className="text-[11px] text-gray-400 mb-2">Share your data to any device via AirDrop, Messages, or email</p>
            <div className="flex gap-2">
              <button
                onClick={handleBackup}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700"
              >
                <Download size={14} />
                Export & Share
              </button>
              <button
                onClick={handleRestoreClick}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700"
              >
                <Upload size={14} />
                Restore
              </button>
              <input
                ref={restoreInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={handleRestoreFile}
              />
            </div>
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
