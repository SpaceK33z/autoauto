// Barrel re-export — all daemon client functionality
// Split into: daemon-spawn.ts, daemon-watcher.ts, daemon-status.ts

export { spawnDaemon } from "./daemon-spawn.ts"
export { watchRunDir, type WatchCallbacks, type DaemonWatcher } from "./daemon-watcher.ts"
export {
  getDaemonStatus,
  reconstructState,
  sendStop,
  sendAbort,
  forceKillDaemon,
  updateMaxExperiments,
  getMaxExperiments,
  findActiveRun,
  type DaemonStatus,
} from "./daemon-status.ts"
