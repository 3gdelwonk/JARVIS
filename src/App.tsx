/// <reference types="vite-plugin-pwa/react" />
import { Component, useEffect, useState, type ReactNode } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { BarChart2, Camera, Compass, LayoutDashboard, ShoppingCart, Package, Settings, Sparkles, Upload } from 'lucide-react'
import { seedDatabase, backfillBakedImages } from './pwa/lib/db'
import { applyStatusUpdates, applyExtensionSchedule, fetchCloudSchedule } from './pwa/lib/extensionSync'
import { syncGmailOrders, isGmailConnected } from './pwa/lib/gmailSync'
import Dashboard from './pwa/components/Dashboard'
import OrderBuilder from './pwa/components/OrderBuilder'
import MarginAnalysis from './pwa/components/MarginAnalysis'
import ImportTab from './pwa/components/ImportTab'
import ProductList from './pwa/components/ProductList'
import InsightsTab from './pwa/components/InsightsTab'
import ScannerTab from './pwa/components/ScannerTab'
import SettingsSheet from './pwa/components/SettingsSheet'
import StockPerformanceTab from './pwa/components/StockPerformanceTab'
import ProductScoutTab from './pwa/components/ProductScoutTab'

const LAST_TAB_KEY = 'milk-manager-last-tab'

// ─── Update banner ────────────────────────────────────────────────────────────

function UpdateBanner() {
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW()

  if (!needRefresh) return null

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-blue-600 text-white shrink-0 gap-3">
      <p className="text-sm">Update available — new version ready.</p>
      <div className="flex items-center gap-3 shrink-0">
        <button
          onClick={() => updateServiceWorker(true)}
          className="text-sm font-semibold underline whitespace-nowrap"
        >
          Refresh now
        </button>
        <button
          onClick={() => setNeedRefresh(false)}
          className="text-white/70 text-lg leading-none"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  )
}

// ─── Error boundary ──────────────────────────────────────────────────────────

class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, message: '' }
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error.message }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
          <p className="text-sm font-medium text-red-600">Something went wrong</p>
          <p className="text-xs text-gray-400">{this.state.message}</p>
          <button
            onClick={() => window.location.reload()}
            className="text-sm text-blue-600 underline"
          >
            Reload app
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// ─────────────────────────────────────────────────────────────────────────────

type Tab = 'dashboard' | 'order' | 'scanner' | 'products' | 'performance' | 'scout' | 'insights' | 'import' | 'margins'

const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'dashboard',   label: 'Home',    icon: <LayoutDashboard size={18} /> },
  { id: 'order',       label: 'Order',   icon: <ShoppingCart size={18} /> },
  { id: 'scanner',     label: 'Scanner', icon: <Camera size={18} /> },
  { id: 'products',    label: 'Products',icon: <Package size={18} /> },
  { id: 'performance', label: 'Perform', icon: <BarChart2 size={18} /> },
  { id: 'scout',       label: 'Scout',   icon: <Compass size={18} /> },
  { id: 'insights',    label: 'Insights',icon: <Sparkles size={18} /> },
]

const TAB_TITLES: Record<Tab, string> = {
  dashboard:   'Milk Manager',
  order:       'Order Builder',
  scanner:     'Scanner',
  products:    'Products',
  performance: 'Stock Performance',
  scout:       'Product Scout',
  insights:    'AI Insights',
  import:      'Import Data',
  margins:     'Margin Analysis',
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const saved = localStorage.getItem(LAST_TAB_KEY) as Tab | null
    return saved && tabs.some((t) => t.id === saved) ? saved : 'dashboard'
  })
  const [showSettings, setShowSettings] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // Await seed before rendering so Order Builder sees products on first load
    ;(async () => {
      await seedDatabase().catch(console.error)
      await backfillBakedImages().catch(console.error)
      await Promise.all([
        applyStatusUpdates().catch(console.error),
        applyExtensionSchedule().catch(console.error),
      ])
      setReady(true)
      // Non-blocking post-render syncs
      fetchCloudSchedule().catch(console.error)
      if (localStorage.getItem('milk-manager-gmail-auto-sync') === 'true' && isGmailConnected()) {
        syncGmailOrders().catch(console.warn)
      }
    })()

    const onStatusUpdate   = () => applyStatusUpdates().catch(console.error)
    const onScheduleUpdate = () => applyExtensionSchedule().catch(console.error)

    window.addEventListener('milk-manager-status-update',   onStatusUpdate)
    window.addEventListener('milk-manager-schedule-update', onScheduleUpdate)
    return () => {
      window.removeEventListener('milk-manager-status-update',   onStatusUpdate)
      window.removeEventListener('milk-manager-schedule-update', onScheduleUpdate)
    }
  }, [])

  function handleTabChange(tab: Tab) {
    setActiveTab(tab)
    localStorage.setItem(LAST_TAB_KEY, tab)
    setShowSettings(false)
  }

  const renderTab = () => {
    switch (activeTab) {
      case 'dashboard':   return <Dashboard onNavigateToOrder={() => handleTabChange('order')} />
      case 'order':       return <OrderBuilder />
      case 'scanner':     return <ScannerTab onNavigateToOrders={() => handleTabChange('order')} />
      case 'insights':    return <InsightsTab />
      case 'import':      return <ImportTab />
      case 'products':    return <ProductList />
      case 'margins':     return <MarginAnalysis />
      case 'performance': return <StockPerformanceTab />
      case 'scout':       return <ProductScoutTab />
      default: return <div className="p-4 text-sm text-gray-400">Unknown tab</div>
    }
  }

  return (
    <div className="flex flex-col h-screen-safe max-w-[480px] mx-auto bg-white">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 bg-white shrink-0">
        <h1 className="text-base font-semibold text-gray-900">{TAB_TITLES[activeTab]}</h1>
        <div className="flex items-center gap-1">
          <button
            onClick={() => handleTabChange('import')}
            className="p-1.5 rounded-full hover:bg-gray-100 text-gray-500"
            aria-label="Import data files"
          >
            <Upload size={18} />
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="p-1.5 rounded-full hover:bg-gray-100 text-gray-500"
            aria-label="Forecast settings"
          >
            <Settings size={18} />
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        {!ready ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <ErrorBoundary>{renderTab()}</ErrorBoundary>
        )}
      </main>

      <UpdateBanner />

      <nav className="flex border-t border-gray-200 bg-white pb-safe">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={`flex-1 flex flex-col items-center py-1.5 gap-0.5 text-[10px] font-medium transition-colors ${
              activeTab === tab.id
                ? 'text-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </nav>

      {showSettings && (
        <SettingsSheet onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}
