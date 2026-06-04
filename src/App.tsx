import { useEffect, useState } from "react"
import BotChat, { type ChatMessage } from "./BotChat"
import "./App.css"

type ChatApiResponse = {
  reply?: string
  responseId?: string
  error?: string
}

type Asset = {
  id: string
  assetName: string
  netPrice: number
  arr: number
  term: string
  expiresInDays: number
  dueAmount: number
  tcv: number
  renewalAmount: number
  upsellOpportunityAmount: number
  riskBand: "Low" | "Medium" | "High"
  riskScore: number
  riskSignals: string[]
  recommendedAction: string
}

type DashboardData = {
  assets: Asset[]
  trendingActions: string[]
  syncedAt: string | null
}

const formatCurrency = (value: number) => {
  const abs = Math.abs(value)
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: abs >= 10_000 ? 0 : 1,
    maximumFractionDigits: abs >= 10_000 ? 0 : 1,
    notation: "compact",
  }).format(value)
}

const getExpiryDate = (daysFromNow: number) => {
  const d = new Date()
  d.setDate(d.getDate() + daysFromNow)
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" })
}

function App() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeAsset, setActiveAsset] = useState<Asset | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [chatExpanded, setChatExpanded] = useState(false)
  const closeModal = () => setActiveAsset(null)

  // Shared chat state — both sidebar and modal use the same conversation
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [previousResponseId, setPreviousResponseId] = useState<string | null>(null)

  const sendChatMessage = async () => {
    const text = chatInput.trim()
    if (!text || chatLoading) return
    setChatInput('')
    setChatError(null)
    setChatMessages((prev) => [...prev, { role: 'user', text }])
    setChatLoading(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, previousResponseId }),
      })
      const data = (await res.json()) as ChatApiResponse
      if (!res.ok) throw new Error(data.error || 'Chat request failed.')
      setChatMessages((prev) => [...prev, { role: 'assistant', text: data.reply ?? '' }])
      if (data.responseId) setPreviousResponseId(data.responseId)
    } catch (err: unknown) {
      setChatError(err instanceof Error ? err.message : 'Failed to get a response.')
    } finally {
      setChatLoading(false)
    }
  }

  useEffect(() => {
    let isDisposed = false

    const loadDashboard = async () => {
      try {
        setError(null)
        const response = await fetch("/api/dashboard")
        const payload = (await response.json()) as DashboardData & { error?: string }
        if (!response.ok) throw new Error(payload.error || "Dashboard request failed.")
        if (!isDisposed) setDashboard(payload)
      } catch (requestError) {
        if (!isDisposed)
          setError(requestError instanceof Error ? requestError.message : "Failed to load dashboard.")
      }
    }

    void loadDashboard()
    const refreshId = window.setInterval(() => { void loadDashboard() }, 60000)
    return () => {
      isDisposed = true
      window.clearInterval(refreshId)
    }
  }, [])

  const refreshScores = async () => {
    setIsRefreshing(true)
    try {
      const response = await fetch("/api/dashboard/refresh", { method: "POST" })
      const payload = (await response.json()) as DashboardData & { error?: string }
      if (!response.ok) throw new Error(payload.error || "Refresh failed.")
      setDashboard(payload)
      setError(null)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to refresh scores.")
    } finally {
      setIsRefreshing(false)
    }
  }

  if (error && !dashboard) {
    return (
      <div className="shell">
        <div className="status-wrap">
          <div className="status-card status-card--error">{error}</div>
        </div>
      </div>
    )
  }

  if (!dashboard) {
    return (
      <div className="shell">
        <div className="status-wrap">
          <div className="status-card">Loading agent-generated dashboard&hellip;</div>
        </div>
      </div>
    )
  }

  const { assets, trendingActions } = dashboard

  if (assets.length === 0) {
    return (
      <div className="shell">
        <div className="status-wrap">
          <div className="status-card">Agent returned no grounded assets.</div>
        </div>
      </div>
    )
  }

  const lowAssets = assets.filter((a) => a.riskBand === "Low")
  const medAssets  = assets.filter((a) => a.riskBand === "Medium")
  const highAssets = assets.filter((a) => a.riskBand === "High")
  const expiringSoon = assets.filter((a) => a.expiresInDays <= 30).length

  const riskCards = [
    {
      tone: "low",
      label: "Low Risk Opportunity",
      amount: formatCurrency(lowAssets.reduce((s, a) => s + a.renewalAmount + a.upsellOpportunityAmount, 0)),
      count: lowAssets.length,
      icon: "✓",
    },
    {
      tone: "medium",
      label: "Medium Risk Opportunity",
      amount: formatCurrency(medAssets.reduce((s, a) => s + a.renewalAmount, 0)),
      count: medAssets.length,
      icon: "~",
    },
    {
      tone: "high",
      label: "High Risk Opportunity",
      amount: formatCurrency(highAssets.reduce((s, a) => s + a.renewalAmount, 0)),
      count: highAssets.length,
      icon: "!",
    },
  ]

  const totalArrAtRisk = formatCurrency(
    assets.filter((a) => a.riskBand !== "Low").reduce((s, a) => s + a.renewalAmount, 0)
  )

  return (
    <div className="shell">
      <div className="page-card">

        {/* -- Header -- */}
        <header className="page-header">
          <div className="page-header__brand">
            <div className="brand-avatar">C</div>
            <div>
              <h1 className="page-header__title">Revenue Renewal Intelligence</h1>
              <p className="page-header__sub">Predictive revenue opportunity &amp; upsell intelligence powered by AI risk scoring</p>
            </div>
          </div>
          <div className="page-header__actions">
            <button
              className={`refresh-btn${isRefreshing ? " refresh-btn--spinning" : ""}`}
              onClick={() => { void refreshScores() }}
              disabled={isRefreshing}
              aria-label="Recompute risk scores from agent"
              title="Recompute risk scores from agent"
            >
              <svg className="refresh-btn__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
              {isRefreshing ? "Recomputing…" : "Refresh Scores"}
            </button>
            <button className="notif-btn" aria-label="Notifications">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
              <span className="notif-badge">3</span>
            </button>
          </div>
        </header>

        {/* -- Body -- */}
        <div className="page-body">

          {/* -- Main column -- */}
          <div className="main-col">

            {/* Risk cards */}
            <div className="risk-row">
              {riskCards.map((card) => (
                <div className={`rcard rcard--${card.tone}`} key={card.tone}>
                  <div className="rcard__top">
                    <span className="rcard__label">{card.label.toUpperCase()}</span>
                    <span className={`rcard__icon-circle rcard__icon-circle--${card.tone}`}>{card.icon}</span>
                  </div>
                  <div className="rcard__amount">{card.amount}</div>
                  <div className="rcard__bottom">
                    <span className={`rcard__pill rcard__pill--${card.tone}`}>{card.count} {card.count === 1 ? "asset" : "assets"}</span>
                    <span className="rcard__trend">&#8599;</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Table */}
            <div className="tbl-shell">
              <div className="tbl-scroll">
                <table>
                  <colgroup>
                    <col className="c-asset" />
                    <col className="c-price" />
                    <col className="c-arr" />
                    <col className="c-term" />
                    <col className="c-exp" />
                    <col className="c-due" />
                    <col className="c-tcv" />
                    <col className="c-ren" />
                    <col className="c-ups" />
                    <col className="c-badge" />
                    <col className="c-actions" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th className="th-r">Net Price</th>
                      <th className="th-r">ARR</th>
                      <th className="th-c">Term</th>
                      <th>Expires In Days</th>
                      <th className="th-r">Due Amount</th>
                      <th className="th-r">TCV</th>
                      <th className="th-r">Renewal Amount</th>
                      <th className="th-r th-ai"><span className="th-ai-badge">&#10022; AI</span>Upsell Opportunity Amount</th>
                      <th className="th-c th-ai"><span className="th-ai-badge">&#10022; AI</span>Risk Band</th>
                      <th className="th-ai"><span className="th-ai-badge">&#10022; AI</span>Recommended Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assets.map((asset) => {
                      const tone = asset.riskBand.toLowerCase()
                      return (
                          <tr key={asset.id} className={asset.expiresInDays <= 30 ? "row-urgent" : ""}>
                            <td>
                              <div className="cell-asset">
                                <span className="cell-asset__id">{asset.id}</span>
                                <span className="cell-asset__name">{asset.assetName}</span>
                              </div>
                            </td>
                            <td className="td-r">{formatCurrency(asset.netPrice)}</td>
                            <td className="td-r">{formatCurrency(asset.arr)}</td>
                            <td className="td-c">{asset.term}m</td>
                            <td>
                              <div className="cell-expires">
                                <span className={`expires-days expires-days--${asset.expiresInDays <= 0 ? "overdue" : asset.expiresInDays <= 30 ? "urgent" : asset.expiresInDays <= 90 ? "soon" : "ok"}`}>
                                  {asset.expiresInDays <= 0 ? "Today" : `${asset.expiresInDays}d`}
                                </span>
                                <span className="expires-date">{getExpiryDate(asset.expiresInDays)}</span>
                              </div>
                            </td>
                            <td className={`td-r ${asset.dueAmount > 0 ? "amt-due" : "amt-zero"}`}>{formatCurrency(asset.dueAmount)}</td>
                            <td className="td-r">{formatCurrency(asset.tcv)}</td>
                            <td className="td-r amt-renewal">{formatCurrency(asset.renewalAmount)}</td>
                            <td className={`td-r td-ai ${asset.upsellOpportunityAmount > 0 ? "amt-upsell" : "amt-zero"}`}>{formatCurrency(asset.upsellOpportunityAmount)}</td>
                            <td className="td-c td-ai">
                              <span className={`rbadge rbadge--${tone}`}>{asset.riskBand.toUpperCase()}</span>
                            </td>
                            <td className="td-act td-ai">
                              {asset.recommendedAction ? (
                                <button className={`act-btn act-btn--${tone}`} onClick={() => setActiveAsset(asset)}>
                                  <span className={`act-dot act-dot--${tone}`} />
                                  <span className="act-btn__label">Review Actions</span>
                                  <span className="act-btn__chevron">&#8594;</span>
                                </button>
                              ) : (
                                <span className="no-act">&#8212;</span>
                              )}
                            </td>
                          </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>


          </div>

          {/* -- AI Assistant panel -- */}
          <aside className="assist-col">
            <div className="assist-card">
              <div className="assist-header">
                <span className="assist-header__icon">&#129302;</span>
                <span className="assist-header__title">AI Renewal Assistant</span>
                <button className="assist-expand" onClick={() => setChatExpanded(true)} aria-label="Expand chat" title="Expand chat">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                </button>
              </div>

              <div className="assist-section">
                <div className="trending-title">&#128200; Trending Actions:</div>
                <ol className="trending-list">
                  {trendingActions.map((action, i) => (
                    <li key={i}>{action}</li>
                  ))}
                </ol>
              </div>

              <div className="assist-section assist-stats">
                <ul className="stat-list">
                  <li><span className="sdot sdot--high" />{highAssets.length} assets at HIGH RISK</li>
                  <li><span className="sdot sdot--medium" />{medAssets.length} assets at MEDIUM RISK</li>
                  <li><span className="sdot sdot--low" />{lowAssets.length} assets at LOW RISK</li>
                  <li><span className="sdot sdot--neutral" />ARR at Risk: {totalArrAtRisk}</li>
                  <li><span className="sdot sdot--neutral" />Expiring &le; 30d: {expiringSoon} assets</li>
                </ul>
              </div>

              <BotChat
                messages={chatMessages}
                loading={chatLoading}
                error={chatError}
                input={chatInput}
                onInputChange={setChatInput}
                onSend={() => { void sendChatMessage() }}
              />
            </div>
          </aside>

        </div>
      </div>

      {/* -- Expanded Chat Modal -- */}
      {chatExpanded && (
        <div className="chat-modal-backdrop" onClick={() => setChatExpanded(false)} role="dialog" aria-modal="true" aria-label="AI Renewal Assistant">
          <div className="chat-modal-card" onClick={e => e.stopPropagation()}>
            <div className="chat-modal-header">
              <span className="chat-modal-header__icon">&#129302;</span>
              <span className="chat-modal-header__title">AI Renewal Assistant</span>
              <button className="chat-modal-close" onClick={() => setChatExpanded(false)} aria-label="Collapse chat">&#10005;</button>
            </div>
            <div className="chat-modal-body">
              <BotChat
                messages={chatMessages}
                loading={chatLoading}
                error={chatError}
                input={chatInput}
                onInputChange={setChatInput}
                onSend={() => { void sendChatMessage() }}
              />
            </div>
          </div>
        </div>
      )}

      {/* -- Review Actions Modal -- */}
      {activeAsset && (() => {
        const a = activeAsset
        const tone = a.riskBand.toLowerCase()
        // Split recommended action into sentences for bullet display
        const bullets = a.recommendedAction
          .split(/(?<=[.!?])\s+/)
          .map(s => s.trim())
          .filter(Boolean)
        return (
          <div className="modal-backdrop" onClick={closeModal} role="dialog" aria-modal="true" aria-label="Action details">
            <div className={`modal-card modal-card--${tone}`} onClick={e => e.stopPropagation()}>

              {/* Modal header */}
              <div className={`modal-header modal-header--${tone}`}>
                <div className="modal-header__left">
                  <span className={`modal-risk-icon modal-risk-icon--${tone}`}>
                    {tone === "high" ? "!" : tone === "medium" ? "~" : "✓"}
                  </span>
                  <div>
                    <div className="modal-asset-id">{a.id}</div>
                    <div className="modal-asset-name">{a.assetName}</div>
                  </div>
                </div>
                <div className="modal-header__right">
                  <span className={`rbadge rbadge--${tone}`}>{a.riskBand.toUpperCase()}</span>
                  <button className="modal-close" onClick={closeModal} aria-label="Close">&#10005;</button>
                </div>
              </div>

              {/* Key metrics */}
              <div className="modal-metrics">
                <div className="modal-metric">
                  <span className="modal-metric__label">Renewal Amount</span>
                  <span className="modal-metric__value amt-renewal">{formatCurrency(a.renewalAmount)}</span>
                </div>
                <div className="modal-metric">
                  <span className="modal-metric__label">ARR</span>
                  <span className="modal-metric__value">{formatCurrency(a.arr)}</span>
                </div>
                <div className="modal-metric">
                  <span className="modal-metric__label">Upsell Opp</span>
                  <span className="modal-metric__value amt-upsell">{formatCurrency(a.upsellOpportunityAmount)}</span>
                </div>
                <div className="modal-metric">
                  <span className="modal-metric__label">Expires</span>
                  <span className={`modal-metric__value expires-days--${a.expiresInDays <= 0 ? "overdue" : a.expiresInDays <= 30 ? "urgent" : a.expiresInDays <= 90 ? "soon" : "ok"}`}>
                    {a.expiresInDays <= 0 ? "Today" : `${a.expiresInDays}d`} &middot; {getExpiryDate(a.expiresInDays)}
                  </span>
                </div>
              </div>

              {/* Recommended action */}
              <div className="modal-body">
                <div className="modal-section-title">&#128204; Recommended Actions</div>
                <ul className="modal-action-list">
                  {bullets.map((b, i) => (
                    <li key={i} className={`modal-action-item modal-action-item--${tone}`}>
                      <span className={`act-dot act-dot--${tone}`} />
                      {b}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Risk score bar */}
              <div className="modal-score">
                <div className="modal-score__header">
                  <span className="modal-score__label">Risk Score</span>
                  <span className={`modal-score__value modal-score__value--${tone}`}>{a.riskScore}</span>
                </div>
                <div className="modal-score__track">
                  <div
                    className={`modal-score__fill modal-score__fill--${tone}`}
                    style={{ width: `${Math.min(a.riskScore, 100)}%` }}
                  />
                </div>
              </div>
              {/* Why this score */}
              {a.riskSignals.length > 0 && (
                <div className="modal-body modal-body--signals">
                  <div className="modal-section-title">&#9888;&#65039; Why this score?</div>
                  <ul className="modal-signals-list">
                    {a.riskSignals.map((signal, i) => (
                      <li key={i} className={`modal-signal-item modal-signal-item--${tone}`}>
                        <span className={`signal-dot signal-dot--${tone}`} />
                        {signal}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )
      })()}

    </div>
  )
}

export default App
