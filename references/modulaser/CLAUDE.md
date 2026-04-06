# CLAUDE.md

Modulaser converts video/images/procedural graphics to laser output. It controls real hardware (laser DACs) so bugs can have physical consequences - be careful with output-related code.

Read `docs/design-principles.md` for the foundational beliefs that drive all architectural decisions — especially the top priority of never blocking laser output, and fail-dark safety.

Start with `docs/architecture.md` for a full map of the codebase: subsystems, data flow, dependency directions, and key files.

## Worktree Safety

NEVER make changes to files outside the current worktree. If working in a worktree (e.g. `.worktrees/clip-layers`), all file edits must stay within that directory. Do not touch the main repo or other worktrees.

## Validation

Always validate changes with this exact command:

```bash
cargo check --all-targets && cargo test --quiet && cargo clippy --all-targets -- -D warnings
```

Cargo runs with minimal output - no output usually means success, not failure.

To manually verify the app works:

```bash
RUST_LOG=info cargo run -- --debug-socket 2>&1
```

Run this in background, have user verify visually, check for panics/errors.

Use `/modulaser-ctl` to verify changes at runtime — inspect clips, parameters, laser output, and take screenshots of the running app.

## Performance: Laser Points Usually Change Every Frame

In the typical animated case, the pipeline produces new laser point data every tick. Any downstream consumer of point data (beam view geometry, preview tessellation, output group rendering) therefore usually needs fresh per-frame work. Don't assume caching point-derived results will help; first optimize the per-frame path itself (fast math, SIMD, reduced allocations, algorithmic improvements). Caching is still valid when inputs are actually stable and invalidation is precise.

## Test-First Development

For non-UI changes: write a failing test FIRST, run it to see it fail, then implement. No exceptions — "small change" is not an excuse. If you find yourself editing `src/` without a failing test, STOP and write the test. For pure UI changes, say "Skipping TDD: pure UI" so I can push back.

## Architecture Guardrails

When an architecture test fails (file size limits, dependency rules, etc.), fix the actual problem — split the file, move code, refactor. NEVER add entries to exception lists (like `KNOWN_LARGE_FILES`) to make a test pass. Exception lists exist for pre-existing tech debt that humans decided to accept, not as an escape hatch for new changes.

## Commit Messages

Use conventional commits: `type(scope): description`

- **Types**: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`
- **Scope**: required, lowercase, e.g. `beam-view`, `pipeline`, `ui`, `dac`
- **Description**: starts lowercase, no trailing period

Examples:

- `feat(beam-view): add resizable mini panel`
- `fix(preview): rendering outside scroll area bounds`
- `perf(checkerboard): batch into single mesh`

The commit-msg hook in `.githooks/` enforces this. Git must be configured to use it: `git config core.hooksPath .githooks`

## Code Style

- No comments unless logic is genuinely non-obvious or documents critical architecture constraints
- No docstrings on private functions, except high-value docs for foundational structures
- No error handling for impossible cases
- No traits/generics until there's a second use case
- No commented-out code - delete it

## Docs

- `docs/design-principles.md` - **Read first.** Foundational beliefs: output priority, fail-dark, non-blocking, safety
- `docs/architecture.md` - **Start here.** Subsystems, data flow, threading, dependency directions
- `docs/quality.md` - Subsystem quality grades, test coverage, known gaps (risk map for agents)
- `docs/pipeline/overview.md` - Shared frame-based rendering engine
- `docs/pipeline/frame-rendering.md` - Geometric shape rendering with LaserFrame caching
- `docs/pipeline/safety.md` - Non-bypassable safety pipeline: arming, motion limits, blind lasers
- `docs/node-graph.md` - Node graph engine: shared ops, node types, scalar sampling, preset graphs
- `docs/modulation.md` - Modulator types (LFO/Audio/Envelope/Sequencer/Noise), routing table, parameter targets
- `docs/lasers.md` - Laser hardware config (DACs, corners, NDI)
- `docs/laser-dac.md` - laser-dac-rs crate: DAC abstraction, discovery, streaming, custom backends
- `docs/avb.md` - AVB audio-based laser DAC protocol: channel layout, resampling, device discovery
- `docs/output-groups.md` - Output groups: clip-to-laser routing with priority resolution
- `docs/cues.md` - Cue list: sequential clip playback with auto-advance, MIDI/OSC control
- `docs/layers.md` - Clip layer stacking with per-layer visibility, opacity, and compositing
- `docs/blind-zones.md` - Exclusion regions within lasers for safety/equipment
- `docs/external-control.md` - Shared control infrastructure for MIDI and OSC
- `docs/midi.md` - MIDI input/output, clock sync, and learn mode
- `docs/osc.md` - OSC input/output, default addresses, custom mappings, learn mode
- `docs/midi_mappings/apc40-mk2.md` - AKAI APC40 mkII MIDI controller mapping reference
- `docs/midi_mappings/midi-fighter-twister.md` - DJ TechTools MIDI Fighter Twister mapping reference
- `docs/bpm.md` - BPM, tap tempo, MIDI clock, and Ableton Link tempo sync
- `docs/audio.md` - Audio input: device setup, per-channel gate/limit, audio modulator modes and controls
- `docs/ndi.md` - NDI video input: discovery, connection pooling, raster-to-vector pipeline
- `docs/timeline.md` - Frame-accurate clip scheduling synced to SMPTE or internal clock
- `docs/project-files.md` - .modu file format, versioning, v1 legacy migration, portable export
- `docs/recording.md` - Video and export format capture
- `docs/perfect-loop-recording.md` - Auto-stop recording on oscillator/modulator loop completion
- `docs/file-inputs.md` - ILDA, SVG, and OBJ file input handling
- `docs/obj-files.md` - OBJ 3D mesh loading with edge extraction and camera projection
- `docs/svg-optimization.md` - SVG path optimization: flattening, reordering
- `docs/laser-profiles.md` - Laser profile: hardware config (PPS, blanking, velocity, RGB voltage calibration)
- `docs/velocity-profiles.md` - Velocity profiles (legacy) and curvature-aware resampling
- `docs/beam_view.md` - 3D beam projection visualization onto simulated room walls
- `docs/keyboard-shortcuts.md` - Keyboard shortcut systems, platform differences, focus gating, known issues
- `docs/library.md` - Categorized clip library, drag-to-apply, JSON storage, lazy loading
- `docs/macros.md` - Six macro control links per clip for live parameter adjustment
- `docs/layout.md` - Multi-view UI layout with clip controls, modulators, preview
- `docs/thumbnails.md` - Clip preview thumbnail generation and caching
- `docs/egui-dropzones.md` - Egui drag-and-drop patterns using global drag state
- `docs/auto-update.md` - Velopack-based cross-platform auto-update system
- `docs/releasing.md` - Release workflow using GitHub Actions
- `docs/control-socket.md` - Unix domain socket protocol for remote control and programmatic access
- `docs/performance-tradeoffs.md` - Performance findings and visual cost tradeoffs
- `docs/osc-audit.md` - OSC handling audit findings
- `docs/timecode-audit.md` - Timecode/SMPTE/LTC implementation audit
- `docs/how-lasers-work.md` - General reference: galvo-based show laser projection physics, optimization, and ideal output
