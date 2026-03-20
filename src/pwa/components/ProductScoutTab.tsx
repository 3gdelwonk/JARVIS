/**
 * ProductScoutTab.tsx — Product scouting & ranging decisions
 *
 * Four intelligence panels:
 *  1. Gap Analysis — barcodes scanned (POS data) but not in product catalogue
 *  2. Velocity Decliners — products with >20% velocity drop over 4 weeks
 *  3. Margin + Slow — below 20% margin AND below median velocity → delisting candidates
 *  4. High Potential — positive trend with limited data → new listings to review
 *
 * AI Scout button — sends scouting context to Claude for recommendations.
 */

import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  AlertTriangle, ChevronDown, ChevronUp, Compass, Key, Loader2, Sparkles, TrendingDown, TrendingUp,
} from 'lucide-react'
import { db } from '../lib/db'
import { computeTrend } from '../lib/stockAnalytics'
import { calcMarginPct, getDaysAgoDateString } from '../lib/constants'

const API_KEY_STORAGE = 'milk-manager-claude-key'

// ─── Scout panel wrapper ──────────────────────────────────────────────────────

function ScoutPanel({
  title, icon, count, color, children, defaultOpen = false,
}: {
  title: string; icon: React.ReactNode; count: number; color: string
  children: React.ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
      <button
        className={`w-full px-3 py-2.5 flex items-center justify-between ${color}`}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-sm font-semibold">{title}</span>
          <span className="text-xs opacity-70">({count})</span>
        </div>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && <div className="divide-y divide-gray-100">{children}</div>}
    </div>
  )
}

function EmptyRow({ msg }: { msg: string }) {
  return (
    <div className="px-3 py-4 text-center text-xs text-gray-400">{msg}</div>
  )
}

// ─── AI Scout ─────────────────────────────────────────────────────────────────

function AiScout({ context }: { context: string }) {
  const [apiKey] = useState<string | null>(() => localStorage.getItem(API_KEY_STORAGE))
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')

  async function handleScout() {
    if (!apiKey || loading) return
    setLoading(true)
    setError('')
    setResult('')
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `You are a retail buying analyst for a small IGA supermarket. Based on this stock performance scouting data, provide concise recommendations:\n\n${context}\n\nAnswer: Which products should I consider adding to my range, and which currently-stocked products should I consider delisting? Be specific, use the data, limit to 5 adds and 3 delistings.`,
        }],
      })
      const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
      setResult(text)
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 120) : 'Scout failed')
    } finally {
      setLoading(false)
    }
  }

  if (!apiKey) {
    return (
      <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-xl border border-gray-200 text-xs text-gray-500">
        <Key size={13} />
        Add Claude API key in AI Insights tab to enable AI scouting
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <button
        onClick={handleScout}
        disabled={loading}
        className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl disabled:opacity-50"
      >
        {loading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
        {loading ? 'Scouting…' : 'Scout with AI'}
      </button>
      {error && (
        <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
      )}
      {result && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2.5">
          <p className="text-xs text-blue-900 whitespace-pre-wrap leading-relaxed">{result}</p>
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ProductScoutTab() {
  const data = useLiveQuery(async () => {
    const [products, salesRecords] = await Promise.all([
      db.products.toArray(),
      db.salesRecords.toArray(),
    ])

    const activeProducts = products.filter((p) => p.active !== false)
    const productBarcodes = new Set(activeProducts.flatMap((p) => [p.barcode, p.invoiceCode, p.itemNumber].filter(Boolean)))

    // ── Panel 1: Gap Analysis ──────────────────────────────────────────────────
    // Barcodes in salesRecords but not in any active product
    const cutoff90 = getDaysAgoDateString(90)
    const recentSales = salesRecords.filter((s) => s.date >= cutoff90)
    const gapBarcodes = new Map<string, { barcode: string; totalQty: number; dept?: string }>()
    for (const s of recentSales) {
      if (productBarcodes.has(s.barcode)) continue
      const ex = gapBarcodes.get(s.barcode)
      if (ex) {
        ex.totalQty += s.qtySold
      } else {
        gapBarcodes.set(s.barcode, { barcode: s.barcode, totalQty: s.qtySold, dept: s.department })
      }
    }
    const gaps = [...gapBarcodes.values()].sort((a, b) => b.totalQty - a.totalQty).slice(0, 20)

    // ── Panel 2: Velocity Decliners ────────────────────────────────────────────
    const decliners = activeProducts
      .map((p) => ({ p, trend: computeTrend(salesRecords, p.id, p.barcode) }))
      .filter((x) => x.trend < -20)
      .sort((a, b) => a.trend - b.trend)
      .slice(0, 15)

    // ── Panel 3: Margin + Slow ─────────────────────────────────────────────────
    const cutoff28 = (() => { const d = new Date(); d.setDate(d.getDate() - 28); return d.toISOString().split('T')[0] })()
    const last28Sales = salesRecords.filter((s) => s.date >= cutoff28)

    const dailyVelocities = activeProducts.map((p) => {
      const sales = last28Sales.filter((s) => s.productId === p.id || s.barcode === p.barcode)
      return { p, avgDaily: sales.reduce((s, r) => s + r.qtySold, 0) / 28 }
    })
    const velocities = dailyVelocities.map((x) => x.avgDaily).sort((a, b) => a - b)
    const medianVelocity = velocities[Math.floor(velocities.length / 2)] ?? 0

    const marginSlow = dailyVelocities
      .filter((x) => {
        const margin = (calcMarginPct(x.p.sellPrice, x.p.lactalisCostPrice) ?? 0) / 100
        return margin < 0.20 && x.avgDaily < medianVelocity
      })
      .sort((a, b) => a.avgDaily - b.avgDaily)
      .slice(0, 10)

    // ── Panel 4: High Potential ────────────────────────────────────────────────
    const highPotential = activeProducts
      .map((p) => ({
        p,
        trend: computeTrend(salesRecords, p.id, p.barcode),
        days: new Set(salesRecords.filter((s) => s.productId === p.id || s.barcode === p.barcode).map((s) => s.date)).size,
      }))
      .filter((x) => x.trend > 0 && x.days > 0 && x.days < 14)
      .sort((a, b) => b.trend - a.trend)
      .slice(0, 10)

    // ── AI context ────────────────────────────────────────────────────────────
    const aiContext = [
      `Gap Analysis (unmatched barcodes with recent sales):\n${gaps.slice(0, 10).map((g) => `  ${g.barcode}: ${g.totalQty} units sold (${g.dept ?? 'unknown dept'})`).join('\n') || '  None'}`,
      `\nVelocity Decliners (trend < -20%):\n${decliners.slice(0, 8).map((x) => `  ${x.p.name}: ${x.trend}% trend, margin ${(calcMarginPct(x.p.sellPrice, x.p.lactalisCostPrice) ?? 0).toFixed(0)}%`).join('\n') || '  None'}`,
      `\nMargin + Slow movers (potential delistings):\n${marginSlow.slice(0, 6).map((x) => `  ${x.p.name}: ${x.avgDaily.toFixed(2)}/day, margin ${(calcMarginPct(x.p.sellPrice, x.p.lactalisCostPrice) ?? 0).toFixed(0)}%`).join('\n') || '  None'}`,
      `\nHigh Potential (new, positive trend):\n${highPotential.slice(0, 6).map((x) => `  ${x.p.name}: +${x.trend}% trend, ${x.days} days data`).join('\n') || '  None'}`,
    ].join('')

    return { gaps, decliners, marginSlow, highPotential, aiContext }
  }, [])

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={20} className="animate-spin text-gray-300" />
      </div>
    )
  }

  const { gaps, decliners, marginSlow, highPotential, aiContext } = data

  return (
    <div className="flex flex-col h-full overflow-auto pb-6">
      <div className="p-3 space-y-3">

        {/* AI Scout */}
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-3">
          <div className="flex items-center gap-2 mb-2">
            <Compass size={16} className="text-blue-600" />
            <p className="text-sm font-semibold text-blue-900">AI Product Scout</p>
          </div>
          <p className="text-[11px] text-blue-700 mb-2">
            Analyses gap analysis, velocity trends and margin data to recommend ranging decisions.
          </p>
          <AiScout context={aiContext} />
        </div>

        {/* Panel 1: Gap Analysis */}
        <ScoutPanel
          title="Gap Analysis"
          icon={<AlertTriangle size={14} className="text-amber-600" />}
          count={gaps.length}
          color="bg-amber-50 text-amber-900"
          defaultOpen={gaps.length > 0}
        >
          {gaps.length === 0
            ? <EmptyRow msg="No unmatched barcodes in recent POS data" />
            : gaps.map((g) => (
              <div key={g.barcode} className="px-3 py-2 flex items-center justify-between">
                <div>
                  <p className="text-xs font-mono text-gray-800">{g.barcode}</p>
                  <p className="text-[10px] text-gray-400">{g.dept ?? 'unknown dept'}</p>
                </div>
                <span className="text-xs font-medium text-amber-700">{g.totalQty} units/90d</span>
              </div>
            ))
          }
        </ScoutPanel>

        {/* Panel 2: Velocity Decliners */}
        <ScoutPanel
          title="Velocity Decliners"
          icon={<TrendingDown size={14} className="text-red-600" />}
          count={decliners.length}
          color="bg-red-50 text-red-900"
          defaultOpen={decliners.length > 0}
        >
          {decliners.length === 0
            ? <EmptyRow msg="No significant velocity declines detected" />
            : decliners.map(({ p, trend }) => (
              <div key={p.id} className="px-3 py-2 flex items-center justify-between">
                <p className="text-xs text-gray-800 flex-1 truncate mr-2">{p.name}</p>
                <span className="text-xs font-semibold text-red-600 shrink-0">{trend}%</span>
              </div>
            ))
          }
        </ScoutPanel>

        {/* Panel 3: Margin + Slow */}
        <ScoutPanel
          title="Margin + Slow"
          icon={<AlertTriangle size={14} className="text-orange-500" />}
          count={marginSlow.length}
          color="bg-orange-50 text-orange-900"
          defaultOpen={false}
        >
          {marginSlow.length === 0
            ? <EmptyRow msg="No products below margin + velocity thresholds" />
            : marginSlow.map(({ p, avgDaily }) => {
              const margin = p.sellPrice > 0
                ? ((p.sellPrice - p.lactalisCostPrice) / p.sellPrice * 100).toFixed(0)
                : '?'
              return (
                <div key={p.id} className="px-3 py-2 flex items-center justify-between">
                  <div className="flex-1 min-w-0 mr-2">
                    <p className="text-xs text-gray-800 truncate">{p.name}</p>
                    <p className="text-[10px] text-gray-400">{margin}% margin · {avgDaily.toFixed(2)}/day</p>
                  </div>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 font-medium shrink-0">Review</span>
                </div>
              )
            })
          }
        </ScoutPanel>

        {/* Panel 4: High Potential */}
        <ScoutPanel
          title="High Potential"
          icon={<TrendingUp size={14} className="text-green-600" />}
          count={highPotential.length}
          color="bg-green-50 text-green-900"
          defaultOpen={false}
        >
          {highPotential.length === 0
            ? <EmptyRow msg="No new products with strong positive trend" />
            : highPotential.map(({ p, trend, days }) => (
              <div key={p.id} className="px-3 py-2 flex items-center justify-between">
                <div className="flex-1 min-w-0 mr-2">
                  <p className="text-xs text-gray-800 truncate">{p.name}</p>
                  <p className="text-[10px] text-gray-400">{days} days data</p>
                </div>
                <span className="text-xs font-semibold text-green-600 shrink-0">+{trend}%</span>
              </div>
            ))
          }
        </ScoutPanel>
      </div>
    </div>
  )
}
