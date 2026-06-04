import { createServer } from 'node:http'
import dotenv from 'dotenv'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { AzureCliCredential, ChainedTokenCredential, InteractiveBrowserCredential } from '@azure/identity'

const serverDir = path.dirname(fileURLToPath(import.meta.url))

dotenv.config({ path: path.join(serverDir, '.env') })
dotenv.config({ path: path.join(serverDir, '.env.local'), override: true })

// Load .md knowledge files at startup and cache them
const MD_FILES = [
  'renewal-risk-score-aggregator.md',
  'billing-financial-signals.md',
  'subscription-lifecycle-signals.md',
  'engagement-signals-scoring.md',
  'commercial-fit-signals.md',
  'engagement-signals-erd.md',
]
let _knowledgeBase = null
const getKnowledgeBase = async () => {
  if (_knowledgeBase) return _knowledgeBase
  const sections = await Promise.all(
    MD_FILES.map(async (f) => {
      try {
        const content = await readFile(path.join(serverDir, 'public', f), 'utf8')
        return `### ${f}\n${content}`
      } catch {
        return null
      }
    })
  )
  _knowledgeBase = sections.filter(Boolean).join('\n\n---\n\n')
  return _knowledgeBase
}

const port = Number(process.env.PORT || process.env.BOT_TOKEN_SERVER_PORT || 3978)

// Module-level CSV parser (handles quoted fields)
const parseCsv = async (filename) => {
  const text = await readFile(path.join(serverDir, 'public', filename), 'utf8')
  const lines = text.trim().split(/\r?\n/)
  const headers = lines[0].split(',').map((h) => h.trim())
  return lines.slice(1).filter((l) => l.trim()).map((line) => {
    const vals = []
    let cur = '', inQ = false
    for (const ch of line) {
      if (ch === '"') inQ = !inQ
      else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = '' }
      else cur += ch
    }
    vals.push(cur.trim())
    const rec = {}
    headers.forEach((h, i) => { rec[h] = vals[i] ?? '' })
    return rec
  })
}

// Load and aggregate per-customer signals from all signal CSVs
const getSignalContext = async (customerIds) => {
  const idSet = new Set(customerIds)
  const [
    invoices, payments, disputes,
    tickets, npsSurveys, usage,
    subscriptions, renewals,
  ] = await Promise.all([
    parseCsv('invoices.csv'),
    parseCsv('payment_attempts.csv'),
    parseCsv('billing_disputes.csv'),
    parseCsv('support_tickets.csv'),
    parseCsv('nps_surveys.csv'),
    parseCsv('product_usage.csv'),
    parseCsv('subscriptions.csv'),
    parseCsv('renewals.csv'),
  ])

  const result = {}
  for (const cid of idSet) {
    // Billing
    const custInv = invoices.filter((i) => i.customer_id === cid)
    const overdueInv = custInv.filter((i) => Number(i.due_past_by || 0) > 0 && !i.paid_at)
    const overdueAmt = overdueInv.reduce((s, i) => s + Number(i.total_amount || 0), 0)
    const failedPay = payments.filter((p) => p.customer_id === cid && p.status === 'failed')
    const custDisp = disputes.filter((d) => d.customer_id === cid)
    // Engagement
    const openTkts = tickets.filter((t) => t.account_id === cid && t.status === 'Open')
    const criticalTkts = openTkts.filter((t) => t.priority === 'High' || t.severity === 'P1' || t.severity === 'P2')
    const custNps = npsSurveys.filter((n) => n.account_id === cid)
      .sort((a, b) => new Date(b.survey_date) - new Date(a.survey_date))
    const latestNps = custNps[0]
    const totalSessions = usage.filter((u) => u.account_id === cid)
      .reduce((s, u) => s + Number(u.session_count || 0), 0)
    // Lifecycle
    const custSubs = subscriptions.filter((s) => s.customer_id === cid)
    const avgUtil = custSubs.length
      ? Math.round(custSubs.reduce((s, sub) => {
          const tot = Number(sub.license_count || 0)
          return s + (tot > 0 ? (Number(sub.active_user_count || 0) / tot) * 100 : 0)
        }, 0) / custSubs.length)
      : null
    const contractTypes = [...new Set(custSubs.map((s) => s.contract_type))].join('/')
    const lateRen = renewals.filter(
      (r) => r.customer_id === cid && (r.renewal_status === 'late' || r.renewal_status === 'negotiated')
    )

    result[cid] = [
      `Billing: ${overdueInv.length} overdue invoice(s) $${overdueAmt.toFixed(0)}, ${failedPay.length} failed payment(s), ${custDisp.length} dispute(s)`,
      `Engagement: ${openTkts.length} open ticket(s) (${criticalTkts.length} critical/high), NPS:${latestNps ? `${latestNps.score} ${latestNps.sentiment}` : 'N/A'}, sessions:${totalSessions}`,
      `Lifecycle: license utilization ${avgUtil !== null ? avgUtil + '%' : 'N/A'} (${contractTypes}), ${lateRen.length} late/negotiated renewal(s)`,
    ].join(' | ')
  }
  return result
}

// Parsed and joined asset data, cached after first load
let _allJoinedAssets = null
let _cachedDashboard = null  // last agent-scored dashboard, shared with chat context
// Current scoring weights — configurable via POST /api/weights
let _currentWeights = { billing: 0.30, lifecycle: 0.25, engagement: 0.25, commercial: 0.20 }
const getAllJoinedAssets = async () => {
  if (_allJoinedAssets) return _allJoinedAssets

  const [customers, lineItems, grid] = await Promise.all([
    parseCsv('customers.csv'),
    parseCsv('asset_line_items.csv'),
    parseCsv('assets_grid.csv'),
  ])

  const custMap = new Map(customers.map((c) => [c['customer_id'], { name: c['name'], industry: c['industry'], tier: c['tier'] }]))
  const gridMap = new Map(grid.map((g) => [g['Id'], g]))

  _allJoinedAssets = lineItems.map((a) => {
    const g = gridMap.get(a['asset_line_item_id']) || {}
    const cust = custMap.get(a['account_id']) || {}
    return {
      id: a['asset_line_item_id'],
      customerId: a['account_id'],
      customerName: cust.name || a['account_id'],
      industry: cust.industry || '',
      tier: cust.tier || '',
      product: a['product_name'],
      status: a['status'],
      endDate: a['end_date'],
      expiresInDays: Number(g['Expires In Days'] || 999),
      arr: a['arr'],
      netPrice: a['net_price'],
      dueAmount: g['Due Amount'] || '0',
      tcv: a['tcv'],
      renewalAmt: g['Renewal Amount'] || '',
      upsellOpportunity: parseCsvNumber(g['Upsell Opportunity Amount'] || '0'),
      term: a['selling_term'],
    }
  })

  return _allJoinedAssets
}

// Build a focused context string for a user query by filtering to relevant assets
const buildContextForMessage = async (message) => {
  const all = await getAllJoinedAssets()
  const msg = message.toLowerCase()

  // Extract expiry window (default none = all)
  let maxDays = Infinity
  const daysMatch = msg.match(/next\s+(\d+)\s+days?|(\d+)\s*days?/)
  if (daysMatch) maxDays = Number(daysMatch[1] || daysMatch[2])

  // Extract customer name mentions
  const custNames = [...new Set(all.map((a) => a.customerName))]
  const mentionedCustomers = custNames.filter((n) => msg.includes(n.toLowerCase()))

  // Filter assets
  let filtered = all
  if (mentionedCustomers.length > 0) {
    filtered = filtered.filter((a) => mentionedCustomers.includes(a.customerName))
  }
  if (maxDays < Infinity) {
    filtered = filtered.filter((a) => a.expiresInDays <= maxDays)
  }
  // Fallback: show all if no filter matched
  if (filtered.length === 0) filtered = all

  const rows = filtered.map((a) =>
    `ID:${a.id} | Customer:${a.customerName} | Product:${a.product} | Status:${a.status} | ExpiresInDays:${a.expiresInDays} | EndDate:${a.endDate} | ARR:${a.arr} | NetPrice:${a.netPrice} | DueAmount:${a.dueAmount} | UpsellOpportunity:$${a.upsellOpportunity ?? 0} | TCV:${a.tcv} | RenewalAmt:${a.renewalAmt} | Term:${a.term}mo`
  ).join('\n')

  // Enrich with per-customer signals from all signal CSVs
  const customerIds = [...new Set(filtered.map((a) => a.customerId))]

  let signalBlock = ''
  try {
    const signals = await getSignalContext(customerIds)
    signalBlock = '\n\n[CUSTOMER SIGNALS]\n' +
      Object.entries(signals).map(([cid, s]) => `${cid}: ${s}`).join('\n')
  } catch {
    // non-fatal — agent can still use asset data
  }

  return `[ASSET DATA — ${filtered.length} asset(s) matching your query]\n${rows}${signalBlock}`
}

// Convert joined asset record to assets_grid format for buildRiskPrompt
const joinedToGridFormat = (a) => ({
  'Id': a.id,
  'Asset Name': `${a.product} (${a.customerName})`,
  'Net Price': a.netPrice,
  'ARR': a.arr,
  'Due Amount': a.dueAmount,
  'Expires In Days': String(a.expiresInDays),
  'Term': String(a.term),
  'Renewal Amount': a.renewalAmt,
  'TCV': a.tcv,
})

const buildRiskPrompt = (assets, weights = _currentWeights) => {
  const assetTable = assets.map((a) => [
    `Asset ID: ${a['Id']}`,
    `Name: ${a['Asset Name']}`,
    `Net Price: ${a['Net Price']}`,
    `ARR: ${a['ARR']}`,
    `Due Amount: ${a['Due Amount']}`,
    `Expires In Days: ${a['Expires In Days']}`,
    `Term: ${a['Term']}`,
    `Renewal Amount: ${a['Renewal Amount']}`,
    `TCV: ${a['TCV']}`,
  ].join(' | ')).join('\n')

  return `Reply with JSON only. No explanation, no markdown, just the JSON object.

You are a renewal risk analyst. Based on the asset data below, compute a Renewal Risk Band and Risk Score for each asset using billing health, engagement, and subscription lifecycle signals.

ASSETS:
${assetTable}

Scoring formula (weighted composite — use these exact weights):
  renewal_risk_score =
    billing_health_score         × ${(weights.billing * 100).toFixed(0)}%  +
    subscription_lifecycle_score × ${(weights.lifecycle * 100).toFixed(0)}%  +
    engagement_score             × ${(weights.engagement * 100).toFixed(0)}%  +
    commercial_fit_score         × ${(weights.commercial * 100).toFixed(0)}%

Scoring rules:
- Due Amount > 0 → billing risk (higher = worse)
- Expires In Days < 30 → urgency risk
- Low ARR relative to Net Price → financial mismatch
- Risk Band: Low (0-30), Medium (31-55), High (56-75), Critical (76-100)
- "Critical" is a valid band (highest severity)

Return this exact JSON shape:
{
  "scores": [
    {
      "Id": "ALI-001",
      "Risk Band": "Medium",
      "Risk Score": 73,
      "Risk Signals": ["$2.9K outstanding balance", "Expires in 12 days"],
      "Recommended Action": "URGENT: Immediate outreach required"
    }
  ],
  "trendingActions": ["URGENT: 3 assets expire within 30 days"]
}

Rules:
- Return exactly one entry per asset.
- Risk Score is an integer 0-100.
- Risk Signals: 2-4 specific signals using the actual data values.
- No invented IDs.`
}

const json = (res, statusCode, body) => {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'))
    } catch {
      resolve({})
    }
  })
  req.on('error', reject)
})

const extractJson = (text) => {
  const trimmed = text.trim()

  if (trimmed.startsWith('{')) {
    return trimmed
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)

  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim()
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1)
  }

  throw new Error('Agent response did not include JSON.')
}

const normalizeRisk = (risk) => {
  if (risk === 'Low' || risk === 'Medium' || risk === 'High') {
    return risk
  }

  // Critical (76-100) from the aggregator maps to High in the UI
  if (risk === 'Critical') {
    return 'High'
  }

  throw new Error(`Invalid risk value: ${risk}`)
}

const deriveRiskScore = (riskBand) => {
  if (riskBand === 'High') {
    return 90
  }

  if (riskBand === 'Medium') {
    return 65
  }

  return 30
}

const readTextField = (record, keys, fallback = '') => {
  for (const key of keys) {
    const value = record?.[key]

    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim()
    }
  }

  return fallback
}

const readNumberField = (record, keys, fallback = 0) => {
  for (const key of keys) {
    const value = record?.[key]

    if (value === undefined || value === null || String(value).trim() === '') {
      continue
    }

    const normalized = typeof value === 'number'
      ? value
      : Number(String(value).replace(/[$,%\s,]/g, ''))

    if (!Number.isNaN(normalized)) {
      return normalized
    }
  }

  return fallback
}

const parseCsvNumber = (val) => {
  if (!val || String(val).trim() === '') return 0
  return Number(String(val).replace(/[$,%\s]/g, '')) || 0
}

const loadCsvAssets = async () => {
  const csvPath = path.join(serverDir, 'public', 'assets_grid.csv')
  const text = await readFile(csvPath, 'utf-8')
  const lines = text.trim().split(/\r?\n/)
  const headers = lines[0].split(',').map((h) => h.trim())

  return lines.slice(1)
    .filter((line) => line.trim())
    .map((line) => {
      const values = []
      let current = ''
      let inQuotes = false
      for (const ch of line) {
        if (ch === '"') {
          inQuotes = !inQuotes
        } else if (ch === ',' && !inQuotes) {
          values.push(current.trim())
          current = ''
        } else {
          current += ch
        }
      }
      values.push(current.trim())
      const record = {}
      headers.forEach((h, i) => { record[h] = values[i] ?? '' })
      return record
    })
}

const normalizeDashboard = (payload) => {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Dashboard payload was empty.')
  }

  const assets = Array.isArray(payload.assets)
    ? payload.assets.map((asset, index) => {
        const riskBand = normalizeRisk(readTextField(asset, ['riskBand', 'Risk Band', 'risk'], 'Low'))

        return {
          id: readTextField(asset, ['id', 'Id', 'ID'], `asset${index + 1}`),
          assetName: readTextField(asset, ['assetName', 'Asset Name', 'company', 'name'], 'Unknown account'),
          netPrice: readNumberField(asset, ['netPrice', 'Net Price']),
          arr: readNumberField(asset, ['arr', 'ARR']),
          term: readTextField(asset, ['term', 'Term'], '24m'),
          expiresInDays: readNumberField(asset, ['expiresInDays', 'Expires In Days']),
          dueAmount: readNumberField(asset, ['dueAmount', 'Due Amount']),
          tcv: readNumberField(asset, ['tcv', 'TCV']),
          renewalAmount: readNumberField(asset, ['renewalAmount', 'Renewal Amount']),
          upsellOpportunityAmount: readNumberField(asset, ['upsellOpportunityAmount', 'Upsell Opportunity Amount']),
          riskBand,
          riskScore: readNumberField(asset, ['riskScore', 'Risk Score'], deriveRiskScore(riskBand)),
          riskSignals: Array.isArray(asset['riskSignals'] ?? asset['Risk Signals'])
            ? (asset['riskSignals'] ?? asset['Risk Signals']).map(String).filter(Boolean)
            : [],
          recommendedAction: readTextField(asset, ['recommendedAction', 'Recommended Action']),
        }
      })
    : []

  const trendingActions = Array.isArray(payload.trendingActions)
    ? payload.trendingActions.map((item) => String(item)).filter(Boolean)
    : []

  return {
    assets,
    trendingActions,
    syncedAt: new Date().toISOString(),
  }
}

const hasGroundedAssets = (dashboard) => Array.isArray(dashboard?.assets) && dashboard.assets.length > 0

const directLineRequest = async (pathname, options = {}) => {
  const directLineSecret = process.env.BOT_DIRECT_LINE_SECRET

  if (!directLineSecret) {
    throw new Error('BOT_DIRECT_LINE_SECRET is not set. Add Secret 1 to .env.local.')
  }

  const response = await fetch(`https://directline.botframework.com${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${directLineSecret}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })

  const text = await response.text()
  const data = text ? JSON.parse(text) : null

  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `Direct Line request failed (${response.status}).`)
  }

  return data
}

const buildAgentUrl = () => {
  const projectEndpoint = process.env.AZURE_AI_PROJECT_ENDPOINT
  const version = process.env.AZURE_AI_API_VERSION || '2025-05-15-preview'
  const url = new URL(`${projectEndpoint}/openai/responses`)
  url.searchParams.set('api-version', version)
  return url.toString()
}

let _credential = null
const getCredential = () => {
  if (!_credential) {
    const tenantId = process.env.AZURE_TENANT_ID
    _credential = new ChainedTokenCredential(
      new AzureCliCredential(tenantId ? { tenantId } : {}),
      new InteractiveBrowserCredential(tenantId ? { tenantId } : {}),
    )
  }
  return _credential
}

const getAuthHeaders = async () => {
  const apiKey = process.env.OPENAI_API_KEY
  if (apiKey) {
    return { 'api-key': apiKey }
  }
  const tokenResponse = await getCredential().getToken('https://ai.azure.com/.default')
  return { Authorization: `Bearer ${tokenResponse.token}` }
}

const callAgent = async (promptText) => {
  const projectEndpoint = process.env.AZURE_AI_PROJECT_ENDPOINT

  if (!projectEndpoint) {
    throw new Error('AZURE_AI_PROJECT_ENDPOINT is not set in .env.')
  }

  const authHeaders = await getAuthHeaders()

  const requestBody = {
    input: [{ role: 'user', content: promptText }],
    agent_reference: {
      name: process.env.AZURE_AI_AGENT_NAME || 'renewal-agent-test1',
      ...(process.env.AZURE_AI_AGENT_VERSION ? { version: process.env.AZURE_AI_AGENT_VERSION } : {}),
      type: 'agent_reference',
    },
  }

  const response = await fetch(buildAgentUrl(), {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  })

  const rawText = await response.text()
  let data
  try {
    data = rawText ? JSON.parse(rawText) : {}
  } catch {
    data = {}
  }

  if (!response.ok) {
    const detail = rawText || JSON.stringify(data)
    console.error(`[callAgent] HTTP ${response.status}: ${detail}`)
    throw new Error(data?.error?.message || data?.message || `Agent request failed (${response.status}): ${detail}`)
  }

  const replyText =
    data.output_text ??
    data.output?.find((o) => o.type === 'message')
      ?.content?.find((c) => c.type === 'output_text')?.text ??
    ''

  if (!replyText) {
    throw new Error('Agent returned an empty response.')
  }

  try {
    return JSON.parse(extractJson(replyText))
  } catch (err) {
    console.error('[callAgent] Failed to parse agent JSON. Raw reply:', replyText.slice(0, 300))
    throw new Error(`Agent returned invalid JSON: ${err.message}`)
  }
}

const callAgentWithRetry = async (promptText, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await callAgent(promptText)
    } catch (err) {
      const isRetryable = err.message?.includes('rate_limit') || err.message?.includes('server_error') || err.message?.includes('timeout') || err.message?.includes('Timeout')
      if (!isRetryable || attempt === maxRetries) throw err
      const backoff = attempt * 5000
      console.log(`[callAgentWithRetry] attempt ${attempt} failed, retrying in ${backoff}ms...`)
      await delay(backoff)
    }
  }
}

const getDashboardFromCsv = async (weights = _currentWeights) => {
  const csvAssets = await loadCsvAssets()
  let agentResponse = null
  try {
    agentResponse = await callAgentWithRetry(buildRiskPrompt(csvAssets, weights))
  } catch (err) {
    console.warn('[getDashboardFromCsv] agent scoring failed, using local scores:', err.message)
  }
  const scores = Array.isArray(agentResponse?.scores) ? agentResponse.scores : []
  const scoreMap = new Map(scores.map((s) => [s['Id'], s]))

  const assets = csvAssets.map((row) => {
    const s = scoreMap.get(row['Id']) || {}

    // Agent is the sole source of truth for risk band and score
    let agentBand = 'Low'
    let agentScore = 0
    if (s['Risk Band']) {
      try { agentBand = normalizeRisk(s['Risk Band']) } catch { agentBand = 'Low' }
    }
    if (typeof s['Risk Score'] === 'number' && !Number.isNaN(s['Risk Score'])) {
      agentScore = Math.min(100, Math.max(0, Math.round(s['Risk Score'])))
    }

    return {
      id: row['Id'],
      assetName: row['Asset Name'],
      netPrice: parseCsvNumber(row['Net Price']),
      arr: parseCsvNumber(row['ARR']),
      term: row['Term'] || '',
      expiresInDays: parseCsvNumber(row['Expires In Days']),
      dueAmount: parseCsvNumber(row['Due Amount']),
      tcv: parseCsvNumber(row['TCV']),
      renewalAmount: parseCsvNumber(row['Renewal Amount']),
      upsellOpportunityAmount: parseCsvNumber(row['Upsell Opportunity Amount']),
      riskBand: agentBand,
      riskScore: agentScore,
      riskSignals: Array.isArray(s['Risk Signals']) ? s['Risk Signals'].map(String) : [],
      recommendedAction: s['Recommended Action'] ?? '',
    }
  })

  const trendingActions = Array.isArray(agentResponse?.trendingActions)
    ? agentResponse.trendingActions.map(String).filter(Boolean)
    : []

  const result = { assets, trendingActions, syncedAt: new Date().toISOString() }
  _cachedDashboard = result  // cache for chat context
  return result
}

// Convert raw JSON agent response into human-readable markdown (safety net)
const formatChatReply = (text) => {
  const trimmed = (text || '').trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed
  try {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed.scores)) return trimmed
    const rows = parsed.scores.map((s, i) => {
      const signals = Array.isArray(s['Risk Signals']) ? s['Risk Signals'].join('; ') : ''
      return `${i + 1}. **${s['Id']}** — ${s['Risk Band']} Risk (Score: ${s['Risk Score']})\n   Signals: ${signals}\n   Action: ${s['Recommended Action'] ?? ''}`
    }).join('\n\n')
    const trending = Array.isArray(parsed.trendingActions) && parsed.trendingActions.length
      ? '\n\n**Trending Actions:**\n' + parsed.trendingActions.map((a) => `- ${a}`).join('\n')
      : ''
    return `**Renewal Risk Analysis** (${parsed.scores.length} assets)\n\n${rows}${trending}`
  } catch {
    return trimmed
  }
}

// Prompt the agent to rewrite its own scoring configuration with new weights
const promptAgentToRewriteWeightsConfig = async (w) => {
  const filePath = path.join(serverDir, 'public', 'renewal-risk-score-aggregator.md')
  try {
    const currentContent = await readFile(filePath, 'utf8')

    const prompt =
      `You are the renewal risk scoring agent. The user has updated the scoring dimension weights.\n\n` +
      `NEW WEIGHTS (must sum to 100%):\n` +
      `- Billing Health:            ${Math.round(w.billing * 100)}%  (${w.billing.toFixed(2)})\n` +
      `- Subscription Lifecycle:    ${Math.round(w.lifecycle * 100)}%  (${w.lifecycle.toFixed(2)})\n` +
      `- Engagement:                ${Math.round(w.engagement * 100)}%  (${w.engagement.toFixed(2)})\n` +
      `- Commercial Fit:            ${Math.round(w.commercial * 100)}%  (${w.commercial.toFixed(2)})\n\n` +
      `Here is your current configuration file (renewal-risk-score-aggregator.md):\n\n` +
      `${currentContent}\n\n` +
      `Rewrite the ENTIRE file, updating ALL occurrences of the scoring weights and percentages to match the new values above. ` +
      `Update the formula in Section 2, the component percentage labels, and any Mermaid diagrams or flowcharts that show weights. ` +
      `Preserve all other content, headings, structure, and formatting exactly. ` +
      `Reply with ONLY the complete updated file content — no explanation, no markdown fences, no extra text.`

    const authHeaders = await getAuthHeaders()
    const requestBody = {
      input: [{ role: 'user', content: prompt }],
      agent_reference: {
        name: process.env.AZURE_AI_AGENT_NAME || 'renewal-agent-test1',
        ...(process.env.AZURE_AI_AGENT_VERSION ? { version: process.env.AZURE_AI_AGENT_VERSION } : {}),
        type: 'agent_reference',
      },
    }

    const response = await fetch(buildAgentUrl(), {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })

    const rawText = await response.text()
    let data
    try { data = rawText ? JSON.parse(rawText) : {} } catch { data = {} }

    if (!response.ok) {
      console.warn('[promptAgentToRewriteWeightsConfig] agent error:', data?.error?.message || rawText.slice(0, 200))
      return
    }

    const updatedContent =
      data.output_text ??
      data.output?.find((o) => o.type === 'message')
        ?.content?.find((c) => c.type === 'output_text')?.text ??
      ''

    if (updatedContent && updatedContent.trim().length > 100) {
      await writeFile(filePath, updatedContent.trim(), 'utf8')
      _knowledgeBase = null  // invalidate knowledge-base cache so new weights are picked up by chat
      console.log('[promptAgentToRewriteWeightsConfig] agent rewrote scoring config successfully')
    } else {
      console.warn('[promptAgentToRewriteWeightsConfig] agent returned empty/short content, skipping file update')
    }
  } catch (e) {
    console.warn('[promptAgentToRewriteWeightsConfig] failed:', e.message)
  }
}

const server = createServer(async (req, res) => {
  if (!req.url) {
    json(res, 400, { error: 'Missing request URL.' })
    return
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    json(res, 200, { ok: true })
    return
  }

  if (req.method === 'GET' && req.url === '/api/directline/token') {
    const directLineSecret = process.env.BOT_DIRECT_LINE_SECRET

    if (!directLineSecret) {
      json(res, 500, {
        error: 'BOT_DIRECT_LINE_SECRET is not set. Add Secret 1 to .env.local.',
      })
      return
    }

    try {
      const response = await fetch('https://directline.botframework.com/v3/directline/tokens/generate', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${directLineSecret}`,
        },
      })

      const data = await response.json()

      if (!response.ok) {
        json(res, response.status, {
          error: data?.error?.message || data?.message || 'Direct Line token request failed.',
        })
        return
      }

      json(res, 200, { token: data.token })
    } catch (error) {
      json(res, 502, {
        error: error instanceof Error ? error.message : 'Unexpected server error.',
      })
    }
    return
  }

  if (req.method === 'GET' && req.url === '/api/dashboard') {
    try {
      const dashboard = await getDashboardFromCsv()
      json(res, 200, dashboard)
    } catch (error) {
      json(res, 502, {
        error: error instanceof Error ? error.message : 'Failed to load dashboard from agent.',
      })
    }
    return
  }

  if (req.method === 'POST' && req.url === '/api/dashboard/refresh') {
    try {
      const dashboard = await getDashboardFromCsv()
      json(res, 200, dashboard)
    } catch (error) {
      json(res, 502, {
        error: error instanceof Error ? error.message : 'Failed to refresh dashboard.',
      })
    }
    return
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      const body = await readBody(req)
      const { message, previousResponseId } = body

      if (!message || typeof message !== 'string' || !message.trim()) {
        json(res, 400, { error: 'message is required.' })
        return
      }

      const agentEndpoint = process.env.AZURE_AI_PROJECT_ENDPOINT

      if (!agentEndpoint) {
        json(res, 500, { error: 'AZURE_AI_PROJECT_ENDPOINT is not set in .env.' })
        return
      }

      let userContent = message.trim()

      const authHeaders = await getAuthHeaders()

      // Inject filtered asset context for first-turn agent calls
      if (!previousResponseId) {
        try {
          const ctx = await buildContextForMessage(message)
          userContent = `${ctx}\n\n[Instructions: You MUST use the AUTHORITATIVE RISK SCORES section above as the single source of truth for each asset's risk band and score. Do NOT re-compute risk from customer signals or asset financial data. Always respond using GitHub-Flavored Markdown. When presenting asset lists, risk scores, or any tabular data use a proper markdown table (pipe-delimited columns with a header row and separator). Never output raw JSON.]\n\nUser question: ${userContent}`
        } catch {
          // non-fatal
        }
      }

      const requestBody = {
        input: [{ role: 'user', content: userContent }],
        agent_reference: {
          name: process.env.AZURE_AI_AGENT_NAME || 'renewal-agent-test1',
          ...(process.env.AZURE_AI_AGENT_VERSION ? { version: process.env.AZURE_AI_AGENT_VERSION } : {}),
          type: 'agent_reference',
        },
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      }

      const agentResponse = await fetch(buildAgentUrl(), {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      })

      const chatRawText = await agentResponse.text()
      let data
      try {
        data = chatRawText ? JSON.parse(chatRawText) : {}
      } catch {
        json(res, 502, { error: `Agent returned non-JSON response: ${chatRawText.slice(0, 200)}` })
        return
      }

      if (!agentResponse.ok) {
        json(res, agentResponse.status, {
          error: data?.error?.message || data?.message || 'Agent request failed.',
        })
        return
      }

      // Extract reply text from OpenAI Responses API format
      const rawReply =
        data.output_text ??
        data.output?.find((o) => o.type === 'message')
          ?.content?.find((c) => c.type === 'output_text')?.text ??
        ''

      // If agent returned raw JSON, format it into human-readable markdown
      const reply = formatChatReply(rawReply)

      json(res, 200, { reply, responseId: data.id ?? null })
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : 'Chat request failed.' })
    }
    return
  }
  if (req.method === 'POST' && req.url === '/api/weights') {
    try {
      const body = await readBody(req)
      const { weights } = body
      if (!weights || typeof weights !== 'object') {
        json(res, 400, { error: 'weights object is required.' })
        return
      }
      const { billing, lifecycle, engagement, commercial } = weights
      if ([billing, lifecycle, engagement, commercial].some((v) => typeof v !== 'number' || v < 0 || v > 1)) {
        json(res, 400, { error: 'Each weight must be a number between 0 and 1.' })
        return
      }
      const total = billing + lifecycle + engagement + commercial
      if (Math.abs(total - 1.0) > 0.015) {
        json(res, 400, { error: `Weights must sum to 1.0, got ${total.toFixed(3)}.` })
        return
      }
      _currentWeights = { billing, lifecycle, engagement, commercial }
      // Fire-and-forget: prompt the agent to rewrite its own scoring config with the new weights
      void promptAgentToRewriteWeightsConfig(_currentWeights)
      json(res, 200, { ok: true, weights: _currentWeights })
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : 'Failed to update weights.' })
    }
    return
  }

    json(res, 404, { error: 'Not found.' })
})

server.listen(port, () => {
  console.log(`Server listening on port ${port}`)
})