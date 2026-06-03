import { useState, useRef, useEffect, type KeyboardEvent } from 'react'

type Message = {
  role: 'user' | 'assistant'
  text: string
}

type ChatResponse = {
  reply?: string
  responseId?: string
  error?: string
}

export default function BotChat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previousResponseId, setPreviousResponseId] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || loading) return

    setInput('')
    setError(null)
    setMessages((prev) => [...prev, { role: 'user', text }])
    setLoading(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, previousResponseId }),
      })
      const data = (await res.json()) as ChatResponse
      if (!res.ok) throw new Error(data.error || 'Chat request failed.')
      setMessages((prev) => [...prev, { role: 'assistant', text: data.reply ?? '' }])
      if (data.responseId) setPreviousResponseId(data.responseId)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to get a response.')
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage()
    }
  }

  return (
    <div className="bot-chat-frame">
      <div className="bot-chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`bot-chat-bubble bot-chat-bubble--${msg.role}`}>
            {msg.text}
          </div>
        ))}
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
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about renewals…"
          rows={1}
          disabled={loading}
        />
        <button onClick={() => void sendMessage()} disabled={loading || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  )
}
