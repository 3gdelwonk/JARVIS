/**
 * InsightsTab.tsx — Combined Intelligence tab
 *
 * Two views:
 *  'scout' — Product scouting panels (gap analysis, velocity decliners, etc.)
 *  'chat'  — AI-powered Q&A chat powered by Claude
 */

import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  AlertTriangle, ChevronDown, ChevronUp, Compass, Key,
  Loader2, Send, Sparkles, Trash2, TrendingDown, TrendingUp, X,
} from 'lucide-react'
import { db } from '../lib/db'
import { getLatestQoh, computeTrend } from '../lib/stockAnalytics'
import { calcMarginPct, getDaysAgoDateString } from '../lib/constants'

const API_KEY_STORAGE = 'milk-manager-claude-key'

// ─── Scout panel wrapper ─────────────────────────────────────────────────────

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
  return <div className="px-3 py-4 text-center text-xs text-gray-400">{msg}</div>
}

// ─── AI Scout button ─────────────────────────────────────────────────────────

function AiScout({ context }: { context: string }) {
  const [apiKey] = useState<string | null>(() => localStorage.getItem(API_KEY_STORAGE))
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')

  async function handleScout() {
    if (!apiKey || loading) return
    setLoading(true); setError(''); setResult('')
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
    } finally { setLoading(false) }
  }

  if (!apiKey) {
    return (
      <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-xl border border-gray-200 text-xs text-gray-500">
        <Key size={13} />
        Add Claude API key in the AI Chat view to enable AI scouting
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
      {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
      {result && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2.5">
          <p className="text-xs text-blue-900 whitespace-pre-wrap leading-relaxed">{result}</p>
        </div>
      )}
    </div>
  )
}

// ─── Scout view ──────────────────────────────────────────────────────────────

function ScoutView() {
  const data = useLiveQuery(async () => {
    const [products, salesRecords] = await Promise.all([
      db.products.toArray(),
      db.salesRecords.toArray(),
    ])

    const activeProducts = products.filter((p) => p.active !== false)
    const productBarcodes = new Set(activeProducts.flatMap((p) => [p.barcode, p.invoiceCode, p.itemNumber].filter(Boolean)))

    // Panel 1: Gap Analysis
    const cutoff90 = getDaysAgoDateString(90)
    const recentSales = salesRecords.filter((s) => s.date >= cutoff90)
    const gapBarcodes = new Map<string, { barcode: string; totalQty: number; dept?: string }>()
    for (const s of recentSales) {
      if (productBarcodes.has(s.barcode)) continue
      const ex = gapBarcodes.get(s.barcode)
      if (ex) { ex.totalQty += s.qtySold } else { gapBarcodes.set(s.barcode, { barcode: s.barcode, totalQty: s.qtySold, dept: s.department }) }
    }
    const gaps = [...gapBarcodes.values()].sort((a, b) => b.totalQty - a.totalQty).slice(0, 20)

    // Panel 2: Velocity Decliners
    const decliners = activeProducts
      .map((p) => ({ p, trend: computeTrend(salesRecords, p.id, p.barcode) }))
      .filter((x) => x.trend < -20)
      .sort((a, b) => a.trend - b.trend)
      .slice(0, 15)

    // Panel 3: Margin + Slow
    const cutoff28 = (() => { const d = new Date(); d.setDate(d.getDate() - 28); return d.toISOString().split('T')[0] })()
    const last28Sales = salesRecords.filter((s) => s.date >= cutoff28)
    const dailyVelocities = activeProducts.map((p) => {
      const sales = last28Sales.filter((s) => s.productId === p.id || s.barcode === p.barcode)
      return { p, avgDaily: sales.reduce((s2, r) => s2 + r.qtySold, 0) / 28 }
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

    // Panel 4: High Potential
    const highPotential = activeProducts
      .map((p) => ({
        p,
        trend: computeTrend(salesRecords, p.id, p.barcode),
        days: new Set(salesRecords.filter((s) => s.productId === p.id || s.barcode === p.barcode).map((s) => s.date)).size,
      }))
      .filter((x) => x.trend > 0 && x.days > 0 && x.days < 14)
      .sort((a, b) => b.trend - a.trend)
      .slice(0, 10)

    // AI context
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
    <div className="flex-1 overflow-auto pb-6">
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

        <ScoutPanel
          title="Gap Analysis"
          icon={<AlertTriangle size={14} className="text-amber-600" />}
          count={gaps.length} color="bg-amber-50 text-amber-900"
          defaultOpen={gaps.length > 0}
        >
          {gaps.length === 0 ? <EmptyRow msg="No unmatched barcodes in recent POS data" /> : gaps.map((g) => (
            <div key={g.barcode} className="px-3 py-2 flex items-center justify-between">
              <div>
                <p className="text-xs font-mono text-gray-800">{g.barcode}</p>
                <p className="text-[10px] text-gray-400">{g.dept ?? 'unknown dept'}</p>
              </div>
              <span className="text-xs font-medium text-amber-700">{Math.round(g.totalQty)} units/90d</span>
            </div>
          ))}
        </ScoutPanel>

        <ScoutPanel
          title="Velocity Decliners"
          icon={<TrendingDown size={14} className="text-red-600" />}
          count={decliners.length} color="bg-red-50 text-red-900"
          defaultOpen={decliners.length > 0}
        >
          {decliners.length === 0 ? <EmptyRow msg="No significant velocity declines detected" /> : decliners.map(({ p, trend }) => (
            <div key={p.id} className="px-3 py-2 flex items-center justify-between">
              <p className="text-xs text-gray-800 flex-1 truncate mr-2">{p.name}</p>
              <span className="text-xs font-semibold text-red-600 shrink-0">{trend}%</span>
            </div>
          ))}
        </ScoutPanel>

        <ScoutPanel
          title="Margin + Slow"
          icon={<AlertTriangle size={14} className="text-orange-500" />}
          count={marginSlow.length} color="bg-orange-50 text-orange-900"
        >
          {marginSlow.length === 0 ? <EmptyRow msg="No products below margin + velocity thresholds" /> : marginSlow.map(({ p, avgDaily }) => {
            const margin = p.sellPrice > 0 ? ((p.sellPrice - p.lactalisCostPrice) / p.sellPrice * 100).toFixed(0) : '?'
            return (
              <div key={p.id} className="px-3 py-2 flex items-center justify-between">
                <div className="flex-1 min-w-0 mr-2">
                  <p className="text-xs text-gray-800 truncate">{p.name}</p>
                  <p className="text-[10px] text-gray-400">{margin}% margin · {avgDaily.toFixed(2)}/day</p>
                </div>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 font-medium shrink-0">Review</span>
              </div>
            )
          })}
        </ScoutPanel>

        <ScoutPanel
          title="High Potential"
          icon={<TrendingUp size={14} className="text-green-600" />}
          count={highPotential.length} color="bg-green-50 text-green-900"
        >
          {highPotential.length === 0 ? <EmptyRow msg="No new products with strong positive trend" /> : highPotential.map(({ p, trend, days }) => (
            <div key={p.id} className="px-3 py-2 flex items-center justify-between">
              <div className="flex-1 min-w-0 mr-2">
                <p className="text-xs text-gray-800 truncate">{p.name}</p>
                <p className="text-[10px] text-gray-400">{days} days data</p>
              </div>
              <span className="text-xs font-semibold text-green-600 shrink-0">+{trend}%</span>
            </div>
          ))}
        </ScoutPanel>
      </div>
    </div>
  )
}

// ─── AI Chat data context builder ────────────────────────────────────────────

async function buildContext(): Promise<string> {
  const [products, allSnapshots, invoiceLines, wasteLog, claimRecords, orders, orderLines] =
    await Promise.all([
      db.products.toArray(),
      db.stockSnapshots.toArray(),
      db.invoiceLines.toArray(),
      db.wasteLog.toArray(),
      db.claimRecords.toArray(),
      db.orders.toArray(),
      db.orderLines.toArray(),
    ])

  const latestQoh = getLatestQoh(allSnapshots)
  const recent = invoiceLines.filter((l) => l.deliveryDate >= getDaysAgoDateString(90))

  type ProdHistory = { totalQty: number; deliveries: Set<string>; totalCost: number }
  const histMap = new Map<string, ProdHistory>()
  for (const l of recent) {
    const h = histMap.get(l.productCode) ?? { totalQty: 0, deliveries: new Set(), totalCost: 0 }
    h.totalQty += l.quantity
    h.deliveries.add(l.deliveryDate)
    h.totalCost += l.extendedPrice
    histMap.set(l.productCode, h)
  }

  const productRows = products
    .map((p) => {
      const qoh = latestQoh.has(p.id!) ? latestQoh.get(p.id!) : null
      const code = p.invoiceCode.replace(/^0+/, '')
      const h = histMap.get(code)
      const histStr = h
        ? ` | 90d: ${h.totalQty} units / ${h.deliveries.size} deliveries / $${h.totalCost.toFixed(0)}`
        : ' | 90d: no data'
      return `${p.name} | #${p.itemNumber} | ${p.category} | cost $${p.lactalisCostPrice.toFixed(2)} | sell $${p.sellPrice > 0 ? p.sellPrice.toFixed(2) : '?'} | QOH ${qoh !== null && qoh !== undefined ? qoh : 'unknown'} | freq ${p.orderFrequency}${histStr}`
    })
    .join('\n')

  const wasteRows = wasteLog.length === 0 ? 'None recorded'
    : wasteLog.slice(-30).map((w) => `${w.wastedDate}: ${w.productName} ×${w.quantity} — ${w.reason}${w.notes ? ` (${w.notes})` : ''}`).join('\n')

  const claimRows = claimRecords.length === 0 ? 'None recorded'
    : [...claimRecords].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-30).map((c) => {
        const sent = c.emailSentAt ? `emailed ${c.emailSentAt}` : 'NOT YET EMAILED'
        const ref = c.invoiceRef ? ` | inv ${c.invoiceRef}` : ''
        return `${c.createdAt}: ${c.productName} ×${c.quantity} — ${c.claimType}${ref} | ${sent} | ${c.description}`
      }).join('\n')

  const recentOrders = [...orders].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 10)
  const orderRows = recentOrders.length === 0 ? 'None'
    : recentOrders.map((o) => {
        const lines = orderLines.filter((l) => l.orderId === o.id)
        const items = lines.filter((l) => l.approvedQty > 0).map((l) => `${l.productName} ×${l.approvedQty}`).join(', ')
        return `${o.deliveryDate} | ${o.status} | $${(o.totalCostEstimate ?? 0).toFixed(2)} | ${items || 'no items'}`
      }).join('\n')

  return `IGA Camberwell — Milk Department AI Analyst
Report date: ${new Date().toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}

=== PRODUCTS (${products.length} items) ===
${productRows}

=== WASTE LOG (last 30) ===
${wasteRows}

=== CLAIMS (last 30) ===
${claimRows}

=== RECENT ORDERS (last 10) ===
${orderRows}

Invoice history covers last 90 days. Claims marked "NOT YET EMAILED" have not been sent to Lactalis. Use the data above to answer questions accurately. When you don't have enough data, say so clearly. All prices are in AUD.`
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant'
  content: string
}

// ─── API key gate ────────────────────────────────────────────────────────────

function ApiKeySetup({ onSave }: { onSave: (key: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-4">
      <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center">
        <Key size={22} className="text-blue-600" />
      </div>
      <div>
        <p className="text-sm font-semibold text-gray-900">Enter your Claude API Key</p>
        <p className="text-xs text-gray-500 mt-1">
          Get a key at{' '}
          <a href="https://console.anthropic.com" target="_blank" rel="noopener noreferrer" className="text-blue-500 underline">
            console.anthropic.com
          </a>
          {' '}— stored only in this browser, never shared.
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
        Save & Start Chatting
      </button>
    </div>
  )
}

// ─── Message bubble ──────────────────────────────────────────────────────────

function Bubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
        isUser ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-gray-100 text-gray-900 rounded-bl-sm'
      }`}>
        {msg.content}
      </div>
    </div>
  )
}

const SUGGESTIONS = [
  'Which products should I order more of this week?',
  'How much waste have I had in the last month?',
  'Which products are performing best by margin?',
  'Do I have any outstanding claims not yet emailed?',
  'How did flavoured milk perform last 2 months?',
]

// ─── Chat view ───────────────────────────────────────────────────────────────

function ChatView() {
  const [apiKey, setApiKey] = useState<string | null>(() => localStorage.getItem(API_KEY_STORAGE))
  const [messages, setMessages] = useState<Message[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const streamRef = useRef('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText])

  function saveApiKey(key: string) {
    localStorage.setItem(API_KEY_STORAGE, key)
    setApiKey(key)
  }

  function clearApiKey() {
    localStorage.removeItem(API_KEY_STORAGE)
    setApiKey(null)
    setMessages([])
  }

  async function handleSend(text?: string) {
    const question = (text ?? input).trim()
    if (!question || loading || !apiKey) return

    setInput(''); setError('')
    const userMsg: Message = { role: 'user', content: question }
    const updatedMessages = [...messages, userMsg]
    setMessages(updatedMessages)
    setLoading(true)
    streamRef.current = ''
    setStreamingText('')

    try {
      const context = await buildContext()
      const systemPrompt = `You are an AI analyst for a small IGA supermarket's milk department. You have access to the store's live data below. Answer questions concisely and helpfully. Use specific numbers from the data. When making recommendations, explain why clearly.\n\n${context}`

      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })

      const stream = client.messages.stream({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: systemPrompt,
        messages: updatedMessages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      })

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          streamRef.current += chunk.delta.text
          setStreamingText(streamRef.current)
        }
      }

      const finalText = streamRef.current
      setMessages((prev) => [...prev, { role: 'assistant', content: finalText }])
      setStreamingText('')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Something went wrong.'
      if (msg.includes('401') || msg.toLowerCase().includes('authentication')) {
        setError('Invalid API key — please check and re-enter it.')
      } else if (msg.includes('429')) {
        setError('Rate limited — wait a moment and try again.')
      } else {
        setError(`Claude error: ${msg.slice(0, 120)}`)
      }
      setMessages(updatedMessages)
    } finally {
      setLoading(false)
      streamRef.current = ''
    }
  }

  if (!apiKey) return <ApiKeySetup onSave={saveApiKey} />

  const isEmpty = messages.length === 0 && !streamingText

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Top bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 shrink-0">
        <div className="flex items-center gap-1.5">
          <Sparkles size={14} className="text-blue-500" />
          <span className="text-xs text-gray-500">Powered by Claude</span>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button onClick={() => { setMessages([]); setStreamingText('') }} className="p-1.5 text-gray-400 hover:text-gray-600" title="Clear chat">
              <Trash2 size={14} />
            </button>
          )}
          <button onClick={clearApiKey} className="p-1.5 text-gray-400 hover:text-gray-600" title="Remove API key">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto px-3 py-3">
        {isEmpty && (
          <div className="space-y-4">
            <div className="text-center pt-4">
              <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center mx-auto mb-2">
                <Sparkles size={18} className="text-blue-600" />
              </div>
              <p className="text-sm font-medium text-gray-800">Ask anything about your store</p>
              <p className="text-xs text-gray-400 mt-0.5">Invoice history, waste, margins, ordering advice</p>
            </div>
            <div className="space-y-1.5 pt-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => handleSend(s)}
                  className="w-full text-left text-xs text-gray-600 bg-gray-50 hover:bg-blue-50 hover:text-blue-700 border border-gray-200 hover:border-blue-200 rounded-xl px-3 py-2 transition-colors"
                >{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => <Bubble key={i} msg={m} />)}
        {streamingText && <Bubble msg={{ role: 'assistant', content: streamingText + '▌' }} />}
        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2 mt-2">{error}</div>}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-3 py-2 border-t border-gray-100 bg-white">
        <div className="flex items-end gap-2">
          <textarea
            rows={1}
            placeholder="Ask about your data…"
            value={input}
            onChange={(e) => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px' }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
            disabled={loading}
            className="flex-1 resize-none border border-gray-300 rounded-xl px-3 py-2 text-sm outline-none focus:border-blue-400 disabled:opacity-50 overflow-hidden"
            style={{ minHeight: '38px' }}
          />
          <button onClick={() => handleSend()} disabled={!input.trim() || loading}
            className="w-9 h-9 flex items-center justify-center bg-blue-600 text-white rounded-xl disabled:opacity-40 shrink-0"
          >
            {loading ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Send size={15} />}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main component — segmented control ──────────────────────────────────────

type InsightView = 'scout' | 'chat'

export default function InsightsTab() {
  const [view, setView] = useState<InsightView>('scout')

  return (
    <div className="flex flex-col h-full">
      {/* Segmented control */}
      <div className="flex gap-1 px-3 py-2 bg-white border-b border-gray-200 shrink-0">
        <button
          onClick={() => setView('scout')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors ${
            view === 'scout' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
          }`}
        >
          <Compass size={14} />
          Scout
        </button>
        <button
          onClick={() => setView('chat')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors ${
            view === 'chat' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
          }`}
        >
          <Sparkles size={14} />
          AI Chat
        </button>
      </div>

      {view === 'scout' ? <ScoutView /> : <ChatView />}
    </div>
  )
}
