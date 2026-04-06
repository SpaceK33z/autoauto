# Design Principles

These are the foundational beliefs that shape every architectural decision in Modulaser. Read this before making changes that touch threading, output, safety, or cross-subsystem boundaries.

## 1. Laser output is the top priority

Modulaser controls physical hardware. Users run 10+ lasers simultaneously in live performance. The DAC threads and pipeline thread must never be starved, blocked, or delayed by anything else in the application.

## 2. Fail-dark on every failure mode

If anything goes wrong, lasers go dark. Never the opposite. This is a physical safety constraint — a stuck-on laser can cause eye damage or burns.

**Every failure mode produces blank-at-park** (laser off, galvos at safe center position):

- DAC disarmed → blank-at-park
- No frame available → blank-at-park
- DAC output-path fault → blank-at-park, emergency disarm
- Lock poisoning → blank-at-park, emergency disarm
- DAC thread stall → independent watchdog thread disarms after timeout
- Pipeline wedge → watchdog disarms (watchdog is independent of pipeline)

**The watchdog is independent** because if the pipeline thread hangs, anything that depends on the pipeline also hangs. The watchdog runs on its own thread, checks DAC liveness every 50ms, and emergency-disarms any DAC that stops producing output for 500ms.

## 3. Safety is non-bypassable and defense-in-depth

All laser output passes through a four-stage safety pipeline in the DAC output filter. No code path can skip it. Each stage catches a different category of fault:

1. **Arming gate** — explicit operator control over emission
2. **Motion safety** — protect galvos from excessive displacement
3. **Energy safety** — prevent burns from concentrated power
4. **Output invariants** — repair NaN, infinity, out-of-range values

All clip sources are treated as untrusted. Safety is enforced in output space (after laser mapping), not input space. This means bugs in content generation, node graph evaluation, or modulation can never produce unsafe hardware output.

**Repair, never reject.** The output invariants stage repairs bad values to safe ranges rather than dropping output. A repaired presented slice is better than silence (which could cause its own galvo issues).

See `docs/pipeline/safety.md` for the full safety pipeline reference.

## 4. Non-blocking across all thread boundaries

No thread should ever block waiting for another thread to complete work. This applies everywhere, not just the pipeline:

- **Pipeline → UI**: `try_send` with drop-on-full (capacity-1 bounded channel)
- **UI → Pipeline**: unbounded `mpsc::channel`, pipeline drains with `try_recv`
- **Pipeline → DAC**: `Arc<Mutex>` for shared state, lock poisoning recovered (never panic)
- **Shared config**: `AtomicU32` for motion limits (DAC reads lock-free), atomics for simple flags
- **Recording**: feeds frames to background encoder threads, results polled later
- **MIDI/OSC**: processed inside the pipeline tick, not on separate threads

When adding new cross-thread communication, default to channels. Use `Arc<Mutex>` only when shared mutable state is genuinely needed (like arming controllers shared between pipeline and DAC). Always handle lock poisoning — recover with `unwrap_or_else(|e| e.into_inner())` or treat as error and fail-dark.

## 5. UI is a thin read-only view

The UI thread reads `PipelineState` snapshots and sends `PipelineCommand`s. It never does heavy computation, never accesses pipeline internals, and never directly touches hardware state.

**Enforced mechanically:** Architecture tests in `src/architecture_tests.rs` verify that `src/ui/` and `src/app/` never import pipeline submodules (`frame_cache`, `recording`, `output`, `velocity_profile`, `motion`, `energy`, etc.) — only the top-level public API (`PipelineHandle`, `PipelineCommand` and its subtypes, `PipelineState`). Shared data types needed by both UI and pipeline (`OutputParams`, `StrobeParams`, `VelocityProfilePreset`, `VelocityProfileParams`, `MIN_FRAME_POINTS`, `STROBE_MAX`) live in `src/laser.rs`, while `ColorOverride` lives in `src/colorize.rs`.

`PipelineState` uses `Arc<T>` for all collections so the snapshot is cheap to send across the channel (pointer bump, not deep clone). The pipeline rebuilds state every frame using dirty flags to skip unchanged collections.

## 6. Centralized visual identity

All UI colors come from `theme::colors()`, a thread-local `Arc<ThemeColors>` with ~145 semantic color definitions. No raw `Color32` or `Rgba` constructors in UI code — base colors must come from the theme.

Computed colors (alpha blending, lerping between theme colors) are fine. The rule is about _base_ colors, not every color value.
