import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { homedir } from 'node:os'
import { test } from 'node:test'

import {
  compare,
  delta,
  phases,
  roles,
  quantile,
  summarize,
  validWorkload,
  replayValues,
  SCHEMA,
  validVisibility,
} from './report.mjs'
import {
  buildProcesses,
  hostPolicy,
  hostReasons,
  validEligibility,
} from './host.mjs'
import {
  captureBuildInputs,
  captureGeneratedOutputs,
  rootBuildOutput,
} from './build-inputs.mjs'
import { workload } from './workload.mjs'
import { hash, gitHead } from './project.mjs'
import {
  captureIsolation,
  isolationBaseline,
  isolationMethod,
  isolationResult,
} from './isolation.mjs'
import {
  validDisplayOwner,
  validDisplayObservation,
  virtualDisplayContract,
} from './display.mjs'

const latest = (sequence) => {
  const { up, down } = replayValues(sequence)
  return { lastUp: up, lastDown: down }
}
const observation = (phase, now) => ({
  phase,
  now,
  displayMode: 'physical',
  virtualScreen: null,
  expectedDisplayID: null,
  source: now - 100,
  worker: now - 100,
  draw: now - 100,
  visible: phase !== 'hidden',
  hidden: phase === 'hidden',
  focused: false,
  nativeFocused: false,
  appActive: false,
  top: true,
  clickThrough: true,
  occluded: false,
  activeSpace: true,
})
const rows = phases.flatMap((phase, phaseIndex) =>
  roles.flatMap((role) =>
    Array.from({ length: 5 }, (_, i) => ({
      phase,
      role,
      pid: role === 'main' ? 1 : 2,
      start: '1',
      time: (phaseIndex * 5 + i) * 1000,
      cpu: (phaseIndex * 5 + i) / 10,
      rss: 100 + i,
      footprint: 80 + i,
    })),
  ),
)
const run = {
  ok: true,
  hostStarted: 11001,
  hostEnded: 30000,
  samples: rows.map((sample) => ({ ...sample, time: sample.time + 12000 })),
  cleanup: { mainExited: true, driverClosed: true, webviewExited: true },
  replay: { sent: 130, maxLateMs: 10 },
  actualWarmupMs: 3000,
  observations: phases.map((phase, i) => ({
    ...observation(phase, 2000 + i * 10000),
    received: 35 + i * 35,
    points: 34 + i * 35,
    gaps: 0,
    ...latest(34 + i * 35),
  })),
  marks: [
    { name: 'ready', time: 1 },
    ...phases.flatMap((name, i) => [
      {
        name,
        target: 35 + i * 35,
        deadlineIndex: 35 + i * 35,
        senderSent: 35 + i * 35,
        received: 35 + i * 35,
        points: 34 + i * 35,
        ...latest(34 + i * 35),
        gaps: 0,
        time: 1000 + i * 10000,
        ...observation(name, 1000 + i * 10000),
        pixelsSha256: 'a'.repeat(64),
      },
      {
        name: `${name}:end`,
        deadlineIndex: 60 + i * 35,
        senderSent: 60 + i * 35,
        received: 60 + i * 35,
        points: 59 + i * 35,
        ...latest(59 + i * 35),
        gaps: 0,
        time: 6000 + i * 10000,
        ...observation(name, 6000 + i * 10000),
        pixelsSha256: 'b'.repeat(64),
      },
    ]),
  ],
}
run.consoleStates = run.marks.map((m, i) => ({
  name: i ? m.name : 'initial',
  time: m.time,
  locked: false,
}))
const isolationSnapshot = {
  at: 1,
  configuration: {
    value: { roots: [{ path: 'fixture', exists: false }], files: [] },
  },
  processes: { value: [] },
  proxy: { value: 'a'.repeat(64) },
  dns: { value: 'b'.repeat(64) },
}
const baseline = {
  schema: SCHEMA,
  lifecycle: { status: 'complete' },
  measurementLeaseReleased: true,
  eligibility: {
    policy: hostPolicy,
    status: 'eligible',
    reasons: [],
    windows: Array.from({ length: 3 }, (_, i) => ({
      started: i * 50000,
      quietStarted: 1000 + i * 50000,
      ended: 11000 + i * 50000,
      accepted: true,
    })),
    observations: Array.from({ length: 131 }, (_, i) => ({
      time: i * 1000,
      stage: i % 50 <= 11 ? 'quiet' : i % 50 <= 30 ? 'measurement' : 'cleanup',
      logicalCpus: 1,
      cpuCounters: [{ user: i * 10, nice: 0, sys: 0, idle: i * 90, irq: 0 }],
      cpuBusyPercent: i ? 10 : null,
      load1: 0.1,
      memoryPressure: 1,
      buildProcesses: [],
    })),
  },
  isolation: {
    before: isolationSnapshot,
    after: structuredClone(isolationSnapshot),
    result: isolationResult(isolationSnapshot, isolationSnapshot),
  },
  harnessSha256: 'fixture-harness',
  build: {
    identityVersion: 2,
    buildInputs: {
      before: { sha256: 'inputs', packages: ['fixture'] },
      after: { sha256: 'inputs' },
    },
    head: 'fixture-head',
    adapterFiles: { 'app.rs': 'fixture-native' },
    adapterSha256: hash(JSON.stringify({ 'app.rs': 'fixture-native' })),
    dirty: '',
    sourceSha256: 'fixture-source',
    dependencySha256: 'fixture-dependencies',
    binarySha256: 'same',
    frontendSha256: 'fixture-assets',
    buildSettingsSha256: 'fixture-settings',
    mode: 'release',
    buildCommand: 'fixture-build',
    binary: '/fixture/app',
    toolchain: 'fixture-tools',
    buildEnvironment: {},
  },
  contract: {
    ...workload('traffic', 'component'),
    display: { mode: 'physical' },
    isolation: {
      method: isolationMethod,
      policySha256: 'c'.repeat(64),
      baselineSha256: isolationBaseline(isolationSnapshot),
    },
    allocator: 'default',
    replayMs: 200,
    consoleLocked: false,
    windowPolicy: 'nonactivating-top-click-through-v1',
    seconds: 5,
    warmup: 2,
    phaseTargets: [35, 70, 105],
    transitionSeconds: 2,
    readinessAllowanceSeconds: 5,
    intervalMs: 1000,
    samplingSchedule: 'absolute-one-second-slots-v1',
    rangeMinutes: 10,
    window: [1000, 700],
    viewport: [1000, 668, 2],
    method: 'fixture-method',
    mode: 'release',
    toolchain: 'fixture-tools',
    buildSettingsSha256: 'fixture-settings',
    platform: 'macOS',
    machine: 'fixture-model',
    arch: 'arm64',
    host: 'fixture-host',
    hardware: 'fixture-hardware',
    power: 'fixture-power',
    powerSource: 'AC',
    webkit: 'fixture-webkit',
    replay: 'fixture-5Hz',
    automation: 'fixture-wdio',
    buildEnvironment: {},
  },
  runs: Array.from({ length: 3 }, (_, i) => ({
    ...run,
    hostStarted: run.hostStarted + i * 50000,
    hostEnded: run.hostEnded + i * 50000,
    samples: run.samples.map((sample) => ({
      ...sample,
      time: sample.time + i * 50000,
    })),
  })),
}
test('quantiles, CPU units, first observation and PID reuse', () => {
  assert.equal(quantile([0, 10, 20], 0.95), 19)
  assert.equal(delta(undefined, rows[0]), null)
  assert.equal(delta(rows[0], rows[1]), 10)
  assert.equal(delta(rows[0], { ...rows[1], start: '2' }), null)
  assert.equal(delta(rows[0], { ...rows[1], time: NaN }), null)
  assert.equal(summarize(rows, 5)['hidden/main'].cpuMean, 10)
  assert.equal(summarize([], 5)['hidden/main'].cpuSeconds, null)
})
test('report schema: A/A, failed, incomparable and corrupt samples', () => {
  assert.equal(compare(baseline, baseline).kind, 'A/A')
  assert.equal(
    compare(baseline, { ...baseline, schema: 'old' }).verdict,
    'invalid',
  )
  for (const change of [
    { appActive: true },
    { nativeFocused: true },
    { top: false },
    { top: undefined },
    { clickThrough: false },
    { clickThrough: undefined },
    { hidden: true },
    { worker: 3000 },
    { now: 6000 },
    { draw: 3000 },
    { worker: null },
  ]) {
    const invalid = structuredClone(baseline)
    Object.assign(invalid.runs[0].observations[0], change)
    assert.equal(compare(baseline, invalid).verdict, 'invalid')
  }
  for (const key of ['draw', 'pixelsSha256']) {
    const stalled = structuredClone(baseline)
    stalled.runs[0].marks[2][key] = stalled.runs[0].marks[1][key]
    assert.equal(compare(baseline, stalled).verdict, 'invalid')
  }
  const missingPhase = structuredClone(baseline)
  missingPhase.runs[0].observations.pop()
  assert.equal(compare(baseline, missingPhase).verdict, 'invalid')
  const consoleDrift = structuredClone(baseline)
  consoleDrift.runs[0].consoleStates[3].locked = true
  assert.equal(compare(baseline, consoleDrift).verdict, 'incomparable')
  consoleDrift.runs[0].consoleStates[3].locked = null
  assert.equal(compare(baseline, consoleDrift).verdict, 'invalid')
  assert.equal(
    validVisibility({ phase: 'restored', visible: true, hidden: true }),
    false,
  )
  const missedPeriod = structuredClone(baseline)
  missedPeriod.runs[0].replay.maxLateMs = 200
  assert.equal(compare(baseline, missedPeriod).verdict, 'invalid')
  const delayed = {
    received: 100,
    points: 97,
    gaps: 0,
    lastUp: 270000,
    lastDown: 640000,
  }
  assert.equal(validWorkload(delayed), true)
  assert.equal(validWorkload(null), false)
  assert.equal(validWorkload({ ...delayed, points: 96 }), false)
  assert.equal(validWorkload({ ...delayed, points: 98 }), false)
  assert.equal(validWorkload({ ...delayed, received: 157 }), false)
  assert.equal(validWorkload({ ...delayed, lastDown: 660000 }), false)
  const missedAnchor = structuredClone(baseline)
  missedAnchor.runs[0].marks[1].received++
  assert.equal(compare(baseline, missedAnchor).verdict, 'invalid')
  const droppedInputs = structuredClone(baseline)
  const end = droppedInputs.runs[0].marks[2]
  end.received -= 10
  end.points -= 10
  Object.assign(end, latest(end.points))
  assert.equal(compare(droppedInputs, droppedInputs).verdict, 'invalid')
  const workerLag = structuredClone(baseline)
  workerLag.runs[0].observations[0].points -= 3
  assert.equal(compare(baseline, workerLag).verdict, 'invalid')
  const inputDrift = structuredClone(baseline)
  inputDrift.runs = baseline.runs.map((r) => structuredClone(r))
  inputDrift.runs[0].marks[2].received += 3
  inputDrift.runs[0].marks[2].points += 3
  inputDrift.runs[0].marks[2].deadlineIndex += 3
  inputDrift.runs[0].marks[2].senderSent += 3
  Object.assign(
    inputDrift.runs[0].marks[2],
    latest(inputDrift.runs[0].marks[2].points),
  )
  assert.equal(compare(baseline, inputDrift).verdict, 'incomparable')
  const snapshotPhase = structuredClone(baseline)
  snapshotPhase.runs[0].marks[2].points++
  Object.assign(
    snapshotPhase.runs[0].marks[2],
    latest(snapshotPhase.runs[0].marks[2].points),
  )
  assert.equal(compare(baseline, snapshotPhase).kind, 'A/A')
  const changedSettings = structuredClone(baseline)
  changedSettings.build.buildSettingsSha256 =
    changedSettings.contract.buildSettingsSha256 = 'changed-settings'
  assert.equal(compare(baseline, changedSettings).verdict, 'incomparable')
  assert.equal(
    compare(baseline, { ...baseline, harnessSha256: 'changed' }).verdict,
    'incomparable',
  )
  assert.equal(
    compare(baseline, {
      ...baseline,
      contract: { ...baseline.contract, seconds: 6 },
    }).verdict,
    'incomparable',
  )
  assert.equal(
    compare(baseline, { ...baseline, runs: [{ ...run, ok: false }] }).verdict,
    'invalid',
  )
  const corrupt = structuredClone(baseline)
  corrupt.runs[0].samples[1].time = 0
  assert.equal(compare(baseline, corrupt).verdict, 'invalid')
  const shifted = structuredClone(baseline)
  shifted.runs[0].samples
    .filter((s) => s.phase === 'hidden')
    .forEach((s) => {
      s.time -= 5000
    })
  assert.equal(compare(baseline, shifted).verdict, 'invalid')
  const badMarks = structuredClone(baseline)
  badMarks.runs[0].marks.forEach((m) => {
    m.time = -1
  })
  assert.equal(compare(baseline, badMarks).verdict, 'invalid')
  const clustered = structuredClone(baseline)
  clustered.runs[0].samples.forEach((s) => {
    s.time /= 1000
  })
  assert.equal(compare(baseline, clustered).verdict, 'invalid')
  for (const [section, key] of [
    ['contract', 'platform'],
    ['contract', 'samplingSchedule'],
    ['build', 'sourceSha256'],
  ]) {
    const missing = structuredClone(baseline)
    delete missing[section][key]
    assert.equal(compare(missing, missing).verdict, 'invalid')
  }
  assert.equal(
    compare(baseline, {
      ...baseline,
      contract: { ...baseline.contract, platform: 'other-macOS' },
    }).verdict,
    'incomparable',
  )
  for (const malformed of [
    null,
    {},
    { runs: [null] },
    { ...baseline, runs: [{ ...run, samples: null }] },
  ])
    assert.equal(compare(baseline, malformed).verdict, 'invalid')
  const noisy = structuredClone(baseline)
  noisy.runs = baseline.runs.map((r) => structuredClone(r))
  noisy.build.binarySha256 = 'different'
  noisy.runs.forEach((r, i) =>
    r.samples.forEach((s) => {
      s.cpu *= [0.1, 0.2, 10][i]
    }),
  )
  assert.equal(
    compare(baseline, noisy, 5).metrics['foreground/webview/cpuMean'].verdict,
    'inconclusive',
  )
})
test('macOS collector agrees with process.cpuUsage on a busy owned process', {
  skip: process.platform !== 'darwin',
}, () => {
  mkdirSync('target/perf', { recursive: true })
  execFileSync('cc', [
    '-Wall',
    '-Wextra',
    '-Werror',
    new URL('./sample.c', import.meta.url).pathname,
    '-o',
    'target/perf/test-sample',
  ])
  const sample = () =>
    Number(
      execFileSync('target/perf/test-sample', [String(process.pid)], {
        encoding: 'utf8',
      }).split(' ')[2],
    )
  const first = sample(),
    cpu = process.cpuUsage(),
    start = performance.now()
  while (performance.now() - start < 500) Math.sqrt(Math.random())
  const used = process.cpuUsage(cpu),
    measured = sample() - first
  assert.ok(Math.abs(measured - (used.user + used.system) / 1e6) < 0.05)
})

test('adapter changes require an explicit equivalence review', () => {
  const changed = structuredClone(baseline)
  changed.build.adapterFiles['app.rs'] = 'changed-native'
  changed.build.adapterSha256 = hash(JSON.stringify(changed.build.adapterFiles))
  assert.equal(compare(baseline, changed).verdict, 'incomparable')
  assert.equal(
    compare(
      baseline,
      changed,
      null,
      'Reviewed app.rs: same scene and visibility policy',
    ).kind,
    'A/A',
  )
  changed.contract.seconds = 6
  assert.equal(
    compare(
      baseline,
      changed,
      null,
      'Reviewed app.rs: same scene and visibility policy',
    ).verdict,
    'incomparable',
  )
})

test('virtual display ownership, complete containment and environment comparison', () => {
  const physical = {
    id: 1,
    bounds: [0, 0, 2560, 1440],
    frame: [0, 0, 2560, 1440],
    visibleFrame: [0, 0, 2560, 1410],
    main: true,
    mirrored: false,
    online: true,
    logical: [2560, 1440],
    pixels: [5120, 2880],
    scale: 2,
    refreshHz: 60,
  }
  const screen = {
    id: 99,
    bounds: [2560, 0, 1280, 900],
    frame: [2560, 540, 1280, 900],
    visibleFrame: [2560, 540, 1280, 870],
    main: false,
    mirrored: false,
    online: true,
    scale: 2,
    refreshHz: 60,
    logical: [1280, 900],
    pixels: [2560, 1800],
  }
  const owner = {
    valid: true,
    nonoverlap: true,
    displayID: 99,
    pid: 10,
    start: '123',
    executable: '/owned/helper',
    executableSha256: 'a'.repeat(64),
    before: [physical],
    during: [physical, screen],
  }
  assert.equal(validDisplayOwner(owner), true)
  const missingTopology = structuredClone(owner)
  delete missingTopology.before[0].visibleFrame
  assert.equal(validDisplayOwner(missingTopology), false)
  assert.equal(validDisplayOwner({ ...owner, displayID: 1 }), false)
  assert.equal(
    validDisplayOwner({
      ...owner,
      during: [{ ...physical, main: false }, screen],
    }),
    false,
  )
  const virtual = structuredClone(baseline)
  virtual.contract.display = virtualDisplayContract
  virtual.displayOwner = owner
  virtual.displayCleanup = {
    helperExited: true,
    exitedBeforeRequest: false,
    topologyRestored: true,
    before: owner.before,
    after: owner.before,
  }
  for (const s of [
    ...virtual.runs.flatMap((r) => r.observations),
    ...virtual.runs.flatMap((r) => r.marks.slice(1)),
  ]) {
    s.displayMode = 'virtual'
    s.expectedDisplayID = 99
    s.expectedDisplayFrame = screen.frame
    s.virtualScreen = {
      ...screen,
      windowFrame: [2700, 611, 1000, 728],
      collectionBehavior: 1,
      contained: true,
    }
  }
  assert.equal(compare(virtual, virtual).kind, 'A/A')
  assert.equal(compare(baseline, virtual).verdict, 'incomparable')
  const otherID = structuredClone(virtual)
  otherID.displayOwner.displayID = 100
  otherID.displayOwner.during[1].id = 100
  for (const s of [
    ...otherID.runs.flatMap((r) => r.observations),
    ...otherID.runs.flatMap((r) => r.marks.slice(1)),
  ]) {
    s.expectedDisplayID = 100
    s.virtualScreen.id = 100
  }
  assert.equal(compare(virtual, otherID).kind, 'A/A')
  assert.equal(compare([virtual, otherID], [virtual, otherID]).kind, 'A/A')
  const directory = mkdtempSync('/tmp/cvr-display-group-')
  try {
    for (const [name, report] of [
      ['first', virtual],
      ['second', otherID],
    ]) {
      mkdirSync(join(directory, name))
      writeFileSync(
        join(directory, name, 'summary.json'),
        JSON.stringify(report),
      )
    }
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          new URL('./compare.mjs', import.meta.url).pathname,
          directory,
          directory,
        ],
        { encoding: 'utf8' },
      ),
    )
    assert.equal(result.kind, 'A/A')
    otherID.runs[0].observations[0].virtualScreen.id = 999
    assert.equal(
      compare([virtual, otherID], [virtual, otherID]).verdict,
      'invalid',
    )
  } finally {
    rmSync(directory, { recursive: true })
  }
  const observation = virtual.runs[0].observations[0]
  for (const change of [
    null,
    { ...observation.virtualScreen, id: 1 },
    { ...observation.virtualScreen, windowFrame: [2700, 611, 2000, 728] },
    { ...observation.virtualScreen, scale: 1 },
    { ...observation.virtualScreen, refreshHz: 59 },
    { ...observation.virtualScreen, collectionBehavior: 3 },
    { ...observation.virtualScreen, collectionBehavior: 0 },
  ]) {
    assert.equal(
      validDisplayObservation({ ...observation, virtualScreen: change }),
      false,
    )
  }
  const missing = structuredClone(virtual)
  delete missing.displayOwner
  assert.equal(compare(missing, missing).verdict, 'invalid')
  const failed = structuredClone(virtual)
  failed.displayCleanup.topologyRestored = false
  assert.equal(compare(failed, failed).verdict, 'invalid')
  const earlyExit = structuredClone(virtual)
  earlyExit.displayCleanup.exitedBeforeRequest = true
  assert.equal(compare(earlyExit, earlyExit).verdict, 'invalid')
})

test('command isolation rejects drift, unavailable snapshots and differing baselines', () => {
  const changed = structuredClone(baseline)
  changed.isolation.after.dns.value = 'd'.repeat(64)
  changed.isolation.result = isolationResult(
    changed.isolation.before,
    changed.isolation.after,
  )
  assert.equal(changed.isolation.result.status, 'changed')
  assert.equal(compare(changed, changed).verdict, 'invalid')
  const unknown = structuredClone(baseline)
  unknown.isolation.after.processes = { error: 'EACCES' }
  unknown.isolation.result = isolationResult(
    unknown.isolation.before,
    unknown.isolation.after,
  )
  assert.equal(unknown.isolation.result.status, 'unavailable')
  assert.equal(compare(unknown, unknown).verdict, 'invalid')
  const other = structuredClone(baseline)
  other.isolation.before.proxy.value = other.isolation.after.proxy.value =
    'd'.repeat(64)
  other.isolation.result = isolationResult(
    other.isolation.before,
    other.isolation.after,
  )
  other.contract.isolation.baselineSha256 = isolationBaseline(
    other.isolation.before,
  )
  assert.equal(compare(baseline, other).verdict, 'incomparable')
  const malformed = structuredClone(baseline)
  malformed.isolation.before.configuration.value = null
  assert.equal(compare(malformed, malformed).verdict, 'invalid')
})

test('isolation captures configuration metadata without copying contents', () => {
  const directory = mkdtempSync('/tmp/cvr-isolation-')
  try {
    const secret = 'https://fixture.invalid/private-token'
    writeFileSync(join(directory, 'config.yaml'), secret)
    const policy = {
      configRoots: [relative(homedir(), directory)],
      configDirectories: ['profiles'],
      configExtensions: ['.yaml'],
      processNames: {},
    }
    const before = captureIsolation(policy)
    assert.notEqual(isolationBaseline(before), null)
    assert.equal(JSON.stringify(before).includes(secret), false)
    assert.equal(before.configuration.value.files[0].sha256, hash(secret))
    const same = captureIsolation(policy)
    assert.equal(isolationResult(before, same).status, 'unchanged')
    writeFileSync(join(directory, 'config.yaml'), 'changed')
    const after = captureIsolation(policy)
    assert.equal(isolationResult(before, after).status, 'changed')
    assert.ok(isolationResult(before, after).changed.includes('configuration'))
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('unborn Git HEAD is explicit and real Git errors propagate', () => {
  const directory = mkdtempSync('/tmp/cvr-unborn-')
  try {
    assert.throws(() => gitHead(directory))
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', directory])
    assert.equal(gitHead(directory), null)
    writeFileSync(join(directory, '.git', 'HEAD'), 'not a valid HEAD')
    assert.throws(() => gitHead(directory))
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('host eligibility separates observed builds, whole-host load and excluded samples', () => {
  assert.equal(validEligibility(baseline), true)
  const quiet = baseline.eligibility.observations[12]
  assert.deepEqual(
    hostReasons(quiet, baseline.eligibility.observations[11]),
    [],
  )
  assert.deepEqual(
    hostReasons({
      ...quiet,
      buildProcesses: [{ pid: 99, executable: '/toolchain/cargo' }],
    }),
    ['build-process-presence'],
  )
  assert.deepEqual(hostReasons({ ...quiet, cpuBusyPercent: 30 }), [
    'whole-host-cpu-capacity',
  ])
  assert.deepEqual(hostReasons({ ...quiet, load1: 0.6 }), [
    'whole-host-load-capacity',
  ])
  assert.deepEqual(hostReasons({ ...quiet, memoryPressure: 2 }), [
    'whole-host-memory-pressure',
  ])
  for (const edit of [
    (x) => {
      x.eligibility.observations[12].buildProcesses.push({
        pid: 99,
        executable: '/cargo',
      })
    },
    (x) => {
      x.eligibility.observations[12].cpuBusyPercent = 5
    },
    (x) => {
      x.eligibility.observations[5].stage = 'cleanup'
      x.eligibility.observations[5].buildProcesses.push({
        pid: 99,
        executable: '/cargo',
      })
    },
    (x) => {
      x.eligibility.observations[20].stage = 'cleanup'
      x.eligibility.observations[20].buildProcesses.push({
        pid: 99,
        executable: '/cargo',
      })
    },
    (x) => {
      x.eligibility.observations.splice(12, 2)
    },
    (x) => {
      x.eligibility.windows[0].quietStarted = 2000
    },
    (x) => {
      x.runs[0].hostEnded += 2000
    },
  ]) {
    const changed = structuredClone(baseline)
    edit(changed)
    assert.equal(validEligibility(changed), false)
    assert.equal(compare(baseline, changed).verdict, 'invalid')
  }
  const excluded = structuredClone(baseline)
  excluded.eligibility.status = 'excluded'
  excluded.eligibility.reasons = ['build-process-presence']
  assert.equal(compare(baseline, excluded).verdict, 'ineligible')
  assert.equal(compare([baseline, excluded], baseline).verdict, 'ineligible')
  assert.equal(
    compare(baseline, { ...baseline, eligibility: null }).verdict,
    'invalid',
  )
})

test('host process detector reads untruncated final executable paths and joins Node arguments by PID', () => {
  const cargo = '/private/tmp/cvr-harness-p0-load-ChPCek/cargo'
  const node = '/Applications/Tool Box/node'
  assert.deepEqual(
    buildProcesses(
      ` 8673 ${cargo}\n 44 ${node}\n 45 /usr/bin/node\n`,
      ` 8673 ${cargo} 60\n 44 ${node} /project/node_modules/vite/bin/vite.js build\n 45 node application.mjs\n`,
    ),
    [
      { pid: 8673, executable: cargo },
      { pid: 44, executable: node },
    ],
  )
  assert.equal(
    compare(baseline, { ...baseline, schema: 'webview-replay-v8' }).verdict,
    'invalid',
  )
})

test('build identity separates exact generated outputs from ignored source and selects Cargo root OUT_DIR', () => {
  const root = realpathSync(mkdtempSync('/tmp/cvr-harness-generated-'))
  try {
    const schemaRoot = join(root, 'gen/schemas')
    mkdirSync(schemaRoot, { recursive: true })
    const generated = [
      'acl-manifests.json',
      'capabilities.json',
      'macOS-schema.json',
      'desktop-schema.json',
    ].map((name) => join(schemaRoot, name))
    for (const path of generated) writeFileSync(path, 'old generated output')
    writeFileSync(join(root, '.gitignore'), 'gen/\n')
    writeFileSync(
      join(root, 'Cargo.toml'),
      '[package]\nname="candidate"\nversion="0.1.0"\n',
    )
    const ignoredSource = join(schemaRoot, 'consumed.bin')
    writeFileSync(ignoredSource, 'real input')
    const pkg = {
      id: 'candidate-id',
      name: 'candidate',
      version: '0.1.0',
      manifest_path: join(root, 'Cargo.toml'),
      source: null,
    }
    const graph = {
      local: [pkg],
      metadata: {
        packages: [pkg],
        target_directory: join(root, 'target'),
        build_directory: join(root, 'target'),
      },
    }
    const capture = () =>
      captureBuildInputs(
        root,
        graph,
        join(root, 'target/perf/fixture'),
        generated,
      )
    const before = capture(),
      outputBefore = captureGeneratedOutputs(generated)
    writeFileSync(generated[0], 'new generated output')
    assert.equal(capture().sha256, before.sha256)
    assert.notEqual(
      captureGeneratedOutputs(generated)[0].sha256,
      outputBefore[0].sha256,
    )
    assert.equal(
      before.inputs[0].entries['gen/schemas/consumed.bin'],
      hash('real input'),
    )
    assert.equal(
      before.inputs[0].entries['gen/schemas/acl-manifests.json'],
      undefined,
    )
    writeFileSync(ignoredSource, 'changed real input')
    assert.notEqual(capture().sha256, before.sha256)
    assert.throws(
      () =>
        captureBuildInputs(
          root,
          { ...graph, metadata: { ...graph.metadata, target_directory: root } },
          join(root, 'target/perf/fixture'),
          generated,
        ),
      /overlaps a local source/,
    )
    rmSync(generated[0])
    symlinkSync(join(root, 'missing-shared-file'), generated[0])
    assert.throws(
      () => captureGeneratedOutputs(generated),
      /Symlinked generated output/,
    )
    rmSync(generated[0])
    rmSync(join(root, 'gen'), { recursive: true })
    mkdirSync(join(root, 'shared-schemas'))
    symlinkSync(join(root, 'shared-schemas'), join(root, 'gen'))
    assert.throws(
      () => captureGeneratedOutputs(generated),
      /Symlinked generated output/,
    )
    const execution = {
      buildScriptOutputs: [
        { packageId: 'dependency-id', outDir: '/dependency' },
        { packageId: pkg.id, outDir: '/owned/root-output' },
      ],
    }
    assert.equal(rootBuildOutput(execution, pkg.id), '/owned/root-output')
    assert.throws(
      () => rootBuildOutput(execution, 'missing'),
      /Expected one root/,
    )
    assert.throws(
      () =>
        rootBuildOutput(
          {
            buildScriptOutputs: [
              ...execution.buildScriptOutputs,
              execution.buildScriptOutputs[1],
            ],
          },
          pkg.id,
        ),
      /Expected one root/,
    )
  } finally {
    rmSync(root, { recursive: true })
  }
})
