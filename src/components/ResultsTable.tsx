import type { ExperimentResult, ExperimentStatus } from "../lib/run.ts"

interface ResultsTableProps {
  results: ExperimentResult[]
  metricField: string
}

function statusColor(status: ExperimentStatus): string {
  switch (status) {
    case "keep": return "#9ece6a"
    case "discard": return "#ff5555"
    case "crash": return "#ff5555"
    case "measurement_failure": return "#e0af68"
  }
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : str + " ".repeat(width - str.length)
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + "…" : str
}

export function ResultsTable({ results, metricField }: ResultsTableProps) {
  // Skip the baseline row (#0) — it's in the stats header
  const experiments = results.filter(r => r.experiment_number > 0)

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Results">
      <box padding={1}>
        <text fg="#888888">
          {padRight("#", 4)}{padRight("commit", 9)}{padRight(metricField, 12)}{padRight("status", 12)}description
        </text>
      </box>
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        {experiments.length === 0 ? (
          <box padding={1}>
            <text fg="#888888">No experiments yet...</text>
          </box>
        ) : (
          experiments.map((r) => (
            <box key={r.experiment_number} padding={1}>
              <text fg={statusColor(r.status)}>
                {padRight(String(r.experiment_number), 4)}
                {padRight(r.commit, 9)}
                {padRight(r.metric_value ? String(r.metric_value) : "—", 12)}
                {padRight(r.status, 12)}
                {truncate(r.description, 40)}
              </text>
            </box>
          ))
        )}
      </scrollbox>
    </box>
  )
}
