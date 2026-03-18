/**
 * InsightsTab.tsx
 *
 * AI-powered chat interface powered by Claude (Anthropic).
 * Pulls store data from IndexedDB as context so you can ask natural
 * language questions: waste analysis, invoice lookup, order recommendations,
 * product performance, new product suggestions, etc.
 *
 * API key is stored in localStorage — never sent anywhere except Anthropic.
 */

import { useEffect, useRef, useState } from 'react'
import Anthropic from '@anthropic-ai/sdk'
import { Key, Send, Sparkles, Trash2, X } from 'lucide-react'
import { db } from '../lib/db'

const API_KEY_STORAGE = 'milk-manager-claude-key'

// ─── Data context builder ─────────────────────────────────────────────────────

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

  // Latest QOH per product
  const latestQoh = new Map<number, number>()
  const sorted = [...allSnapshots].sort(
    (a, b) => new Date(a.importedAt).getTime() - new Date(b.importedAt).getTime(),
  )
  for (const s of sorted) latestQoh.set(s.productId, s.qoh)

  // Invoice lines last 90 days — aggregate by product code
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 90)
  const cutoffStr = cutoff.toISOString().split('T')[0]
  const recent = invoiceLines.filter((l) => l.deliveryDate >= cutoffStr)

  type ProdHistory = { totalQty: number; deliveries: Set<string>; totalCost: number }
  const histMap = new Map<string, ProdHistory>()
  for (const l of recent) {
    const h = histMap.get(l.productCode) ?? { totalQty: 0, deliveries: new Set(), totalCost: 0 }
    h.totalQty += l.quantity
    h.deliveries.add(l.deliveryDate)
    h.totalCost += l.extendedPrice
    histMap.set(l.productCode, h)
  }

  // Products summary
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

  // Waste summary (last 30 entries)
  const wasteRows =
    wasteLog.length === 0
      ? 'None recorded'
      : wasteLog
          .slice(-30)
          .map((w) => `${w.wastedDate}: ${w.productName} ×${w.quantity} — ${w.reason}${w.notes ? ` (${w.notes})` : ''}`)
          .join('\n')

  // Claims summary (last 30 entries)
  const claimRows =
    claimRecords.length === 0
      ? 'None recorded'
      : [...claimRecords]
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .slice(-30)
          .map((c) => {
            const sent = c.emailSentAt ? `emailed ${c.emailSentAt}` : 'NOT YET EMAILED'
            const ref = c.invoiceRef ? ` | inv ${c.invoiceRef}` : ''
            return `${c.createdAt}: ${c.productName} ×${c.quantity} — ${c.claimType}${ref} | ${sent} | ${c.description}`
          })
          .join('\n')

  // Orders summary (last 10)
  const recentOrders = [...orders]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10)
  const orderRows =
    recentOrders.length === 0
      ? 'None'
      : recentOrders
          .map((o) => {
            const lines = orderLines.filter((l) => l.orderId === o.id)
            const items = lines
              .filter((l) => l.approvedQty > 0)
              .map((l) => `${l.productName} ×${l.approvedQty}`)
              .join(', ')
            return `${o.deliveryDate} | ${o.status} | $${o.totalCostEstimate.toFixed(2)} | ${items || 'no items'}`
          })
          .join('\n')

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

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant'
  content: string
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

// ─── Message bubble ───────────────────────────────────────────────────────────

function Bubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? 'bg-blue-600 text-white rounded-br-sm'
            : 'bg-gray-100 text-gray-900 rounded-bl-sm'
        }`}
      >
        {msg.content}
      </div>
    </div>
  )
}

// ─── Suggested prompts ────────────────────────────────────────────────────────

const SUGGESTIONS = [
  'Which products should I order more of this week?',
  'How much waste have I had in the last month?',
  'Which products are performing best by margin?',
  'Do I have any outstanding claims not yet emailed?',
  'How did flavoured milk perform last 2 months?',
]

// ─── Main component ───────────────────────────────────────────────────────────

export default function InsightsTab() {
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

    setInput('')
    setError('')
    const userMsg: Message = { role: 'user', content: question }
    const updatedMessages = [...messages, userMsg]
    setMessages(updatedMessages)
    setLoading(true)
    streamRef.current = ''
    setStreamingText('')

    try {
      const context = await buildContext()
      const systemPrompt = `You are an AI analyst for a small IGA supermarket's milk department. You have access to the store's live data below. Answer questions concisely and helpfully. Use specific numbers from the data. When making recommendations, explain why clearly.\n\n${context}`

      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })

      const stream = client.messages.stream({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: systemPrompt,
        messages: updatedMessages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      })

      for await (const chunk of stream) {
        if (
          chunk.type === 'content_block_delta' &&
          chunk.delta.type === 'text_delta'
        ) {
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
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 shrink-0">
        <div className="flex items-center gap-1.5">
          <Sparkles size={14} className="text-blue-500" />
          <span className="text-xs text-gray-500">Powered by Claude</span>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              onClick={() => { setMessages([]); setStreamingText('') }}
              className="p-1.5 text-gray-400 hover:text-gray-600"
              title="Clear chat"
            >
              <Trash2 size={14} />
            </button>
          )}
          <button
            onClick={clearApiKey}
            className="p-1.5 text-gray-400 hover:text-gray-600"
            title="Remove API key"
          >
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
                <button
                  key={s}
                  onClick={() => handleSend(s)}
                  className="w-full text-left text-xs text-gray-600 bg-gray-50 hover:bg-blue-50 hover:text-blue-700 border border-gray-200 hover:border-blue-200 rounded-xl px-3 py-2 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => <Bubble key={i} msg={m} />)}

        {streamingText && (
          <Bubble msg={{ role: 'assistant', content: streamingText + '▌' }} />
        )}

        {error && (
          <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2 mt-2">
            {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-3 py-2 border-t border-gray-100 bg-white">
        <div className="flex items-end gap-2">
          <textarea
            rows={1}
            placeholder="Ask about your data…"
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            disabled={loading}
            className="flex-1 resize-none border border-gray-300 rounded-xl px-3 py-2 text-sm outline-none focus:border-blue-400 disabled:opacity-50 overflow-hidden"
            style={{ minHeight: '38px' }}
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || loading}
            className="w-9 h-9 flex items-center justify-center bg-blue-600 text-white rounded-xl disabled:opacity-40 shrink-0"
          >
            {loading
              ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              : <Send size={15} />
            }
          </button>
        </div>
      </div>
    </div>
  )
}
