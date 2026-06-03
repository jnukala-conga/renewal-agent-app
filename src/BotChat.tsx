import { useRef, useEffect, useState, type KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export type ChatMessage = {
  role: 'user' | 'assistant'
  text: string
}

type BotChatProps = {
  messages: ChatMessage[]
  loading: boolean
  error: string | null
  input: string
  onInputChange: (val: string) => void
  onSend: () => void
}

type Urgency = 'critical' | 'warning' | 'ok'

const CRITICAL_RE = /\b(immediat|urgent|escalat|critical|overdue|churn|cancel|high.?risk|at.?risk)\b/i
const WARNING_RE  = /\b(schedul|contact|send|negotiat|discount|follow.?up|review|outreach|call|email|reach.?out|re-engage)\b/i

const getUrgency = (text: string): Urgency => {
  if (CRITICAL_RE.test(text)) return 'critical'
  if (WARNING_RE.test(text))  return 'warning'
  return 'ok'
}

// Extract up to 4 action-like sentences from a markdown response
const extractActions = (text: string): string[] => {
  const lines = text.split('\n')
  const actions: string[] = []
  for (const line of lines) {
    const clean = line.replace(/^[\s\-*\d.>]+/, '').replace(/\*\*/g, '').replace(/`/g, '').trim()
    if (
      clean.length > 12 && clean.length < 130 &&
      /\b(schedul|contact|send|escalat|negotiat|review|monitor|follow|call|email|discount|immediat|reach.?out|re-engage|flag|alert|priorit)\b/i.test(clean)
    ) {
      actions.push(clean)
      if (actions.length === 4) break
    }
  }
  return actions
}

function ActionChip({ text, urgency }: { text: string; urgency: Urgency }) {
  const [copied, setCopied] = useState(false)
  const short = text.split(' ').slice(0, 5).join(' ') + (text.split(' ').length > 5 ? '…' : '')

  const handleClick = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  return (
    <button
      className={`action-chip action-chip--${urgency}`}
      onClick={handleClick}
      title={text}
    >
      {copied ? '✓ Copied' : short}
    </button>
  )
}

export default function BotChat({ messages, loading, error, input, onInputChange, onSend }: BotChatProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  return (
    <div className="bot-chat-frame">
      <div className="bot-chat-messages">
        {messages.map((msg, i) => {
          if (msg.role === 'user') {
            return (
              <div key={i} className="bot-chat-bubble bot-chat-bubble--user">{msg.text}</div>
            )
          }
          const actions = extractActions(msg.text)
          return (
            <div key={i}>
              <div className="bot-chat-bubble bot-chat-bubble--assistant">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
              </div>
              {actions.length > 0 && (
                <div className="action-chips">
                  {actions.map((a, j) => (
                    <ActionChip key={j} text={a} urgency={getUrgency(a)} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {loading && (
          <div className="bot-chat-bubble bot-chat-bubble--assistant bot-chat-bubble--loading">
            Thinking…
          </div>
        )}
        {error && <div className="bot-chat-status bot-chat-status--error">{error}</div>}
        <div ref={bottomRef} />
      </div>
      <div className="bot-chat-input-row">
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about renewals…"
          rows={1}
          disabled={loading}
        />
        <button onClick={onSend} disabled={loading || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  )
}
