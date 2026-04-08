import { useState, useEffect } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import {
  listPrograms,
  loadProgramConfig,
  getProgramDir,
  type ProgramInfo,
  type ProgramConfig,
  type Screen,
} from "../lib/programs.ts"
import { listRuns, isRunActive, deleteRun, deleteProgram, type RunInfo } from "../lib/run.ts"
import { RunsTable } from "../components/RunsTable.tsx"

interface HomeScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
  onSelectProgram: (slug: string) => void
  onSelectRun: (run: RunInfo) => void
  onUpdateProgram: (slug: string) => void
}

interface HomeData {
  programs: ProgramInfo[]
  allRuns: RunInfo[]
  programConfigs: Record<string, ProgramConfig>
}

const MAX_RUNS = 50
const SIDE_BY_SIDE_MIN_WIDTH = 120
const PROGRAMS_PANEL_WIDTH = 50

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return "just now"
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

/** Single-pass loader: iterates programs once to build program info, all runs, and configs. */
async function loadHomeData(cwd: string): Promise<HomeData> {
  const programs = await listPrograms(cwd)
  const allRuns: RunInfo[] = []
  const programInfos: ProgramInfo[] = []
  const programConfigs: Record<string, ProgramConfig> = {}

  await Promise.all(
    programs.map(async (p) => {
      const programDir = getProgramDir(cwd, p.name)
      const [runs, config] = await Promise.all([
        listRuns(programDir),
        loadProgramConfig(programDir).catch(() => null),
      ])

      allRuns.push(...runs)
      if (config) programConfigs[p.name] = config

      const latest = runs.length > 0 ? runs[0] : null
      programInfos.push({
        name: p.name,
        totalRuns: runs.length,
        lastRunDate: latest?.state?.started_at ?? null,
        hasActiveRun: runs.some(isRunActive),
      })
    }),
  )

  // Programs: active pinned to top, then most recently used first
  programInfos.sort((a, b) => {
    if (a.hasActiveRun && !b.hasActiveRun) return -1
    if (!a.hasActiveRun && b.hasActiveRun) return 1
    if (a.lastRunDate && b.lastRunDate) return b.lastRunDate.localeCompare(a.lastRunDate)
    if (a.lastRunDate && !b.lastRunDate) return -1
    if (!a.lastRunDate && b.lastRunDate) return 1
    return a.name.localeCompare(b.name)
  })

  // In-progress pinned to top, then newest first
  allRuns.sort((a, b) => {
    const aActive = isRunActive(a)
    const bActive = isRunActive(b)
    if (aActive && !bActive) return -1
    if (!aActive && bActive) return 1
    return b.run_id.localeCompare(a.run_id)
  })

  return {
    programs: programInfos,
    allRuns: allRuns.slice(0, MAX_RUNS),
    programConfigs,
  }
}

type Panel = "programs" | "runs"

export function HomeScreen({ cwd, navigate, onSelectProgram, onSelectRun, onUpdateProgram }: HomeScreenProps) {
  const { width } = useTerminalDimensions()
  const [data, setData] = useState<HomeData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedRunIndex, setSelectedRunIndex] = useState(0)
  const [focusedPanel, setFocusedPanel] = useState<Panel>("programs")
  const [confirmDelete, setConfirmDelete] = useState<RunInfo | null>(null)
  const [confirmDeleteProgram, setConfirmDeleteProgram] = useState<ProgramInfo | null>(null)
  const [deleting, setDeleting] = useState(false)

  const sideBySide = width >= SIDE_BY_SIDE_MIN_WIDTH

  useEffect(() => {
    loadHomeData(cwd)
      .then(setData)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setLoading(false))
  }, [cwd])

  const programs = data?.programs ?? []
  const selectableRuns = (data?.allRuns ?? []).filter((r) => r.state != null)

  const performDelete = (run: RunInfo) => {
    setDeleting(true)
    deleteRun(cwd, run)
      .then(() => {
        setConfirmDelete(null)
        setDeleting(false)
        // Reload data
        loadHomeData(cwd).then((newData) => {
          setData(newData)
          // Clamp selection index
          const newSelectableRuns = (newData.allRuns ?? []).filter((r) => r.state != null)
          setSelectedRunIndex((i) => Math.min(i, Math.max(0, newSelectableRuns.length - 1)))
        })
      })
      .catch(() => {
        setConfirmDelete(null)
        setDeleting(false)
      })
  }

  const performDeleteProgram = (program: ProgramInfo) => {
    setDeleting(true)
    deleteProgram(cwd, program.name)
      .then(() => {
        setConfirmDeleteProgram(null)
        setDeleting(false)
        loadHomeData(cwd).then((newData) => {
          setData(newData)
          setSelectedIndex((i) => Math.min(i, Math.max(0, newData.programs.length - 1)))
          const newSelectableRuns = (newData.allRuns ?? []).filter((r) => r.state != null)
          setSelectedRunIndex((i) => Math.min(i, Math.max(0, newSelectableRuns.length - 1)))
        })
      })
      .catch(() => {
        setConfirmDeleteProgram(null)
        setDeleting(false)
      })
  }

  useKeyboard((key) => {
    // Confirmation dialog intercepts all keys
    if (confirmDeleteProgram) {
      if (key.name === "return") {
        performDeleteProgram(confirmDeleteProgram)
      } else if (key.name === "escape" || key.name === "n") {
        setConfirmDeleteProgram(null)
      }
      return
    }
    if (confirmDelete) {
      if (key.name === "return") {
        performDelete(confirmDelete)
      } else if (key.name === "escape" || key.name === "n") {
        setConfirmDelete(null)
      }
      return
    }

    if (key.name === "n") {
      navigate("setup")
      return
    }
    if (key.name === "s") {
      navigate("settings")
      return
    }
    if (key.name === "tab") {
      setFocusedPanel((p) => (p === "programs" ? "runs" : "programs"))
      return
    }

    if (focusedPanel === "programs" && programs.length > 0) {
      if (key.name === "up" || key.name === "k") {
        setSelectedIndex((i) => Math.max(0, i - 1))
      } else if (key.name === "down" || key.name === "j") {
        setSelectedIndex((i) => Math.min(programs.length - 1, i + 1))
      } else if (key.name === "return") {
        onSelectProgram(programs[selectedIndex].name)
      } else if (key.name === "e") {
        const program = programs[selectedIndex]
        if (program && !program.hasActiveRun) {
          onUpdateProgram(program.name)
        }
      } else if (key.name === "d") {
        const program = programs[selectedIndex]
        if (program && !program.hasActiveRun) {
          setConfirmDeleteProgram(program)
        }
      }
    } else if (focusedPanel === "runs" && selectableRuns.length > 0) {
      if (key.name === "up" || key.name === "k") {
        setSelectedRunIndex((i) => Math.max(0, i - 1))
      } else if (key.name === "down" || key.name === "j") {
        setSelectedRunIndex((i) => Math.min(selectableRuns.length - 1, i + 1))
      } else if (key.name === "return") {
        const run = selectableRuns[selectedRunIndex]
        if (run) onSelectRun(run)
      } else if (key.name === "d") {
        const run = selectableRuns[selectedRunIndex]
        if (run && !isRunActive(run)) {
          setConfirmDelete(run)
        }
      }
    }
  })

  if (loading) {
    return (
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <text fg="#888888">Loading...</text>
      </box>
    )
  }

  if (error) {
    return (
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <text fg="#ff5555" selectable>Error: {error}</text>
      </box>
    )
  }

  const programsFocused = focusedPanel === "programs"
  const runsFocused = focusedPanel === "runs"

  const programsPanel = (
    <box
      flexDirection="column"
      flexGrow={sideBySide ? 0 : 1}
      width={sideBySide ? PROGRAMS_PANEL_WIDTH : undefined}
      border
      borderStyle="rounded"
      borderColor={programsFocused ? "#7aa2f7" : "#565f89"}
      title="Programs"
    >
      {programs.length === 0 ? (
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text fg="#565f89">No programs yet.</text>
        </box>
      ) : (
        <scrollbox flexGrow={1}>
          {programs.map((p, i) => {
            const isSelected = programsFocused && i === selectedIndex
            return (
              <box
                key={p.name}
                paddingX={1}
                backgroundColor={isSelected ? "#333333" : undefined}
              >
                <text>
                  {p.hasActiveRun ? (
                    <span fg="#7aa2f7">{"● "}</span>
                  ) : (
                    <span fg="#333333">{"  "}</span>
                  )}
                  <span fg={isSelected ? "#ffffff" : "#c0caf5"}>{p.name}</span>
                  <span fg="#565f89">
                    {" "}
                    {p.totalRuns > 0 ? `${p.totalRuns}r` : ""}
                    {p.lastRunDate ? ` ${relativeTime(p.lastRunDate)}` : ""}
                  </span>
                </text>
              </box>
            )
          })}
        </scrollbox>
      )}
      {programsFocused && programs[selectedIndex]?.hasActiveRun && (
        <box paddingX={1}>
          <text fg="#565f89">Cannot edit/delete while run is active</text>
        </box>
      )}
    </box>
  )

  const runsTableWidth = sideBySide ? width - PROGRAMS_PANEL_WIDTH : width
  const runsPanel = (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderStyle="rounded"
      borderColor={runsFocused ? "#7aa2f7" : "#565f89"}
      title="Runs"
    >
      <RunsTable
        runs={data?.allRuns ?? []}
        programConfigs={data?.programConfigs ?? {}}
        width={runsTableWidth}
        focused={runsFocused}
        selectedIndex={selectedRunIndex}
      />
    </box>
  )

  const deleteDialog = confirmDelete ? (
    <box
      position="absolute"
      top="40%"
      left="30%"
      width="40%"
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor="#ff5555"
      backgroundColor="#1a1b26"
      padding={1}
      title="Delete Run"
    >
      <text fg="#ff5555"><strong>Delete this run?</strong></text>
      <box height={1} />
      <text fg="#c0caf5">
        {confirmDelete.state?.program_slug ?? "?"} / {confirmDelete.run_id}
      </text>
      <text fg="#565f89">
        {confirmDelete.state?.phase ?? "unknown"} · {confirmDelete.state ? (confirmDelete.state.total_keeps + confirmDelete.state.total_discards + confirmDelete.state.total_crashes) : 0} experiments
      </text>
      <box height={1} />
      <text fg="#565f89">
        {deleting ? "Deleting..." : "This will remove the run directory, worktree, and branch."}
      </text>
      <box height={1} />
      <text fg="#888888">Enter to confirm · Esc to cancel</text>
    </box>
  ) : null

  const deleteProgramDialog = confirmDeleteProgram ? (
    <box
      position="absolute"
      top="40%"
      left="30%"
      width="40%"
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor="#ff5555"
      backgroundColor="#1a1b26"
      padding={1}
      title="Delete Program"
    >
      <text fg="#ff5555"><strong>Delete this program?</strong></text>
      <box height={1} />
      <text fg="#c0caf5">{confirmDeleteProgram.name}</text>
      <text fg="#565f89">
        {confirmDeleteProgram.totalRuns} run{confirmDeleteProgram.totalRuns !== 1 ? "s" : ""} will also be deleted
      </text>
      <box height={1} />
      <text fg="#565f89">
        {deleting ? "Deleting..." : "This will remove all program files, runs, worktrees, and branches."}
      </text>
      <box height={1} />
      <text fg="#888888">Enter to confirm · Esc to cancel</text>
    </box>
  ) : null

  if (sideBySide) {
    return (
      <box flexGrow={1} flexDirection="row">
        {programsPanel}
        {runsPanel}
        {deleteDialog}
        {deleteProgramDialog}
      </box>
    )
  }

  return (
    <box flexGrow={1}>
      {focusedPanel === "programs" ? programsPanel : runsPanel}
      {deleteDialog}
      {deleteProgramDialog}
    </box>
  )
}
