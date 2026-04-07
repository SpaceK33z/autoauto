#!/usr/bin/env bun

if (process.argv.length > 2) {
  const { run } = await import("./cli.ts")
  await run(process.argv.slice(2))
} else {
  await import("./tui.tsx")
}
