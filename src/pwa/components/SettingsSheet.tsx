/**
 * SettingsSheet.tsx — Forecast settings bottom sheet
 *
 * Slide-up panel for adjusting ForecastSettings:
 *  - Lead time days (1–3)
 *  - Safety stock multiplier (0–3, step 0.1)
 *  - Target days of stock (1–14)
 *  - Global order multiplier (0.5–2.0, step 0.05)
 */

import { useRef, useState, useEffect } from 'react'
import { Download, Upload, X, RotateCcw, Wifi, RefreshCw, Cloud, Mail } from 'lucide-react'
import {
  getSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  type ForecastSettings,
} from '../lib/forecastEngine'
import { exportAllData, downloadBackup, importAllData } from '../lib/dataExport'
import {
  getRelayUrl,
  setRelayUrl,
  getApiKey,
  setApiKey,
  checkRelay,
} from '../lib/lactalisRelay'
import { checkPos } from '../lib/posRelay'
import { fullSync, getSyncStatus, type SyncStatus } from '../lib/cloudSync'
import {
  prepareGmailClient,
  connectGmail,
  disconnectGmail,
  syncGmailOrders,
  isGmailConnected,
  getGmailLastSync,
} from '../lib/gmailSync'

interface Props {
  onClose: () => void
}

export default function SettingsSheet({ onClose }: Props) {
  const [s, setS] = useState<ForecastSettings>(() => getSettings())
  const [backupStatus, setBackupStatus] = useState<string | null>(null)
  const restoreInputRef = useRef<HTMLInputElement>(null)

  // JARVISmart relay settings
  const [relayUrl, setRelayUrlState] = useState(() => getRelayUrl())
  const [apiKey, setApiKeyState] = useState(() => getApiKey())
  const [relayStatus, setRelayStatus] = useState<{ ok: boolean; msg: string } | null>(null)
  const [posStatus, setPosStatus] = useState<{ ok: boolean; msg: string } | null>(null)
  const [relayChecking, setRelayChecking] = useState(false)

  // Cloud sync state
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() => getSyncStatus())
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  // Gmail sync state
  const [gmailClientId, setGmailClientId] = useState(() => localStorage.getItem('milk-manager-gmail-client-id') || '')
  const [gmailConnected, setGmailConnected] = useState(() => isGmailConnected())
  const [gmailAutoSync, setGmailAutoSync] = useState(() => localStorage.getItem('milk-manager-gmail-auto-sync') === 'true')
  const [gmailLastSync, setGmailLastSync] = useState(() => getGmailLastSync())
  const [gmailStatus, setGmailStatus] = useState<string | null>(null)
  const [gmailBusy, setGmailBusy] = useState(false)

  useEffect(() => {
    setSyncStatus(getSyncStatus())
    prepareGmailClient()
  }, [])

  async function handleTestRelay() {
    setRelayChecking(true)
    setRelayStatus(null)
    setPosStatus(null)
    // Save current values before testing
    setRelayUrl(relayUrl)
    setApiKey(apiKey)
    try {
      const [health, pos] = await Promise.all([checkRelay(), checkPos()])
      setRelayStatus(health.connected
        ? { ok: true, msg: health.cookieAge ? `Connected (cookies ${health.cookieAge} old)` : 'Connected' }
        : { ok: false, msg: health.reason || (health.configured === false ? 'Credentials not configured on server' : 'Not connected') }
      )
      setPosStatus(pos.connected
        ? { ok: true, msg: 'Connected' }
        : { ok: false, msg: pos.reason || 'Not connected' }
      )
    } catch (err: any) {
      setRelayStatus({ ok: false, msg: err.message })
    }
    setRelayChecking(false)
  }

  async function handleSyncNow() {
    setSyncing(true)
    setSyncMsg(null)
    try {
      await fullSync()
      setSyncStatus(getSyncStatus())
      setSyncMsg('Sync complete')
    } catch (err: any) {
      setSyncMsg(`Sync failed: ${err.message}`)
    }
    setSyncing(false)
  }

  function handleGmailClientIdSave() {
    const trimmed = gmailClientId.trim()
    if (trimmed) {
      localStorage.setItem('milk-manager-gmail-client-id', trimmed)
      prepareGmailClient()
    } else {
      localStorage.removeItem('milk-manager-gmail-client-id')
    }
  }

  async function handleGmailConnect() {
    handleGmailClientIdSave()
    setGmailStatus(null)
    try {
      const email = await connectGmail()
      setGmailConnected(true)
      setGmailStatus(`Connected as ${email}`)
    } catch (err: any) {
      setGmailStatus(`Failed: ${err.message}`)
    }
  }

  function handleGmailDisconnect() {
    disconnectGmail()
    setGmailConnected(false)
    setGmailAutoSync(false)
    setGmailStatus('Disconnected')
  }

  function handleGmailAutoToggle() {
    const next = !gmailAutoSync
    setGmailAutoSync(next)
    localStorage.setItem('milk-manager-gmail-auto-sync', String(next))
  }

  async function handleGmailSyncNow() {
    handleGmailClientIdSave()
    setGmailBusy(true)
    setGmailStatus(null)
    try {
      const result = await syncGmailOrders()
      setGmailLastSync(getGmailLastSync())
      setGmailConnected(isGmailConnected())
      const parts = [`${result.processed} emails scanned`]
      if (result.count > 0) parts.push(`${result.count} orders imported`)
      if (result.errors.length > 0) parts.push(`${result.errors.length} errors`)
      setGmailStatus(parts.join(', '))
    } catch (err: any) {
      setGmailStatus(`Sync failed: ${err.message}`)
    }
    setGmailBusy(false)
  }

  async function handleBackup() {
    try {
      setBackupStatus('Exporting…')
      const json = await exportAllData()
      downloadBackup(json)
      setBackupStatus('Backup downloaded')
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
      setBackupStatus('Restore complete — reload to see changes')
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
    setRelayUrl(relayUrl)
    setApiKey(apiKey)
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

          {/* JARVISmart Connection */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-sm font-medium text-gray-700 mb-2">JARVISmart Connection</p>
            <div className="space-y-3">
              <div>
                <label htmlFor="relay-url" className="text-[11px] text-gray-500 block mb-0.5">Server URL</label>
                <input
                  id="relay-url"
                  type="url"
                  value={relayUrl}
                  onChange={(e) => setRelayUrlState(e.target.value)}
                  placeholder="https://your-tunnel.trycloudflare.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div>
                <label htmlFor="api-key" className="text-[11px] text-gray-500 block mb-0.5">API Key</label>
                <input
                  id="api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKeyState(e.target.value)}
                  placeholder="jmart_milk_ak_..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                />
              </div>
              <button
                onClick={handleTestRelay}
                disabled={relayChecking}
                className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 disabled:opacity-50"
              >
                <Wifi size={14} />
                {relayChecking ? 'Testing…' : 'Test Connection'}
              </button>
              {posStatus && (
                <p className={`text-[11px] ${posStatus.ok ? 'text-green-600' : 'text-red-500'}`}>
                  {posStatus.ok ? '✓' : '✗'} POS Data: {posStatus.msg}
                </p>
              )}
              {relayStatus && (
                <p className={`text-[11px] ${relayStatus.ok ? 'text-green-600' : 'text-red-500'}`}>
                  {relayStatus.ok ? '✓' : '✗'} Lactalis Relay: {relayStatus.msg}
                </p>
              )}
              <p className="text-[11px] text-gray-400">
                Enter your Cloudflare Tunnel URL for remote access, or LAN IP for in-store use.
              </p>
            </div>
          </div>

          {/* Cloud Sync */}
          <div className="border-t border-gray-100 pt-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium text-gray-700">Cloud Sync</p>
              {syncStatus.lastPull && (
                <span className="text-[11px] text-gray-400">
                  Last: {new Date(syncStatus.lastPull).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
            <div className="space-y-2">
              <button
                onClick={handleSyncNow}
                disabled={syncing}
                className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 disabled:opacity-50"
              >
                {syncing ? <RefreshCw size={14} className="animate-spin" /> : <Cloud size={14} />}
                {syncing ? 'Syncing…' : 'Sync Now'}
              </button>
              {syncMsg && (
                <p className={`text-[11px] ${syncMsg.includes('failed') ? 'text-red-500' : 'text-green-600'}`}>
                  {syncMsg}
                </p>
              )}
              <p className="text-[11px] text-gray-400">
                Device: {syncStatus.deviceId.slice(0, 8)}… · Syncs automatically every 12 hours
              </p>
            </div>
          </div>

          {/* Gmail Order Sync */}
          <div className="border-t border-gray-100 pt-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium text-gray-700">Gmail Order Sync</p>
              {gmailConnected && (
                <span className="text-[11px] text-green-600">Connected</span>
              )}
            </div>
            <div className="space-y-3">
              <div>
                <label htmlFor="gmail-client-id" className="text-[11px] text-gray-500 block mb-0.5">Google OAuth Client ID</label>
                <input
                  id="gmail-client-id"
                  type="text"
                  value={gmailClientId}
                  onChange={(e) => setGmailClientId(e.target.value)}
                  placeholder="123456789.apps.googleusercontent.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                />
              </div>
              <div className="flex gap-2">
                {!gmailConnected ? (
                  <button
                    onClick={handleGmailConnect}
                    disabled={!gmailClientId.trim()}
                    className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 disabled:opacity-50"
                  >
                    <Mail size={14} />
                    Connect Gmail
                  </button>
                ) : (
                  <>
                    <button
                      onClick={handleGmailSyncNow}
                      disabled={gmailBusy}
                      className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 disabled:opacity-50"
                    >
                      <RefreshCw size={14} className={gmailBusy ? 'animate-spin' : ''} />
                      {gmailBusy ? 'Scanning…' : 'Sync Now'}
                    </button>
                    <button
                      onClick={handleGmailDisconnect}
                      className="px-3 py-2 border border-red-200 rounded-lg text-sm text-red-500"
                    >
                      Disconnect
                    </button>
                  </>
                )}
              </div>
              {gmailConnected && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={gmailAutoSync}
                    onChange={handleGmailAutoToggle}
                    className="accent-blue-600"
                  />
                  <span className="text-[11px] text-gray-600">Auto-sync on app load</span>
                </label>
              )}
              {gmailStatus && (
                <p className={`text-[11px] ${gmailStatus.includes('Failed') || gmailStatus.includes('failed') ? 'text-red-500' : 'text-green-600'}`}>
                  {gmailStatus}
                </p>
              )}
              {gmailLastSync && (
                <p className="text-[11px] text-gray-400">
                  Last scan: {new Date(gmailLastSync).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </p>
              )}
              <p className="text-[11px] text-gray-400">
                Scans Lactalis order confirmation emails. Imported orders sync to other devices via Cloud Sync.
              </p>
            </div>
          </div>

          {/* Backup / Restore */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-sm font-medium text-gray-700 mb-2">Data Backup</p>
            <div className="flex gap-2">
              <button
                onClick={handleBackup}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700"
              >
                <Download size={14} />
                Export Backup
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
              <p className="text-[11px] text-gray-500 mt-1.5">{backupStatus}</p>
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
