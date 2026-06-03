import { useEffect, useState } from 'react'
import ReactWebChat, { createDirectLine } from 'botframework-webchat'

const styleOptions = {
  accent: '#5f6fd8',
  backgroundColor: '#ffffff',
  bubbleBackground: '#f3f6ff',
  bubbleBorderRadius: 14,
  bubbleFromUserBackground: '#5f6fd8',
  bubbleFromUserBorderRadius: 14,
  bubbleFromUserTextColor: '#ffffff',
  disableFileUpload: true,
  primaryFont: 'Segoe UI, sans-serif',
  rootHeight: '100%',
  rootWidth: '100%',
  sendBoxBackground: '#ffffff',
  sendBoxBorderTop: '1px solid #dfe7f8',
  sendBoxButtonColor: '#5f6fd8',
  sendBoxTextColor: '#283552',
}

export default function BotChat() {
  const [directLine, setDirectLine] = useState<ReturnType<typeof createDirectLine> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/directline/token')
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Token request failed: ${res.status} ${res.statusText}`)
        }

        return res.json()
      })
      .then((data) => {
        setDirectLine(createDirectLine({ token: data.token }))
      })
      .catch((err: Error) => {
        setError(`Failed to connect to agent: ${err.message}`)
      })
  }, [])

  if (error) {
    return <div className="bot-chat-status bot-chat-status--error">{error}</div>
  }

  if (!directLine) {
    return <div className="bot-chat-status">Connecting to agent...</div>
  }

  return (
    <div className="bot-chat-frame">
      <ReactWebChat directLine={directLine} styleOptions={styleOptions} />
    </div>
  )
}
