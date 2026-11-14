# Clash Verge Rev measurement harness

This guide covers harness operation and evidence interpretation. Instructions for
agents modifying the tool live in [AGENTS.md](AGENTS.md).
Extracted from Clash Verge Rev under GPL-3.0-only; see [LICENSE](LICENSE).
Product-dependent scenes, real component imports and the isolated native entry
remain in the target checkout at `scripts/perf`.
The dedicated optimized Tauri WKWebView supports the production home traffic graph
and Logs/Connections page, component, and minimal DOM layers. It measures shown
updates, native hide, then restoration. It does not run Mihomo Core, Service, or
external network traffic. The loopback source is owned by the harness.

## Validate Before Freezing A Build

Complete static checks before building the binary used for native validation.
From the tool checkout, run its scoped ESLint, formatting and report tests using
product-installed tools (commands are below). From the product checkout, run:

```sh
pnpm exec tsc -p scripts/perf/tsconfig.json --noEmit
pnpm exec tsc -p scripts/perf/tsconfig.node.json --noEmit
pnpm exec eslint --config eslint.config.ts --max-warnings=0 scripts/perf
pnpm exec biome format scripts/perf/*.ts scripts/perf/*.tsx scripts/perf/*.mts scripts/perf/*.json
cargo fmt --check
TAURI_CONFIG="$(cat scripts/perf/tauri.json)" cargo clippy -p clash-verge --bin clash-verge --release --features perf-harness,clippy --locked --target-dir target/perf/cargo --no-deps -- -D warnings
```

The `clippy` feature uses a mock asset context for compile-only checks, so this
step does not depend on stale frontend output. The final optimized build uses
`perf-harness` without `clippy` and embeds the real frontend. Build only after
checks and source review pass, then freeze that source and binary for the minimum
native path followed by the affected scenario coverage. A source change reopens
only affected checks; never relabel earlier runs as tests of a new binary.
Ordinary product builds do not run this validation sequence or require the tool.

## Build And Run

Use the target product checkout’s installed pnpm, Rust and Xcode Command Line
Tools on macOS. The tool loads automation dependencies from that checkout and
uses its Vite, React, Tauri and Cargo dependency environment. No tool install or
second frontend dependency tree is needed. No global
WebDriver installation is needed. Keep each binary beside its generated manifest.

```sh
project=/absolute/path/to/clash-verge-rev
harness=/absolute/path/to/clash-verge-rev-harness
cd "$project"
pnpm install --frozen-lockfile
node "$harness/build.mjs" --project "$project" --output target/perf/baseline-build
caffeinate -di node "$harness/run.mjs" --project "$project" --binary target/perf/baseline-build/clash-verge --output target/perf/baseline --repeat 3 --seconds 20 --warmup 10
node "$harness/compare.mjs" target/perf/baseline target/perf/baseline
```

`node build.mjs --project /absolute/product --output target/perf/build` uses release optimization, Vite `--mode perf` and the
explicit Cargo `perf-harness` feature. It preserves the binary and records HEAD,
dirty state, compiled source, lockfile, frontend, build-settings and binary hashes.
Each new build owns fresh, canonical target, intermediate and frontend directories
inside its marked output. A symlinked parent is rejected before directory creation.
Cargo download caches may be shared; compiled artifacts, incremental state and
compiler wrappers are not reused. Both Cargo output routes are explicitly set for metadata resolution as well as
compilation; metadata can otherwise write a shared compiler-information cache.
Compiler wrappers and incremental compilation are disabled. The native host build keeps
Cargo's configured Rust flags. Output-redirecting flags, config includes, custom compiler overrides and configured
cross targets are rejected instead of silently overridden. The supported compiler
is the project-selected standard rustup toolchain; its actual path, version and
binary hash are recorded. The manifest stores exact
arguments/environment and the merged Tauri frontend path, plus a stable recipe
that substitutes only these builder-owned output paths for comparison.

Locked, platform-filtered Cargo metadata resolves reachable local packages,
including transitive path dependencies and path patches. Their canonical roots,
manifest identities and all file contents are hashed before and after compilation,
including ignored inputs. The conventional product Cargo `target` root, actual owned Cargo output directories, this owned output,
`.git` and installed `node_modules` are excluded; a declared output overlapping a
local source root is rejected. Frontend package identity uses the ordinary pnpm
lockfile and the final bundled frontend hash. Tool `target/perf` is a declared
output, not source. Cargo configuration and ancestor workspace manifests are
recorded separately. This does not trace arbitrary external files read by build
scripts or verify a manually altered installed frontend dependency tree. Keep
those inputs controlled; a build-ID string alone never proves the intended native
dependency behavior. Run a small native behavior preflight before a large A/B
matrix. Source, dependency or configuration changes during compilation reject the manifest.
Before/after snapshots retain per-file hashes in the ignored build output even when
that guard fails. Only Tauri's four declared `src-tauri/gen/schemas` outputs
(`acl-manifests.json`, `capabilities.json`, `macOS-schema.json`, `desktop-schema.json`)
are separated from immutable source. Their before/after hashes remain recorded;
all other ignored files in `gen`, including build assets, stay inputs. Symlinked
output files or ancestors are rejected. Official Cargo `build-script-executed`
messages identify the app's private `OUT_DIR`; its consumed ACL/capability hashes
must match the generated copies. The input-identity method participates in build
settings comparison. Keep this checkout stable and exclusive against other Tauri
configuration builds while building; this is not a general concurrent-build lock. Each run hashes the external measurement implementation and records installed
automation package versions. Build manifests fingerprint both repositories,
including dirty, untracked and ignored native inputs; an unborn tool repository
is supported. Dirty candidates need no commit, submodule or dedicated hash lock.
The build manifest separately records native/TS adapter and build-config hashes.
Ordinary package-manager lockfiles remain the dependency source of truth. Ordinary builds exclude the driver and measurement
entry; debug assertions are not the gate. Do not edit compiled inputs during builds.

Output directories must be new and Git ignored; use `target/perf/`. JSON/CSV keep
raw process samples, observations, phase markers, attribution and cleanup evidence.
`summary.json` and `report.md` provide distributions by independent run, phase and
process role. Failed runs exit nonzero and retain their evidence. The explicit
`webview-replay-v9` schema rejects older reports instead of silently migrating them.

## Performance Sample Eligibility

A host-wide `/tmp/cvr-harness-native.lock` lease is acquired before compiling owned
helpers or creating native resources. A second harness command fails immediately,
retains an excluded report and does not stop the owner. The lease stores owner
PID/start, binary and output paths. It is released only after owned native
resources stop. Crashes can leave a stale lease: inspect its owner and recorded
resources manually; the tool never automatically reaps it or signals another
owner. PID reuse may conservatively retain it. This coordinates this runner,
not arbitrary external experiments or builds.

The fixed policy is recorded before observation: 1000 ms polling, a continuous
10000 ms quiet window before each app, a 120000 ms maximum wait and zero automatic
retries. Helper compilation precedes the quiet window. Any observed build process,
whole-host CPU busy above 25%, one-minute load above 0.5 per logical CPU,
non-normal native memory pressure, unavailable observation or observation gap above
1500 ms prevents quiet acceptance. Observer subprocesses have a 1000 ms timeout. The same conditions during startup, warmup,
phases and recovery exclude the entire command and abort its owned app through
normal cleanup. No other process is stopped. These conservative capacity limits
are fixed sample-selection policy, not universal performance thresholds.

Raw cumulative CPU counters, busy percentage, load, pressure and build PID/executable
observations remain in `host-observations.jsonl` and the report, including excluded
attempts. The executable path is read as the final wide `ps` column to avoid macOS truncation.
A separate PID-to-arguments snapshot identifies Node build tools; command arguments
are used only in memory and are not stored. CPU/load/pressure describe the whole
host, including the candidate and shared work; process presence is a distinct
conservative gate and does not establish load strength or causation. Polling cannot
observe every subsecond process. The observer runs during measurement and adds
fixed overhead; its implementation and policy must remain fixed within A/B.

Lifecycle phase completion and cleanup, isolation validity, performance eligibility,
and comparison benefit are separate report fields. Partial phases remain incomplete
when contamination aborts them. An excluded attempt cannot contribute a partial
benefit comparison or be promoted by adapter-review rationale. The comparator
revalidates raw observation counters, quiet windows and measurement coverage.
All attempts remain available; do not choose retries after inspecting benefit.

## Isolation And Visibility

The dedicated measurement main bypasses normal initialization and shutdown. It
does not read or write daily configuration, subscriptions, proxy, TUN or Service.
It uses a distinct app identity and incognito WebView. Both automatic services
bind loopback and are owned by the current run; never kill processes by name.

The measurement window stays above ordinary windows and covers part of the screen,
without activation or mouse capture: clicks pass through to the application behind it.
Native topmost and click-through states are verified, while native focus and application
activation must remain false. WebDriver uses the embedded WebView directly; DOM focus
is recorded but not required. Daily windows are unchanged; the topmost window exits
with its owned measurement instance. You may keep using another application.
The console must be unlocked. Lock state is checked before startup and recorded
at phase boundaries; unknown state fails and observed drift rejects comparison.
Boundary checks do not provide continuous lock monitoring or unlock the computer.

No focus does not mean no visibility: shown stages require `document.hidden=false`,
fresh source data and advancing view output. Traffic additionally requires fresh
Worker data, advancing Canvas draw timestamps and changed Canvas pixels.
Topmost placement avoids ordinary-window occlusion; system overlays or another Space
can still pause WebKit. Such a run fails; do not weaken Canvas assertions to make it
pass. `caffeinate -di` lasts only for the command and cannot prevent deliberate lock.
Hidden stages still require continuous input; traffic also requires Worker data.

## Traffic Workload

The native window is 1000 x 700 logical pixels. Verify driver dimensions against
DPR and record the actual CSS viewport; titlebar space is excluded. The graph is
920 x 360 with a ten-minute range, default bezier style and real data retention.
The measurement preload sets blur pause false without changing production defaults.

Deterministic loopback WebSocket replay enters the public traffic append boundary,
then the production Worker and Canvas. It does not cover Mihomo or network traffic.
There is no history prefill. Absolute 200 ms deadlines sustain 5 Hz without cumulative
timer drift or catch-up bursts; missing a complete period fails the source.
Warmup is at least the requested duration with a five-second readiness allowance.
Fixed input anchors reserve two seconds for each native transition; measured stages
retain their full duration. Readiness uses observable state and deadlines, not sleep.
Before the first show, wait for actual replay input and Worker data so the graph's
visibility listeners are installed; then require fresh Canvas output after showing.
Total replay, including allowances, must remain below ten minutes for raw history.
Two-input endpoint variation is 400 ms; larger differences reject comparison.

Worker snapshots are asynchronous. Count/latest-value checks verify deterministic
upload/download values at the retained point count, with a joint period of 60 and
received-minus-retained count below 60. This detects net missing/duplicate points,
not every historical element or exactly cancelling losses and duplicates.
Source age must be below 2500 ms, Worker age below 3500 ms and visible draw age below
2500 ms. Future timestamps, lost sequence, process changes and failed restore fail.

## Metrics And Comparison

The native command obtains the actual WKWebView process ID using the private
`_webProcessIdentifier` selector, with availability checking. External collection
verifies the canonical system WebContent executable and process start identity.
It handles PID reuse and exits; unsupported ownership fails closed. Main and WebView
remain separate. Mihomo is not started; shared GPU/network attribution is unavailable.

CPU is cumulative process time converted from Mach ticks; interval percentages use
adjacent valid samples, with one occupied core equal to 100%. The first difference
is unavailable. RSS and physical footprint are reported separately in bytes; neither
is exclusive memory ownership. Reports include CPU mean/P50/P95/peak/seconds,
RSS and footprint median/P95/peak/delta, sample count
and time coverage. Memory slope requires at least 60 seconds of continuous samples.
RSS growth is not proof of a leak; process statistics are not function profiles.
The embedded driver adds a 20 Hz macOS runloop timer and observation overhead.

For A/B, build the candidate separately and alternate independent instances:

```sh
node "$harness/build.mjs" --project "$project" --output target/perf/candidate-build
for i in 1 2 3; do
  caffeinate -di node "$harness/run.mjs" --project "$project" --binary target/perf/baseline-build/clash-verge --repeat 1 --output target/perf/ab-baseline/$i
  caffeinate -di node "$harness/run.mjs" --project "$project" --binary target/perf/candidate-build/clash-verge --repeat 1 --output target/perf/ab-candidate/$i
done
node "$harness/compare.mjs" target/perf/ab-baseline target/perf/ab-candidate
node "$harness/run.mjs" --project "$project" --binary target/perf/candidate-build/clash-verge --repeat 1 --seconds 5 --warmup 2 --fail-phase hidden --output target/perf/failed
```

Comparison accepts summary files, run directories or groups of run directories.
Build mode, toolchain, platform, host, power, WebKit, viewport and workload must match.
Invalid, ineligible and incomparable reports exit 2. A/A remains inconclusive. A/B compares
independent-run summaries, not adjacent time samples. An optional third numeric
argument is a percentage floor justified by baseline noise; there is no universal
pass threshold. Fewer than three runs per group, overlapping ranges or differences
within either group's range remain inconclusive. Background load limits inference.

Use bounded WebKit CPU or Allocation/Heap captures for deeper diagnosis; process
counters alone do not identify hotspots or retained allocations.

## Logs and Connections layers

The same optimized native shell and serial runner support three distinct layers:

| Layer | Logs | Connections | Boundary |
| --- | --- | --- | --- |
| `page` | Production Logs page, log subscription/filter/state, descending order | Production Connections page, default table, actual visibility subscription lifecycle | Loopback envelopes enter a JavaScript replacement for the plugin socket API; no native Mihomo plugin or IPC cost is measured |
| `component` | Production VirtualList and LogItem, descending bounded 1000-row fixture | Production VirtualList, row view mapping and ConnectionRowItem, list layout | Fixtures bypass production subscription/state processing |
| `dom` | 20 changing text rows | 20 changing host rows | No React or production components loaded; same Tauri WKWebView shell |

`traffic/component` retains the existing append → Worker → Canvas scenario and its
200 ms source period. That period is unrelated to the deferred Logs refresh-window
change. No production batching, refresh frequency, or IPC behavior is modified.

```sh
node "$harness/build.mjs" --project "$project" --output target/perf/scenes-build
node "$harness/run.mjs" --project "$project" --binary target/perf/scenes-build/clash-verge --scenario logs --layer page --profile steady --output target/perf/logs-page
node "$harness/run.mjs" --project "$project" --binary target/perf/scenes-build/clash-verge --scenario connections --layer component --profile burst --output target/perf/connections-component
node "$harness/run.mjs" --project "$project" --binary target/perf/scenes-build/clash-verge --scenario logs --layer dom --output target/perf/logs-dom
```

Logs steady input is 10 events/s; burst input adds a 200-event burst every tenth
100 ms envelope. Logs have no fixed real-world producer rate; these are named
fixtures, not captured network traces. Connections uses one snapshot/s, 100 active
rows, complete identity turnover every ten snapshots; burst snapshots contain 300
rows every tenth snapshot. These rates are source controls, not UI flush settings.
Every layer receives the same scenario/profile envelopes. Compare within a layer,
layout, profile, and allocator; cross-layer numbers isolate different boundaries
and are not equivalent workload A/B results. The isolated native entry exposes
only measurement state plus empty-log and language/theme configuration fixtures;
unregistered product commands are rejected and no daily configuration is loaded.

The loopback receiver counts source envelopes and rejects sequence gaps. Page
adapter delivery/subscription counts are recorded separately and enforced: Logs
keeps one subscription; Connections has two shown and zero while settled hidden.
Delivery must advance while subscribed and stop during hidden Connections. Hidden Connections
intentionally unsubscribes through its production visibility hook while the
source receiver remains live. Restoring must produce changing visible content.
The existing foreground/hidden/restored measurement is followed by a source-stop
and restart check: input must remain unchanged for 2.1 seconds and at least two
new envelopes plus a content mutation must appear after restart. This checks
source recovery, not unmount cleanup, allocator release, or retained-heap recovery.

Reports use `webview-replay-v9`; old reports are rejected rather than silently
compared. For traffic, `worker`, `draw`, and `pixelsSha256` retain Worker timestamp,
Canvas draw timestamp, and Canvas pixel meanings. For Logs/Connections those
legacy field names respectively contain receiver timestamp, DOM mutation
timestamp, and a visible-root **text hash**. DOM mutation/text changes establish
that rendering inputs reached the view; they do not prove painting, layout cost,
or WebKit cache ownership. The pure DOM tier isolates engine work but does not
reproduce the complete application. Native visibility, nonactivation, active
Space, occlusion, process identity, and source freshness remain acceptance gates.
The fixed asynchronous observation script uses absolute one-second sampling slots;
early timer wakeups wait for the scheduled deadline, missed slots fail instead of
creating catch-up bursts, and phases retain their full requested duration.
Transition/readiness checks use faster polling outside measurement windows.

RSS and physical footprint are separate metrics for main and owned WebContent
processes. Reports include source/dependency/frontend/binary hashes, WebKit bundle
version, user agent, and process executable attribution. The runner supports the
system WebKit only and rejects inherited DYLD/allocator overrides. Default runs
use `--allocator default`; `--allocator diagnostic-malloc` sets `Malloc=1` and
`__XPC_Malloc=1` on owned processes. This diagnostic mode changes allocation policy
and is incomparable with default-mode measurements. It is not a production fix.
Run comparisons serially; multiple concurrent instances are diagnostic only and
are not supported by the comparative runner.

## Owned artifact cleanup

`--project` is mandatory and absolute for build, run and cleanup. Relative binary
and output arguments resolve against that checkout, independently of the caller’s
working directory. Build and run outputs must be **new** directories below its ignored
`target/perf`. They carry a checkout/path ownership marker. No dependency install,
worktree dependency linking, Core, Service, TUN, DNS, or system-proxy operations
are involved. Build inputs remain in the checkout.

```sh
node "$harness/clean.mjs" --project "$project" target/perf/logs-page target/perf/connections-component
```

Cleanup accepts exact marked directories only, refuses symlinked paths, and
refuses dependency symlinks into the directory, and refuses live owner/recorded
application or WebContent PIDs (including PID reuse,
which requires manual inspection). It does not remove unmarked historical artifacts or unrelated shared caches and
outputs. An active native measurement also leases its build directory; cleanup
refuses that directory while the lease owner is live.
Native runs terminate only the owned application after PID/start verification;
failed cleanup invalidates a run. `--fail-phase hidden` exercises failure cleanup.

## Adapter changes and tool checks

Keep the tool implementation, workload, inputs and observation settings fixed
within A/B. Repeat affected measurements when these change. Product adapters may
evolve alongside product API changes; matching interfaces alone do not establish
measurement equivalence. The comparator rejects differing adapter hashes by
default. Inspect the actual adapter source diff (including native entry,
initialization and Vite/Tauri configuration), then explicitly record why it preserves
the measurement meaning:

```sh
node "$harness/compare.mjs" "$project/target/perf/baseline" "$project/target/perf/candidate" --adapter-review 'Reviewed <source diff>: <evidence that scene, input, visibility and observation semantics remain equivalent>'
```

The result lists changed adapter paths and that review rationale. This option
only acknowledges adapter differences; every other validity and comparability
condition still applies. A changed tool hash remains incomparable.

```sh
cd "$harness"
CVR_PROJECT="$project" "$project/node_modules/.bin/eslint" --config eslint.config.mjs '*.mjs'
"$project/node_modules/.bin/biome" format --config-path "$project/biome.json" *.mjs package.json
node --test report.test.mjs
cd "$project"
pnpm exec tsc -p scripts/perf/tsconfig.json --noEmit
pnpm exec tsc -p scripts/perf/tsconfig.node.json --noEmit
```

Normal product builds never discover or import this external tool. Explicit paths
are the local integration contract; there is no remote, submodule or historical
adapter discovery mechanism.

## Optional virtual display

The default `--display physical` preserves the existing window behavior. Use
`--display virtual` to let this command compile and own a short-lived macOS
CGVirtualDisplay helper, with no driver install, global defaults or login item:

```sh
caffeinate -di node "$harness/run.mjs" --project "$project" --binary target/perf/build/clash-verge --display virtual --output target/perf/virtual-smoke --repeat 1 --seconds 5 --warmup 2 --capture-smoke
```

The helper uses a private macOS API and fails when unavailable. It creates a new
1280×900 logical / 2560×1800 pixel display at DPR 2 and 60 Hz outside all existing
screens, checks that every pre-existing screen is unchanged, and places only the
hidden measurement window inside its AppKit visibleFrame before showing it. The
owned window joins all Spaces with MoveToActiveSpace cleared; no user window or
Space is moved. Native samples keep exact screen identity, full-frame containment,
mode, DPR, refresh, visibility, nonactivation and click-through checks. No new
transport, workload or product behavior is enabled by this option.

One helper is held for the command's serial independent app runs. The runner
verifies helper PID/start/executable/hash before creating or observing an app.
Shutdown closes the owned app, WebContent and driver before exiting the helper;
if native cleanup cannot be proven, the command records failure, starts no more
apps and retains its helper while waiting for the owned native resources to stop.
Inspect the saved cleanup evidence in this rare wait state; collector errors on a
live PID do not count as an exit. A separate helper process then enumerates screens to verify that its display is
gone and all original topology fields are restored. Raw creation, process identity
and cleanup evidence stays with the report. Cleanup refuses a live helper PID.

Physical and virtual reports are incomparable. Virtual A/A compares stable display
parameters while validating each report's own dynamic display ID and helper
identity; different IDs alone do not change the workload. `--capture-smoke` takes
one owned WebView screenshot before warmup/timed samples, never the user desktop.
It proves rendered WebView content, not physical scanout or every composed frame.

If the helper disappears unexpectedly, native move/scale callbacks and subsequent
observations hide and terminate the owned app rather than falling back to the main
screen. This is reactive protection: the OS may briefly migrate a visible window
before callbacks run. Validation uses safe missing-screen startup rejection; it
does not deliberately remove a display beneath a visible window.

## Command Isolation Snapshots

Each run command automatically records read-only snapshots before creating its
helper or application and after all owned cleanup, outside warmup and measured
phases. `scripts/perf/isolation.json` in the product checkout owns the watched
configuration roots, file extensions, profile directories and process names. The
tool stores file paths, SHA-256, size and modification time, never configuration
contents or proxy/DNS values. Proxy and DNS are hashed. Missing configuration
roots are recorded as absent; denied or inconsistent reads are unavailable.

Watched process snapshots contain executable paths, PID and `ps` start time in
UTC with second resolution. This metadata is not authority to signal a process;
owned application/helper shutdown keeps its existing Mach start identity checks.

The command's first snapshot is its baseline. `priorBaseline: not-assessed` means
there is no earlier reference; a before/after pair cannot establish when a
pre-existing change occurred. Changed or incomplete snapshots invalidate the
report and exit nonzero. Stable reports with different watched baselines are
incomparable. The snapshots provide boundary observations, not continuous
monitoring or attribution to a writer. They never restore configuration or
change the daily application, Core, Service, proxy, DNS or TUN.
