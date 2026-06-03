import { createServer } from 'node:http'
import dotenv from 'dotenv'
import { readFile, writeFile } from 'node:fs/promises'
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

const port = Number(process.env.BOT_TOKEN_SERVER_PORT || 3978)

let lastGroundedDashboard = null

// Parsed and joined asset data, cached after first load
let _allJoinedAssets = null
const getAllJoinedAssets = async () => {
  if (_allJoinedAssets) return _allJoinedAssets

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
    `ID:${a.id} | Customer:${a.customerName} | Product:${a.product} | Status:${a.status} | ExpiresInDays:${a.expiresInDays} | EndDate:${a.endDate} | ARR:${a.arr} | NetPrice:${a.netPrice} | DueAmount:${a.dueAmount} | TCV:${a.tcv} | RenewalAmt:${a.renewalAmt} | Term:${a.term}mo`
  ).join('\n')

  return `[ASSET DATA — ${filtered.length} asset(s) matching your query]\n${rows}`
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

// Detect if message is a data-analysis query that we can handle server-side
const isDataQuery = (msg) => {
  const lower = msg.toLowerCase()
  return /score|risk|expir|rank|high risk|recommend|action|analyz|assess/.test(lower)
}

// Handle data queries by scoring filtered assets with the reliable dashboard approach
const handleDataQuery = async (message) => {
  const all = await getAllJoinedAssets()
  const msg = message.toLowerCase()

  // Extract expiry window
  let maxDays = Infinity
  const daysMatch = msg.match(/next\s+(\d+)\s+days?|(\d+)\s*days?/)
  if (daysMatch) maxDays = Number(daysMatch[1] || daysMatch[2])

  // Extract customer name mentions
  const custNames = [...new Set(all.map((a) => a.customerName))]
  const mentionedCustomers = custNames.filter((n) => msg.includes(n.toLowerCase()))

  // Filter
  let filtered = all
  if (mentionedCustomers.length > 0) filtered = filtered.filter((a) => mentionedCustomers.includes(a.customerName))
  if (maxDays < Infinity) filtered = filtered.filter((a) => a.expiresInDays <= maxDays)

  // Only use local handling if we narrowed it down meaningfully
  if (filtered.length === 0 || filtered.length === all.length) return null

  // Score using the reliable prompt (data embedded, single request)
  const gridAssets = filtered.map(joinedToGridFormat)
  const scored = await callAgentWithRetry(buildRiskPrompt(gridAssets))
  const scores = Array.isArray(scored.scores) ? scored.scores : []

  // Sort by risk score descending
  scores.sort((a, b) => (b['Risk Score'] || 0) - (a['Risk Score'] || 0))

  // Build human-readable reply
  const customerLabel = mentionedCustomers.length > 0 ? mentionedCustomers.join(', ') : 'All customers'
  const expiryLabel = maxDays < Infinity ? `expiring within ${maxDays} days` : ''
  const header = `**Renewal Risk Analysis** — ${customerLabel}${expiryLabel ? ` · ${expiryLabel}` : ''} (${scores.length} asset${scores.length !== 1 ? 's' : ''})\n\n`

  const rows = scores.map((s, i) => {
    const risk = s['Risk Band'] || 'Unknown'
    const score = s['Risk Score'] || 0
    const signals = Array.isArray(s['Risk Signals']) ? s['Risk Signals'].join('; ') : ''
    const action = s['Recommended Action'] || ''
    return `${i + 1}. **${s['Id']}** — ${risk} Risk (Score: ${score})\n   Signals: ${signals}\n   Action: ${action}`
  }).join('\n\n')

  const highRisk = scores.filter((s) => s['Risk Band'] === 'High')
  const summary = highRisk.length > 0
    ? `\n\n⚠️ **${highRisk.length} High Risk asset(s)** require immediate attention.`
    : `\n\n✅ No High Risk assets in this filter.`

  return header + rows + summary
}

const buildRiskPrompt = (assets) => {
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

Scoring rules:
- Due Amount > 0 → billing risk (higher = worse)
- Expires In Days < 30 → urgency risk
- Low ARR relative to Net Price → financial mismatch
- Risk Band: Low (0-40), Medium (41-70), High (71-100)
- Map any "Critical" to "High"

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

  const data = await response.json()

  if (!response.ok) {
    const detail = JSON.stringify(data)
    console.error(`[callAgent] HTTP ${response.status}: ${detail}`)
    throw new Error(data?.error?.message || data?.message || `Agent request failed (${response.status}): ${detail}`)
  }

  const replyText =
    data.output_text ??
    data.output?.find((o) => o.type === 'message')
      ?.content?.find((c) => c.type === 'output_text')?.text ??
    ''

  return JSON.parse(extractJson(replyText))
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

const getDashboardFromCsv = async () => {
  const csvAssets = await loadCsvAssets()

  // Attempt to score assets via agent (one request, data embedded)
  let scoreMap = new Map()
  let trendingActions = []
  try {
    const agentResponse = await callAgentWithRetry(buildRiskPrompt(csvAssets))
    if (Array.isArray(agentResponse.scores)) {
      scoreMap = new Map(agentResponse.scores.map((s) => [s['Id'], s]))
    }
    if (Array.isArray(agentResponse.trendingActions)) {
      trendingActions = agentResponse.trendingActions.map(String).filter(Boolean)
    }
    console.log(`[getDashboardFromCsv] agent scored ${scoreMap.size} assets`)
  } catch (err) {
    console.error('[getDashboardFromCsv] agent scoring failed, using CSV defaults:', err.message)
  }

  const assets = csvAssets.map((row) => {
    const score = scoreMap.get(row['Id']) || {}
    let riskBand = 'Medium'
    try {
      riskBand = normalizeRisk(readTextField(score, ['Risk Band'], 'Medium'))
    } catch { /* keep Medium */ }

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
      riskBand,
      riskScore: readNumberField(score, ['Risk Score'], deriveRiskScore(riskBand)),
      riskSignals: Array.isArray(score['Risk Signals']) ? score['Risk Signals'].map(String).filter(Boolean) : [],
      recommendedAction: readTextField(score, ['Recommended Action'], ''),
    }
  })

  return { assets, trendingActions, syncedAt: new Date().toISOString() }
}

const getStableDashboard = async () => {
  if (lastGroundedDashboard) return lastGroundedDashboard
  const dashboard = await getDashboardFromCsv()
  lastGroundedDashboard = dashboard
  return dashboard
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
      const dashboard = await getStableDashboard()
      json(res, 200, dashboard)
    } catch (error) {
      json(res, 502, {
        error: error instanceof Error ? error.message : 'Failed to load dashboard from agent.',
      })
    }
    return
  }

  if (req.method === 'POST' && req.url === '/api/dashboard/refresh') {
    lastGroundedDashboard = null
    try {
      const dashboard = await getDashboardFromCsv()
      lastGroundedDashboard = dashboard
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

      const authHeaders = await getAuthHeaders()

      // On first message: try server-side data query handling first (avoids agent tool timeouts)
      let userContent = message.trim()
      if (!previousResponseId && isDataQuery(message)) {
        try {
          const dataReply = await handleDataQuery(message)
          if (dataReply) {
            json(res, 200, { reply: dataReply, responseId: null })
            return
          }
        } catch (err) {
          console.error('[chat] data query handler failed, falling back to agent:', err.message)
        }
      }

      // Inject filtered asset context for first-turn agent calls
      if (!previousResponseId) {
        try {
          const ctx = await buildContextForMessage(message)
          userContent = `${ctx}\n\nUser question: ${userContent}`
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

      const data = await agentResponse.json()

      if (!agentResponse.ok) {
        json(res, agentResponse.status, {
          error: data?.error?.message || data?.message || 'Agent request failed.',
        })
        return
      }

      // Extract reply text from OpenAI Responses API format
      const reply =
        data.output_text ??
        data.output?.find((o) => o.type === 'message')
          ?.content?.find((c) => c.type === 'output_text')?.text ??
        ''

      json(res, 200, { reply, responseId: data.id ?? null })
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : 'Chat request failed.' })
    }
    return
  }

  json(res, 404, { error: 'Not found.' })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Token server listening on http://127.0.0.1:${port}`)
})