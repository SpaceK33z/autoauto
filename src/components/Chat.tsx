import { useState, useCallback } from "react"
import { query } from "@anthropic-ai/claude-agent-sdk"

export function Chat() {
  const [response, setResponse] = useState("")
  const [loading, setLoading] = useState(false)

  const handleSubmit = useCallback(
    async (value: string) => {
      const prompt = value.trim()
      if (!prompt || loading) return

      setLoading(true)
      setResponse("")

      try {
        for await (const message of query({
          prompt,
          options: {
            systemPrompt:
              "You are AutoAuto, an autoresearch assistant. Be concise.",
            maxTurns: 1,
            allowedTools: [],
            includePartialMessages: true,
          },
        })) {
          if (message.type === "stream_event") {
            const event = message.event
            if (
              event.type === "content_block_delta" &&
              "delta" in event &&
              event.delta.type === "text_delta" &&
              "text" in event.delta
            ) {
              setResponse((prev: string) => prev + (event.delta as { text: string }).text)
            }
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        setResponse(`Error: ${message}`)
      } finally {
        setLoading(false)
      }
    },
    [loading]
  )

  return (
    <box flexDirection="column" flexGrow={1}>
      <scrollbox focused={loading} flexGrow={1} border borderStyle="rounded">
        <text>
          {response || "Type a message below and press Enter to ask Claude."}
        </text>
      </scrollbox>

      <box border borderStyle="rounded" height={3} title="Message">
        <input
          placeholder="Ask something..."
          focused={!loading}
          // eslint-disable-next-line typescript-eslint/no-explicit-any -- OpenTUI type conflict between React and Core onSubmit signatures
          onSubmit={((value: string) => { handleSubmit(value) }) as any}
        />
      </box>

      <text fg="#888888">
        {loading ? " Streaming..." : " Enter: send | Escape: quit"}
      </text>
    </box>
  )
}
