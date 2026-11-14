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

Reuse product-installed build and automation dependencies through an explicit
project path. Dirty worktrees are supported; preserve source, adapter, dependency,
binary and report identity. A/B must hold the measurement implementation and input
constant. Adapter differences require source review, never automatic acceptance.

For tool implementation changes run scoped ESLint, formatting and the existing
report/collector tests. Run both product perf TypeScript projects and relevant
production checks for integration changes, including scoped Rust Clippy before
freezing the optimized artifact. Follow README validation order; native coverage
uses that frozen source and binary. Runtime or measurement changes require
affected-layer native three-phase smoke, three independent runs, A/A,
invalid/incomparable rejection and injected-failure cleanup. First pass the
smallest native path before expanding. Retain failures until diagnosed; cleanup
only exact task-owned marked artifact directories using the supported command.
