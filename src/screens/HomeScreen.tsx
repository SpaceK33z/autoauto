import { useState, useEffect, useRef } from "react"
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
import { formatShellError } from "../lib/git.ts"
import { listDrafts, deleteDraft, type DraftSession, type DraftEntry } from "../lib/drafts.ts"
import { readQueue, removeFromQueue, clearQueue, type QueueFile } from "../lib/queue.ts"
import { abortAndDeleteActiveRuns, cleanupStaleRuns } from "../lib/daemon-status.ts"
import { colors } from "../lib/theme.ts"

interface HomeScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
  onSelectProgram: (slug: string) => void
  onSelectRun: (run: RunInfo) => void
  onUpdateProgram: (slug: string) => void
  onFinalizeRun: (run: RunInfo) => void
  onResumeDraft: (draftName: string, draft: DraftSession) => void
  onResumeQueue?: () => void
  onPanelChange?: (panel: Panel) => void
}

interface HomeData {
  programs: ProgramInfo[]
  allRuns: RunInfo[]
  programConfigs: Record<string, ProgramConfig>
  drafts: DraftEntry[]
  queue: QueueFile
}

const MAX_RUNS = 50

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
  const [programs, drafts, queue] = await Promise.all([listPrograms(cwd), listDrafts(cwd), readQueue(cwd)])
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

      // Clean up runs whose daemon died while the TUI wasn't watching
      await cleanupStaleRuns(programDir, runs)

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
    drafts,
    queue,
  }
}

export type Panel = "programs" | "runs" | "queue"

export function HomeScreen({ cwd, navigate, onSelectProgram, onSelectRun, onUpdateProgram, onFinalizeRun, onResumeDraft, onResumeQueue, onPanelChange }: HomeScreenProps) {
  const { width } = useTerminalDimensions()
  const [data, setData] = useState<HomeData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedRunIndex, setSelectedRunIndex] = useState(0)
  const [focusedPanel, setFocusedPanel] = useState<Panel>("programs")
  const [confirmDelete, setConfirmDelete] = useState<RunInfo | null>(null)
  const [confirmDeleteProgram, setConfirmDeleteProgram] = useState<ProgramInfo | null>(null)
  const [confirmClearQueue, setConfirmClearQueue] = useState(false)
  const [selectedQueueIndex, setSelectedQueueIndex] = useState(0)
  const [deleting, setDeleting] = useState(false)
  const onResumeQueueRef = useRef(onResumeQueue)
  onResumeQueueRef.current = onResumeQueue
  const lastClickRef = useRef<{ panel: Panel; index: number; time: number } | null>(null)

  useEffect(() => {
    onPanelChange?.(focusedPanel)
  }, [focusedPanel])

  useEffect(() => {
    loadHomeData(cwd)
      .then((d) => {
        setData(d)
      })
      .catch((err: unknown) => {
        setError(formatShellError(err))
      })
      .finally(() => setLoading(false))
  }, [cwd])

  const programs = data?.programs ?? []
  const drafts = data?.drafts ?? []
  const draftsCount = drafts.length
  const totalProgramItems = draftsCount + programs.length
  const selectableRuns = (data?.allRuns ?? []).filter((r) => r.state != null)
  const queueEntries = data?.queue?.entries ?? []
  const hasQueueItems = queueEntries.length > 0

  const performDeleteDraft = (draftEntry: DraftEntry) => {
    setDeleting(true)
    deleteDraft(cwd, draftEntry.name)
      .then(() => {
        setDeleting(false)
        loadHomeData(cwd).then((newData) => {
          setData(newData)
          const newTotal = newData.drafts.length + newData.programs.length
          setSelectedIndex((i) => Math.min(i, Math.max(0, newTotal - 1)))
        })
      })
      .catch(() => {
        setDeleting(false)
      })
  }

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
          const newTotal = newData.drafts.length + newData.programs.length
          setSelectedIndex((i) => Math.min(i, Math.max(0, newTotal - 1)))
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
    // Confirmation dialogs intercept all keys
    if (confirmClearQueue) {
      if (key.name === "return") {
        clearQueue(cwd).then(() => {
          setConfirmClearQueue(false)
          loadHomeData(cwd).then((newData) => {
            setData(newData)
            setSelectedQueueIndex(0)
            setFocusedPanel("programs")
          })
        }).catch(() => {
          setConfirmClearQueue(false)
        })
      } else if (key.name === "escape" || key.name === "n") {
        setConfirmClearQueue(false)
      }
      return
    }
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
      // If a draft exists, resume it instead of starting new
      if (drafts.length > 0) {
        const entry = drafts[0]
        onResumeDraft(entry.name, entry.draft)
      } else {
        navigate("setup")
      }
      return
    }
    if (key.name === "s" && !(focusedPanel === "queue" && hasQueueItems && onResumeQueueRef.current)) {
      navigate("settings")
      return
    }
    if (key.name === "tab") {
      setFocusedPanel((p) => {
        if (p === "programs") return "runs"
        if (p === "runs") return hasQueueItems ? "queue" : "programs"
        return "programs" // queue → programs
      })
      return
    }

    if (focusedPanel === "programs" && totalProgramItems > 0) {
      if (key.name === "up" || key.name === "k") {
        setSelectedIndex((i) => Math.max(0, i - 1))
      } else if (key.name === "down" || key.name === "j") {
        setSelectedIndex((i) => Math.min(totalProgramItems - 1, i + 1))
      } else if (key.name === "return") {
        if (selectedIndex < draftsCount) {
          // Selected a draft — resume it
          const entry = drafts[selectedIndex]
          onResumeDraft(entry.name, entry.draft)
        } else {
          onSelectProgram(programs[selectedIndex - draftsCount].name)
        }
      } else if (key.name === "e") {
        if (selectedIndex >= draftsCount) {
          const program = programs[selectedIndex - draftsCount]
          if (program && !program.hasActiveRun) {
            onUpdateProgram(program.name)
          }
        }
      } else if (key.name === "d") {
        if (selectedIndex < draftsCount) {
          // Delete draft directly (no confirmation needed for drafts)
          performDeleteDraft(drafts[selectedIndex])
        } else {
          const program = programs[selectedIndex - draftsCount]
          if (program && !program.hasActiveRun) {
            setConfirmDeleteProgram(program)
          }
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
      } else if (key.name === "f") {
        const run = selectableRuns[selectedRunIndex]
        if (run && run.state?.phase === "complete") {
          onFinalizeRun(run)
        }
      } else if (key.name === "d") {
        const run = selectableRuns[selectedRunIndex]
        if (run && !isRunActive(run)) {
          setConfirmDelete(run)
        }
      }
    } else if (focusedPanel === "queue" && hasQueueItems) {
      if (key.name === "up" || key.name === "k") {
        setSelectedQueueIndex((i) => Math.max(0, i - 1))
      } else if (key.name === "down" || key.name === "j") {
        setSelectedQueueIndex((i) => Math.min(queueEntries.length - 1, i + 1))
      } else if (key.name === "d") {
        const entry = queueEntries[selectedQueueIndex]
        if (entry) {
          const programSlug = entry.programSlug
          removeFromQueue(cwd, entry.id).then(async () => {
            // If no queue entries remain for this program, also abort any
            // active run that was auto-started from the queue
            const updatedQueue = await readQueue(cwd)
            if (!updatedQueue.entries.some(e => e.programSlug === programSlug)) {
              await abortAndDeleteActiveRuns(cwd, programSlug)
            }
            const newData = await loadHomeData(cwd)
            setData(newData)
            const newLen = newData.queue.entries.length
            setSelectedQueueIndex((i) => Math.min(i, Math.max(0, newLen - 1)))
            if (newLen === 0) setFocusedPanel("programs")
          }).catch(() => {})
        }
      } else if (key.name === "c") {
        setConfirmClearQueue(true)
      } else if (key.name === "s") {
        onResumeQueueRef.current?.()
      }
    }
  })

  if (loading) {
    return (
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <text fg={colors.textMuted}>Loading...</text>
      </box>
    )
  }

  if (error) {
    return (
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <text fg={colors.error} selectable>Error: {error}</text>
      </box>
    )
  }

  const programsFocused = focusedPanel === "programs"
  const runsFocused = focusedPanel === "runs"
  const queueFocused = focusedPanel === "queue"

  const programsPanel = (
    <box
      flexDirection="column"
      flexGrow={1}
      minWidth={0}
      border
      borderStyle="rounded"
      borderColor={programsFocused ? colors.borderActive : colors.borderDim}
      title="Programs"
      onMouseDown={() => setFocusedPanel("programs")}
    >
      {totalProgramItems === 0 ? (
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text fg={colors.textDim}>No programs yet.</text>
        </box>
      ) : (
        <scrollbox flexGrow={1}>
          {drafts.map((d, i) => {
            const isSelected = programsFocused && i === selectedIndex
            const date = new Date(d.draft.createdAt)
            const label = d.draft.type === "update" && d.draft.programSlug
              ? `${d.draft.programSlug} (draft)`
              : `Draft (${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })})`
            return (
              <box
                key={`draft-${d.name}`}
                paddingX={1}
                backgroundColor={isSelected ? colors.surfaceSelected : undefined}
                onMouseDown={() => {
                  const now = Date.now()
                  const last = lastClickRef.current
                  setFocusedPanel("programs")
                  setSelectedIndex(i)
                  if (last && last.panel === "programs" && last.index === i && now - last.time < 400) {
                    onResumeDraft(d.name, d.draft)
                    lastClickRef.current = null
                  } else {
                    lastClickRef.current = { panel: "programs", index: i, time: now }
                  }
                }}
              >
                <text>
                  <span fg={colors.warning}>{"* "}</span>
                  <span fg={colors.warning}>{label}</span>
                </text>
              </box>
            )
          })}
          {programs.map((p, i) => {
            const isSelected = programsFocused && (i + draftsCount) === selectedIndex
            return (
              <box
                key={p.name}
                paddingX={1}
                backgroundColor={isSelected ? colors.surfaceSelected : undefined}
                onMouseDown={() => {
                  const now = Date.now()
                  const last = lastClickRef.current
                  const itemIndex = i + draftsCount
                  setFocusedPanel("programs")
                  setSelectedIndex(itemIndex)
                  if (last && last.panel === "programs" && last.index === itemIndex && now - last.time < 400) {
                    onSelectProgram(p.name)
                    lastClickRef.current = null
                  } else {
                    lastClickRef.current = { panel: "programs", index: itemIndex, time: now }
                  }
                }}
              >
                <text>
                  {p.hasActiveRun ? (
                    <span fg={colors.primary}>{"● "}</span>
                  ) : (
                    <span fg={colors.surfaceSelected}>{"  "}</span>
                  )}
                  <span fg={colors.text}>{p.name}</span>
                  <span fg={colors.textDim}>
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
      {programsFocused && selectedIndex >= draftsCount && programs[selectedIndex - draftsCount]?.hasActiveRun && (
        <box paddingX={1}>
          <text fg={colors.textDim}>Cannot edit/delete while run is active</text>
        </box>
      )}
    </box>
  )

  const runsPanel = (
    <box
      flexDirection="column"
      flexGrow={1}
      minWidth={0}
      border
      borderStyle="rounded"
      borderColor={runsFocused ? colors.borderActive : colors.borderDim}
      title="Runs"
      onMouseDown={() => setFocusedPanel("runs")}
    >
      <RunsTable
        runs={data?.allRuns ?? []}
        programConfigs={data?.programConfigs ?? {}}
        width={width}
        focused={runsFocused}
        selectedIndex={selectedRunIndex}
        onSelectIndex={(i) => { setFocusedPanel("runs"); setSelectedRunIndex(i) }}
        onActivateIndex={(i) => {
          const run = selectableRuns[i]
          if (run) onSelectRun(run)
        }}
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
      borderColor={colors.borderDanger}
      backgroundColor={colors.surface}
      padding={1}
      title="Delete Run"
    >
      <text fg={colors.error}><strong>Delete this run?</strong></text>
      <box height={1} />
      <text fg={colors.text}>
        {confirmDelete.state?.program_slug ?? "?"} / {confirmDelete.run_id}
      </text>
      <text fg={colors.textDim}>
        {confirmDelete.state?.phase ?? "unknown"} · {confirmDelete.state ? (confirmDelete.state.total_keeps + confirmDelete.state.total_discards + confirmDelete.state.total_crashes) : 0} experiments
      </text>
      <box height={1} />
      <text fg={colors.textDim}>
        {deleting ? "Deleting..." : "This will remove the run directory, worktree, and branch."}
      </text>
      <box height={1} />
      <text fg={colors.textMuted}>Enter to confirm · Esc to cancel</text>
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
      borderColor={colors.borderDanger}
      backgroundColor={colors.surface}
      padding={1}
      title="Delete Program"
    >
      <text fg={colors.error}><strong>Delete this program?</strong></text>
      <box height={1} />
      <text fg={colors.text}>{confirmDeleteProgram.name}</text>
      <text fg={colors.textDim}>
        {confirmDeleteProgram.totalRuns} run{confirmDeleteProgram.totalRuns !== 1 ? "s" : ""} will also be deleted
      </text>
      <box height={1} />
      <text fg={colors.textDim}>
        {deleting ? "Deleting..." : "This will remove all program files, runs, worktrees, and branches."}
      </text>
      <box height={1} />
      <text fg={colors.textMuted}>Enter to confirm · Esc to cancel</text>
    </box>
  ) : null

  const queuePanel = hasQueueItems ? (
    <box
      flexDirection="column"
      flexGrow={1}
      minWidth={0}
      border
      borderStyle="rounded"
      borderColor={queueFocused ? colors.borderActive : colors.borderDim}
      title={`Queue (${queueEntries.length})`}
      onMouseDown={() => setFocusedPanel("queue")}
    >
      <scrollbox flexGrow={1}>
        {queueEntries.map((entry, i) => {
          const isSelected = queueFocused && i === selectedQueueIndex
          return (
            <box key={entry.id} paddingX={1} backgroundColor={isSelected ? colors.surfaceSelected : undefined} onMouseDown={() => { setFocusedPanel("queue"); setSelectedQueueIndex(i) }}>
              <text>
                <span fg={i === 0 ? colors.primary : colors.text}>{i === 0 ? "\u25B6 " : "  "}</span>
                <span fg={colors.text}>{entry.programSlug}</span>
                <span fg={colors.textDim}>{` ${entry.maxExperiments}exp \u00B7 ${entry.modelConfig.model}`}</span>
                {entry.retryCount > 0 && <span fg={colors.error}>{` (retry ${entry.retryCount})`}</span>}
              </text>
            </box>
          )
        })}
      </scrollbox>
    </box>
  ) : null

  const clearQueueDialog = confirmClearQueue ? (
    <box
      position="absolute"
      top="40%"
      left="30%"
      width="40%"
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={colors.borderDanger}
      backgroundColor={colors.surface}
      padding={1}
      title="Clear Queue"
    >
      <text fg={colors.error}><strong>Clear all queued runs?</strong></text>
      <box height={1} />
      <text fg={colors.text}>{queueEntries.length} run{queueEntries.length !== 1 ? "s" : ""} will be removed from the queue.</text>
      <box height={1} />
      <text fg={colors.textMuted}>Enter to confirm · Esc to cancel</text>
    </box>
  ) : null

  return (
    <box flexGrow={1} flexDirection="column" minHeight={0}>
      {runsPanel}
      <box flexDirection="row" flexGrow={1} minHeight={0} minWidth={0}>
        {programsPanel}
        {queuePanel}
      </box>
      {deleteDialog}
      {deleteProgramDialog}
      {clearQueueDialog}
    </box>
  )
}
