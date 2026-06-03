import { createServer } from 'node:http'
import dotenv from 'dotenv'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { InteractiveBrowserCredential } from '@azure/identity'

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

const buildRiskPrompt = (assetIds) => `Reply with JSON only. No explanation, no markdown, just the JSON object.

For each of the following asset IDs, compute a Renewal Risk Band and Risk Score based on billing health, engagement signals, subscription lifecycle, and commercial fit signals.

Asset IDs: ${assetIds.join(', ')}

Return this exact shape:
{
  "scores": [
    {
      "Id": "ALI-001",
      "Risk Band": "Medium",
      "Risk Score": 73,
      "Risk Signals": ["45 days overdue invoice ($2.9K outstanding)", "Primary contacts had 0 logins in last 60 days"],
      "Recommended Action": "NORMAL: Proactive outreach before renewal"
    }
  ],
  "trendingActions": ["URGENT: Action"]
}

Rules:
- Risk Band must be Low, Medium, or High (map Critical to High).
- Risk Score must be an integer between 0 and 100.
- Risk Signals must be an array of 2-4 brief plain-English signals that explain the score (e.g. billing issues, low engagement, expiry urgency, support tickets). Be specific using the asset data.
- Return exactly one entry per asset ID provided.
- No invented IDs.`

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
    _credential = new InteractiveBrowserCredential(tenantId ? { tenantId } : {})
  }
  return _credential
}

const getAuthHeaders = async () => {
  const apiKey = process.env.OPENAI_API_KEY
  if (apiKey) return { 'api-key': apiKey }
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

const getDashboardFromAgent = async () => {
  // Load asset data from local CSV (ground truth — no hallucination)
  const csvAssets = await loadCsvAssets()
  const assetIds = csvAssets.map((a) => a['Id'])

  // Ask agent only for Risk Band, Risk Score, Recommended Action
  const agentResponse = await callAgent(buildRiskPrompt(assetIds))

  const scores = Array.isArray(agentResponse.scores) ? agentResponse.scores : []
  const scoreMap = new Map(scores.map((s) => [s['Id'], s]))

  const assets = csvAssets.map((row) => {
    const score = scoreMap.get(row['Id']) || {}
    let riskBand
    try {
      riskBand = normalizeRisk(readTextField(score, ['Risk Band'], 'Low'))
    } catch {
      riskBand = 'Low'
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
      riskBand,
      riskScore: readNumberField(score, ['Risk Score'], deriveRiskScore(riskBand)),
      riskSignals: Array.isArray(score['Risk Signals']) ? score['Risk Signals'].map(String).filter(Boolean) : [],
      recommendedAction: readTextField(score, ['Recommended Action'], ''),
    }
  })

  const trendingActions = Array.isArray(agentResponse.trendingActions)
    ? agentResponse.trendingActions.map((item) => String(item)).filter(Boolean)
    : []

  return {
    assets,
    trendingActions,
    syncedAt: new Date().toISOString(),
  }
}

const getStableDashboard = async () => {
  if (lastGroundedDashboard) {
    return lastGroundedDashboard
  }

  let lastEmptyDashboard = null
  let lastError = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const dashboard = await getDashboardFromAgent()

      if (hasGroundedAssets(dashboard)) {
        lastGroundedDashboard = dashboard
        return dashboard
      }

      lastEmptyDashboard = dashboard
    } catch (error) {
      lastError = error
    }
  }

  if (lastGroundedDashboard) {
    return lastGroundedDashboard
  }

  if (lastEmptyDashboard) {
    return lastEmptyDashboard
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to load dashboard from agent.')
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
    // Clear the in-memory cache so the next call re-queries the agent
    lastGroundedDashboard = null
    try {
      const dashboard = await getDashboardFromAgent()
      if (hasGroundedAssets(dashboard)) {
        lastGroundedDashboard = dashboard
      }
      json(res, 200, dashboard)
    } catch (error) {
      json(res, 502, {
        error: error instanceof Error ? error.message : 'Failed to refresh scores from agent.',
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

      const requestBody = {
        input: [{ role: 'user', content: message.trim() }],
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