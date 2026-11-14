# Measurement tool guidelines

Follow the target checkout's root instructions and `scripts/perf/AGENTS.md` for
product adapter changes. [README.md](README.md) owns tool invocation and evidence
boundaries. Keep one owner per implementation; do not copy product components.

Keep isolated startup, loopback sources, PID/start/executable ownership,
nonactivation, visibility, source continuity and owned shutdown mandatory. Never
modify daily configuration or control the daily app, Core, Service, TUN, DNS or
system proxy. Read-only command-boundary snapshots follow README. Native runs
are serial; Chrome/Vite checks do not establish native acceptance. Measurement
contract changes require a schema bump and fresh reports.

Reuse product-installed frontend/native build dependencies through an explicit
project path. Install this checkout's locked automation dependencies with
`pnpm install --frozen-lockfile`; do not add a second React or Tauri frontend tree.
Dirty worktrees are supported; preserve source, adapter, dependency,
binary and report identity. A/B must hold the measurement implementation and input
constant. Adapter differences require source review, never automatic acceptance.

For tool implementation changes run scoped ESLint, formatting and the existing
report/collector tests. Run both product perf TypeScript projects and relevant
production checks for integration changes, including scoped Rust Clippy before
freezing the optimized artifact. Follow README validation order; native coverage
uses that frozen source and binary. Runtime or measurement changes require
affected-layer native three-phase smoke, three independent runs, A/A,
invalid/incomparable rejection and injected-failure cleanup. Before expanding a
scenario or comparison matrix, pass the smallest native path:
isolated startup, actual owned WebContent attribution, expected data delivery,
visibility, nonactivation and owned shutdown. Verify prerequisites normally supplied
by the product entry. Revisit a failed assumption before retrying; repeat affected
checks when relevant inputs change, and do not relabel earlier evidence as fresh.

Keep lifecycle/isolation validity, performance sample eligibility and comparison
benefit separate. Follow the README's fixed host policy and retain all excluded or
failed attempts with their reasons; do not select retries after inspecting benefit.
Preserve source/dependency/binary/report bindings and native behavior preflight.
Keep evidence on ignored paths until diagnosis or requested cleanup; cleanup only
exact task-owned marked artifact directories using the supported command.
