# Autoresearch: egui UI Performance Optimization

You are one iteration of an autonomous hill-climbing loop that makes Modulaser's egui UI layer faster and leaner. An external orchestrator handles the loop, measurement, and keep/discard decisions. Your job: analyze, implement ONE optimization, validate, and commit.

## MANDATORY: Load the egui Skill

**Before reading or editing ANY file in `src/ui/`, you MUST run the `/egui` skill.** No exceptions. Do this at the very start of your session, before analyzing code. The skill contains critical egui patterns, layout gotchas, hit-testing rules, and drag-and-drop idioms that prevent common bugs.

## Your Task

1. **LOAD SKILL**: Run `/egui` immediately. Do not proceed without it.

2. **ANALYZE**: Read the most recent profile analysis in `.traces/autoresearch-egui/` (the newest `*.txt` file) to identify main thread bottlenecks related to egui/UI rendering. Read `.traces/autoresearch-egui/autoresearch-results.tsv` to see what's been tried before. Read recent git history with `git log --oneline --decorate -n 20` and inspect reverted experiment commits with `git show <commit>` so you don't repeat discarded approaches. Read `docs/performance-tradeoffs.md` for historical context on what works and what doesn't.

3. **PLAN**: Pick ONE concrete optimization target in the UI layer. Describe it in one sentence. Think about what files need to change and the expected effect.

4. **IMPLEMENT**: Edit source code. Keep changes minimal and focused — one optimization per iteration. Follow all rules in CLAUDE.md (test-first for non-UI changes, no over-engineering, code style).

5. **VALIDATE**: Run:
   ```bash
   cargo check --all-targets && cargo test --quiet && cargo clippy --all-targets -- -D warnings
   ```
   If this fails, fix the issue. Do NOT skip validation. Do NOT discard changes yourself — if you can't fix validation, just exit without committing and the orchestrator will handle cleanup.

6. **COMMIT**: Stage and commit:
   ```bash
   git add -A && git commit -m "perf(scope): description"
   ```

Then EXIT. The orchestrator handles building, measuring, and keep/discard.

## Metric

**avg_egui_render_us** — wall-clock microseconds spent in `render_panels()` each frame. This measures only the egui widget building phase (layout, widget creation, painting), isolated from GPU submission, pipeline work, and vsync. Lower = better.

Secondary metric: **avg_egui_update_us** — the full `eframe::App::update()` time including polling, state management, and render_panels. Logged but not used for keep/discard.

Both are sampled from the control socket's `GetStateSummary` response every 0.5s during a 15-second measurement window. The app runs with `--uncapped-fps` to maximize frame throughput.

## CRITICAL: No Visual Changes

**Every optimization MUST be visually invisible to the user.** The UI must look pixel-identical before and after your change. This means:

- NO removing UI elements, controls, labels, or decorations
- NO changing colors, opacity, spacing, font sizes, or layout
- NO reducing visual quality (anti-aliasing, gradients, shadows, bloom, glow)
- NO changing animation smoothness or timing
- NO altering hover/click/drag feedback behavior
- NO skipping rendering of visible elements

If you're unsure whether a change is visually neutral, don't make it. The only acceptable changes are those that produce the exact same pixels more efficiently.

## Scope — egui UI Code ONLY

This program targets the egui UI layer specifically. Stay within these boundaries.

### Mutable (your optimization targets)
- `src/ui/**` — all UI code (widgets, panels, views, controls, preview)
- `src/theme/` — only for reducing rendering cost (NOT for changing colors/styles)
- `src/beam_view/` — only the egui integration parts (not the wgpu rendering)
- `Cargo.toml` — only for feature flags or dependency options (no new deps)

### Off-Limits (NEVER edit these)
- `scripts/autoresearch.sh` — the orchestrator
- `scripts/autoresearch-egui/` — this program config
- `scripts/measure-*.sh` — metric extraction scripts
- `scripts/profile*.sh` — profiling scripts
- `scripts/analyze-*.py` — analysis scripts
- `scripts/profile-scenes/default.jsonl` — reproducible scene setup
- `src/engine/` — core engine (not UI)
- `src/pipeline/` — pipeline evaluation and output (not UI)
- `src/dac/` — DAC communication (not UI)

## What to Optimize

### High-Impact egui Patterns

Current profile shows the main thread at 67% of total CPU. The biggest egui costs are widget creation, child Ui allocation, scroll/layout, and paint buffer updates. Target these first:

- **Widget count reduction**: `create_widget` (2.4% self) + `WidgetRects::insert` (0.6%) show every widget has real per-frame cost. Each `ui.label()`, `ui.add()`, knob, or slider adds up. Combine where possible, skip when not visible. `CollapsingBoard::show_with_state_inner` is 20% inclusive — sections with many controls are prime targets.
- **Child Ui / layout nesting reduction**: `Ui::new_child` appears as a top caller of `platform_memmove` (13% of memmove). Deep nesting of `ui.horizontal()` / `ui.vertical()` / `ui.scope()` / `Frame::show` creates child Ui objects that copy layout state. Flatten nesting, merge redundant scopes, avoid wrapping single widgets in layout containers.
- **Scroll area optimization**: `ScrollArea::show` is 29% inclusive time. Off-screen content inside scroll areas still gets laid out by default — check `ui.is_rect_visible()` or clip rect intersection before building widgets. Already done for `CollapsingBoard` sections but may be missing in other scroll contexts.
- **Paint and buffer updates**: `paint_and_update_textures` (45% inclusive) and `Renderer::update_buffers` (caller of memmove) show that the paint/upload phase is a major cost. Reduce the number of shapes/meshes egui has to tessellate and upload. Mesh caching for static content helps — already done for checkerboard, look for other static UI elements.
- **Allocation reduction**: `platform_memmove` (5.1% self) is the #1 function. It's driven by `Vec` growth, `String` formatting, and mesh buffer reallocation. Pre-allocate capacity, reuse buffers, avoid `format!()` in per-frame code.
- **Conditional rendering**: Skip entire panel sections when collapsed, hidden, or not relevant to current state. Check state BEFORE building the UI, not after. `allocate_ui_with_layout_dyn` (18% inclusive) and `horizontal_with_main_wrap_dyn` (15% inclusive) show layout is expensive even for invisible content.

### Lower-Impact (Still Valid)

- **RwLock / context access**: `<deduplicated_symbol>` (3.1% self, 49% from `graphics_mut`) is egui's internal RwLock. Reduce the number of `ctx.write()` / `graphics_mut` calls where possible.
- **Text measurement**: `GalleyCache::layout` (0.5% self) — cache text sizes when content doesn't change.
- **Color computation**: Repeated `Color32::from_rgba_unmultiplied()` or alpha blending in loops. Precompute and reuse.
- **Texture handles**: Creating or looking up textures per-frame when they could be cached.
- **Redundant repaints**: `ctx.request_repaint()` called too broadly forces unnecessary frames. Narrow repaint triggers to actual state changes.

### What Does NOT Work (Don't Try These)

- **Caching egui sections across frames**: egui is immediate mode — no shape replay mechanism. Interaction requires widget code to run. (See performance-tradeoffs.md #10)
- **Disabling feathering globally**: Causes visible aliasing on 1x displays. Only acceptable on ≥2x HiDPI. (See #11)
- **Rayon parallel tessellation**: Work-stealing overhead exceeds benefit. Already tried and removed. (See #13)

## Rules

- **One change per iteration.** Don't combine multiple optimizations — the orchestrator can't tell which one helped.
- **Zero visual impact.** This is non-negotiable. The UI must look identical. If you can't make it faster without changing how it looks, pick a different target.
- **No new dependencies.** Only what's already in `Cargo.toml`.
- **Validate before exiting.** Don't leave broken code for the orchestrator to measure.
- **Read the profile.** Don't guess at bottlenecks — let the data tell you where time is spent. Focus on the hottest UI-related functions first.
- **Follow CLAUDE.md.** Test-first for non-UI changes, conventional commits, no over-engineering.
- **Load `/egui` first.** Before reading or editing any `src/ui/` file.

## Tips

- The main thread is ~67% of total CPU. The top self-time functions are: `platform_memmove` (5.1%), `<deduplicated_symbol>` / RwLock (3.1%), `create_widget` (2.4%), `tessellate_rect` (1.6%), `platform_memset` (1.3%). These all trace back to Modulaser's UI code.
- When the profile shows high time in `epaint`/`egui` internals, the fix is usually in Modulaser's UI code (reducing what we ask egui to paint), not in egui itself.
- `create_widget` high? → too many widgets. 48% comes from `Ui::interact`, 25% from `Ui::new_child`. Reduce widget count or skip invisible widgets.
- `platform_memmove` high? → 23% from `mi_memcpy` (allocator), 13% from `Ui::new_child` (child layout copies), 10% from `paint_and_update_textures`. Flatten layout nesting and reduce shape count.
- `<deduplicated_symbol>` (RwLock) high? → 49% from `graphics_mut`. Reduce the number of graphics layer accesses per frame.
- `CollapsingBoard::show_with_state_inner` is 20% inclusive — board panels with many controls are the highest-value optimization targets.
- `ScrollArea::show` is 29% inclusive — off-screen content inside scroll areas is being fully laid out.
- Modulation circles appear on every routable parameter — per-circle overhead multiplies across the entire UI.
- The node graph viewer (`src/ui/node_graph/viewer.rs`, 2500+ lines) and timeline (`src/ui/timeline_view/`) are the most complex UI subsystems — high potential for optimization but also high risk of subtle breakage.
- The "Laser Points Change Every Frame" note in CLAUDE.md means preview-related data changes constantly, but UI chrome (panels, buttons, labels) is mostly static — target the static parts for caching.
