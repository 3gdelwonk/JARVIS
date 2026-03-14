import { Component, useEffect, useState, type ReactNode } from 'react'
import { CalendarClock, LayoutDashboard, ShoppingCart, TrendingUp, Upload, Package, Settings, BarChart3 } from 'lucide-react'
import { seedDatabase } from './pwa/lib/db'
import { applyStatusUpdates, applyExtensionSchedule } from './pwa/lib/extensionSync'
import Dashboard from './pwa/components/Dashboard'
import OrderBuilder from './pwa/components/OrderBuilder'
import MarginAnalysis from './pwa/components/MarginAnalysis'
import ImportTab from './pwa/components/ImportTab'
import ProductList from './pwa/components/ProductList'
import HistoryTab from './pwa/components/HistoryTab'
import ExpiryTab from './pwa/components/ExpiryTab'
import SettingsSheet from './pwa/components/SettingsSheet'

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

type Tab = 'dashboard' | 'order' | 'expiry' | 'import' | 'products' | 'margins' | 'history'

const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'dashboard', label: 'Home',     icon: <LayoutDashboard size={18} /> },
  { id: 'order',     label: 'Order',    icon: <ShoppingCart size={18} /> },
  { id: 'expiry',    label: 'Expiry',   icon: <CalendarClock size={18} /> },
  { id: 'import',    label: 'Import',   icon: <Upload size={18} /> },
  { id: 'products',  label: 'Products', icon: <Package size={18} /> },
  { id: 'margins',   label: 'Margins',  icon: <TrendingUp size={18} /> },
  { id: 'history',   label: 'History',  icon: <BarChart3 size={18} /> },
]

const TAB_TITLES: Record<Tab, string> = {
  dashboard: 'Milk Manager',
  order:     'Order Builder',
  expiry:    'Expiry Tracker',
  import:    'Import Data',
  products:  'Products',
  margins:   'Margin Analysis',
  history:   'Invoice History',
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard')
  const [showSettings, setShowSettings] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // Await seed before rendering so Order Builder sees products on first load
    ;(async () => {
      await seedDatabase().catch(console.error)
      await Promise.all([
        applyStatusUpdates().catch(console.error),
        applyExtensionSchedule().catch(console.error),
      ])
      setReady(true)
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
    setShowSettings(false)
  }

  const renderTab = () => {
    switch (activeTab) {
      case 'dashboard': return <Dashboard onNavigateToOrder={() => handleTabChange('order')} />
      case 'order':     return <OrderBuilder />
      case 'expiry':    return <ExpiryTab />
      case 'history':   return <HistoryTab />
      case 'import':    return <ImportTab />
      case 'products':  return <ProductList />
      case 'margins':   return <MarginAnalysis />
      default: return <div className="p-4 text-sm text-gray-400">Unknown tab</div>
    }
  }

  return (
    <div className="flex flex-col h-screen-safe max-w-[480px] mx-auto bg-white">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 bg-white shrink-0">
        <h1 className="text-base font-semibold text-gray-900">{TAB_TITLES[activeTab]}</h1>
        <button
          onClick={() => setShowSettings(true)}
          className="p-1.5 rounded-full hover:bg-gray-100 text-gray-500"
          aria-label="Forecast settings"
        >
          <Settings size={18} />
        </button>
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
