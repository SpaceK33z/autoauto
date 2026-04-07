import { useState, useEffect } from "react"
import { useKeyboard } from "@opentui/react"
import { listPrograms, type Program, type Screen } from "../lib/programs.ts"

interface HomeScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
  onSelectProgram: (slug: string) => void
}

export function HomeScreen({ cwd, navigate, onSelectProgram }: HomeScreenProps) {
  const [programs, setPrograms] = useState<Program[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    listPrograms(cwd)
      .then(setPrograms)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setLoading(false))
  }, [cwd])

  useKeyboard((key) => {
    if (key.name === "n") {
      navigate("setup")
    } else if (key.name === "s") {
      navigate("settings")
    } else if (programs.length > 0) {
      if (key.name === "up" || key.name === "k") {
        setSelected((s) => Math.max(0, s - 1))
      } else if (key.name === "down" || key.name === "j") {
        setSelected((s) => Math.min(programs.length - 1, s + 1))
      } else if (key.name === "return") {
        onSelectProgram(programs[selected].name)
      }
    }
  })

  if (loading) {
    return (
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <text fg="#888888">Loading programs...</text>
      </box>
    )
  }

  if (error) {
    return (
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <text fg="#ff5555">Error: {error}</text>
      </box>
    )
  }

  if (programs.length === 0) {
    return (
      <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
        <text fg="#888888">No programs yet.</text>
        <text fg="#888888">
          Press <strong>n</strong> to create one.
        </text>
      </box>
    )
  }

  return (
    <scrollbox focused flexGrow={1} border borderStyle="rounded" title="Programs">
      {programs.map((program, i) => (
        <box key={program.name} height={1}>
          <text fg={i === selected ? "#ffffff" : "#888888"}>
            {i === selected ? " ▸ " : "   "}
            {program.name}
          </text>
        </box>
      ))}
    </scrollbox>
  )
}
