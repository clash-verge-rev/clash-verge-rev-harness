import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { basename, isAbsolute, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual, promisify } from 'node:util'

const execute = promisify(execFile)
const lock = '/tmp/cvr-harness-native.lock'
export const hostPolicy = Object.freeze({
  method: 'whole-host-capacity-and-build-presence-v2',
  processDetector:
    'ps-wide-final-executable-column-and-pid-joined-node-args-v1',
  pollMs: 1000,
  observerTimeoutMs: 1000,
  quietMs: 10000,
  maxWaitMs: 120000,
  maxGapMs: 1500,
  maxCpuBusyPercent: 25,
  maxLoad1PerCpu: 0.5,
  memoryPressure: 1,
  automaticRetries: 0,
  contamination: 'exclude-command-and-abort-owned-run',
  buildPresence: 'cargo/rustc/C-and-linker/make/ninja/node-build-tools',
})
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
export function assertBuildNotLeased(output) {
  if (!existsSync(lock)) return
  const lease = JSON.parse(readFileSync(`${lock}/owner.json`, 'utf8'))
  const within = relative(output, lease.binary)
  if (
    (!within || (!within.startsWith('..') && !isAbsolute(within))) &&
    alive(lease.pid)
  )
    throw new Error('Build artifact is leased by an active native measurement')
}
export function acquireMeasurement(output, binary) {
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    output,
    binary,
    started: Date.now(),
    start: execFileSync(
      '/bin/ps',
      ['-p', String(process.pid), '-o', 'lstart='],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
    ).trim(),
  }
  try {
    mkdirSync(lock, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error(
      `Native measurement lease unavailable: inspect ${lock}; never stop another owner or automatically reap it`,
      { cause: error },
    )
  }
  const serialized = JSON.stringify(owner)
  try {
    writeFileSync(`${lock}/owner.json`, serialized, { flag: 'wx', mode: 0o600 })
    writeFileSync(`${output}/measurement-owner.json`, serialized)
  } catch (error) {
    if (
      existsSync(`${lock}/owner.json`) &&
      readFileSync(`${lock}/owner.json`, 'utf8') === serialized
    )
      rmSync(`${lock}/owner.json`)
    if (readdirSync(lock).length === 0) rmdirSync(lock)
    throw error
  }
  return {
    owner,
    release: () => {
      if (
        lstatSync(lock).isSymbolicLink() ||
        !isDeepStrictEqual(
          JSON.parse(readFileSync(`${lock}/owner.json`, 'utf8')),
          owner,
        )
      )
        throw new Error('Native measurement lease ownership changed')
      for (const name of readdirSync(output).filter(
        (name) =>
          /^child-\d+(?:-webview)?\.json$/.test(name) ||
          name === 'display-owner.json',
      )) {
        const child = JSON.parse(readFileSync(`${output}/${name}`, 'utf8'))
        if (alive(child.pid))
          throw new Error(
            'Recorded native resource still live; retain measurement lease for inspection',
          )
      }
      rmSync(`${lock}/owner.json`)
      rmdirSync(lock)
    },
  }
}
export function hostReasons(row, previous = null) {
  const reasons = []
  if (row.error) reasons.push('host-observer-unavailable')
  if (
    !Number.isFinite(row.time) ||
    !Number.isFinite(row.cpuBusyPercent) ||
    !Number.isInteger(row.logicalCpus) ||
    row.logicalCpus < 1 ||
    !Number.isFinite(row.load1) ||
    !Array.isArray(row.buildProcesses) ||
    !Number.isInteger(row.memoryPressure)
  )
    reasons.push('host-observation-incomplete')
  if (
    previous &&
    (row.time <= previous.time ||
      row.time - previous.time > hostPolicy.maxGapMs)
  )
    reasons.push('host-observation-gap')
  if (row.buildProcesses?.length) reasons.push('build-process-presence')
  if (row.cpuBusyPercent > hostPolicy.maxCpuBusyPercent)
    reasons.push('whole-host-cpu-capacity')
  if (row.load1 / row.logicalCpus > hostPolicy.maxLoad1PerCpu)
    reasons.push('whole-host-load-capacity')
  if (row.memoryPressure !== hostPolicy.memoryPressure)
    reasons.push('whole-host-memory-pressure')
  return reasons
}
export function cpuBusy(previous, counters) {
  if (
    !Array.isArray(previous) ||
    !Array.isArray(counters) ||
    !previous.length ||
    previous.length !== counters.length
  )
    return null
  const keys = ['user', 'nice', 'sys', 'idle', 'irq']
  if (
    !counters.every((cpu, i) =>
      keys.every(
        (key) =>
          Number.isFinite(cpu?.[key]) &&
          Number.isFinite(previous[i]?.[key]) &&
          cpu[key] >= previous[i][key],
      ),
    )
  )
    return null
  const total = counters.reduce(
    (sum, cpu, i) =>
      sum + keys.reduce((n, key) => n + cpu[key] - previous[i][key], 0),
    0,
  )
  const idle = counters.reduce(
    (sum, cpu, i) => sum + cpu.idle - previous[i].idle,
    0,
  )
  return total > 0 ? (1 - idle / total) * 100 : null
}
const cpuCounters = () => cpus().map((cpu) => ({ ...cpu.times }))
export function buildProcesses(executables, argumentsText) {
  const parse = (text) =>
    text.split('\n').flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      return match ? [[Number(match[1]), match[2]]] : []
    })
  const argumentsByPID = new Map(parse(argumentsText))
  return parse(executables).flatMap(([pid, executable]) => {
    const name = basename(executable)
    return /^(cargo(?:-[\w-]+)?|rustc|clang(?:\+\+)?|cc|gcc|g\+\+|ld|ld64|make|gmake|ninja)$/.test(
      name,
    ) ||
      (name === 'node' &&
        /(?:\b(?:vite|webpack|rollup|esbuild|tsc)\b|(?:^|[\s/])build\.mjs(?:\s|$))/.test(
          argumentsByPID.get(pid) || '',
        ))
      ? [{ pid, executable }]
      : []
  })
}
async function observe(previousCounters, stage) {
  const time = performance.now()
  const counters = cpuCounters()
  const cpuBusyPercent = cpuBusy(previousCounters, counters)
  const row = {
    time,
    epochMs: Date.now(),
    stage,
    logicalCpus: counters.length,
    cpuCounters: counters,
    cpuBusyPercent,
    load1: loadavg()[0],
    buildProcesses: [],
    memoryPressure: null,
  }
  try {
    const [executables, argumentsText, pressure] = await Promise.all([
      execute('/bin/ps', ['-ww', '-axo', 'pid=,comm='], {
        maxBuffer: 8 * 1024 * 1024,
        timeout: hostPolicy.observerTimeoutMs,
        killSignal: 'SIGKILL',
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      }),
      execute('/bin/ps', ['-ww', '-axo', 'pid=,args='], {
        maxBuffer: 8 * 1024 * 1024,
        timeout: hostPolicy.observerTimeoutMs,
        killSignal: 'SIGKILL',
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      }),
      execute(
        '/usr/sbin/sysctl',
        ['-n', 'kern.memorystatus_vm_pressure_level'],
        { timeout: hostPolicy.observerTimeoutMs, killSignal: 'SIGKILL' },
      ),
    ])
    row.memoryPressure = Number(pressure.stdout.trim())
    row.buildProcesses = buildProcesses(
      executables.stdout,
      argumentsText.stdout,
    )
  } catch (error) {
    row.error = String(error)
  }
  return row
}
export function monitorHost(output) {
  const evidence = {
    policy: hostPolicy,
    status: 'pending',
    reasons: [],
    observations: [],
    windows: [],
  }
  writeFileSync(
    `${output}/host-policy.json`,
    JSON.stringify(hostPolicy, null, 2),
  )
  let stage = 'quiet',
    stopped = false,
    pending,
    lastQuiet = null
  const record = async () => {
    const row = await observe(evidence.observations.at(-1)?.cpuCounters, stage)
    const reasons = hostReasons(row, evidence.observations.at(-1))
    row.reasons = reasons
    evidence.observations.push(row)
    if (row.stage === 'measurement' && reasons.length) {
      evidence.status = 'excluded'
      evidence.reasons = [...new Set([...evidence.reasons, ...reasons])]
    }
    appendFileSync(
      `${output}/host-observations.jsonl`,
      JSON.stringify(row) + '\n',
    )
  }
  pending = (async () => {
    while (!stopped) {
      const start = performance.now()
      try {
        await record()
      } catch (error) {
        evidence.status = 'excluded'
        evidence.reasons.push('host-observer-unavailable')
        evidence.error = String(error)
        stopped = true
      }
      if (!stopped)
        await sleep(
          Math.max(1, hostPolicy.pollMs - (performance.now() - start)),
        )
    }
  })()
  return {
    evidence,
    async quiet(signal) {
      stage = 'quiet'
      lastQuiet = null
      const started = performance.now()
      const window = { started, accepted: false }
      evidence.windows.push(window)
      while (performance.now() - started < hostPolicy.maxWaitMs) {
        if (evidence.status === 'excluded')
          throw new Error(
            `Performance sample excluded: ${evidence.reasons.join(', ')}`,
          )
        const latest = evidence.observations.at(-1)
        if (
          latest?.stage === 'quiet' &&
          !latest.reasons.length &&
          performance.now() - latest.time <= hostPolicy.maxGapMs
        ) {
          lastQuiet ??= latest.time
          if (latest.time - lastQuiet >= hostPolicy.quietMs) {
            window.quietStarted = lastQuiet
            window.ended = latest.time
            window.accepted = true
            stage = 'measurement'
            return
          }
        } else lastQuiet = null
        await sleep(100, undefined, { signal })
      }
      evidence.status = 'excluded'
      evidence.reasons.push('quiet-window-timeout')
      window.ended = performance.now()
      throw new Error('Performance sample excluded: quiet-window-timeout')
    },
    check() {
      const latest = evidence.observations.at(-1)
      if (
        stage === 'measurement' &&
        (!latest || performance.now() - latest.time > hostPolicy.maxGapMs)
      ) {
        evidence.status = 'excluded'
        if (!evidence.reasons.includes('host-observation-stale'))
          evidence.reasons.push('host-observation-stale')
      }
      if (evidence.status === 'excluded')
        throw new Error(
          `Performance sample excluded: ${evidence.reasons.join(', ')}`,
        )
    },
    cleanup() {
      stage = 'cleanup'
    },
    async stop(report) {
      stopped = true
      await pending
      if (evidence.status !== 'excluded')
        evidence.status =
          evidence.windows.length &&
          evidence.windows.every((window) => window.accepted)
            ? 'eligible'
            : 'excluded'
      if (evidence.status === 'excluded' && !evidence.reasons.length)
        evidence.reasons.push('no-complete-quiet-window')
      if (
        evidence.status === 'eligible' &&
        !validEligibility({ ...report, eligibility: evidence })
      ) {
        evidence.status = 'excluded'
        evidence.reasons.push('host-measurement-coverage-incomplete')
      }
      writeFileSync(
        `${output}/host-observations.json`,
        JSON.stringify(evidence, null, 2),
      )
      return evidence
    },
  }
}
export function validEligibility(report) {
  const e = report?.eligibility
  if (
    !e ||
    e.status !== 'eligible' ||
    !isDeepStrictEqual(e.policy, hostPolicy) ||
    !Array.isArray(e.reasons) ||
    e.reasons.length ||
    !Array.isArray(e.observations) ||
    !Array.isArray(e.windows) ||
    e.windows.length !== report.runs?.length
  )
    return false
  if (
    !e.observations.every(
      (row, i) =>
        row &&
        Number.isFinite(row.time) &&
        ['quiet', 'measurement', 'cleanup'].includes(row.stage) &&
        (!i || row.time > e.observations[i - 1].time) &&
        row.logicalCpus === row.cpuCounters?.length &&
        (i === 0 ||
          (cpuBusy(e.observations[i - 1].cpuCounters, row.cpuCounters) !==
            null &&
            Math.abs(
              cpuBusy(e.observations[i - 1].cpuCounters, row.cpuCounters) -
                row.cpuBusyPercent,
            ) < 1e-8)),
    )
  )
    return false
  if (
    !e.windows.every((w) => {
      const rows = e.observations.filter(
        (row) => row.time >= w.quietStarted && row.time <= w.ended,
      )
      return (
        w.accepted === true &&
        Number.isFinite(w.started) &&
        Number.isFinite(w.quietStarted) &&
        w.quietStarted >= w.started &&
        w.ended - w.quietStarted >= hostPolicy.quietMs &&
        w.ended - w.started <= hostPolicy.maxWaitMs &&
        rows.length > 1 &&
        rows[0].time === w.quietStarted &&
        rows.at(-1).time === w.ended &&
        rows.every(
          (row) =>
            row.stage === 'quiet' &&
            hostReasons(row, e.observations[e.observations.indexOf(row) - 1])
              .length === 0,
        )
      )
    })
  )
    return false
  return (
    e.observations.every(
      (row, i) =>
        row.stage !== 'measurement' ||
        hostReasons(row, e.observations[i - 1]).length === 0,
    ) &&
    report.runs.every((run, i) => {
      const window = e.windows[i]
      const begin = run.hostStarted,
        end = run.hostEnded
      const rows = e.observations.filter(
        (row) => row.time >= begin && row.time <= end,
      )
      return (
        Number.isFinite(begin) &&
        Number.isFinite(end) &&
        end > begin &&
        window.ended <= begin &&
        begin - window.ended <= hostPolicy.maxGapMs &&
        (!i || window.started >= report.runs[i - 1].hostEnded) &&
        rows.length > 1 &&
        rows.every(
          (row) =>
            row.stage === 'measurement' &&
            hostReasons(row, e.observations[e.observations.indexOf(row) - 1])
              .length === 0,
        ) &&
        Array.isArray(run.samples) &&
        run.samples.every(
          (sample) =>
            Number.isFinite(sample.time) &&
            sample.time >= begin &&
            sample.time <= end,
        ) &&
        rows[0].time - begin <= hostPolicy.maxGapMs &&
        end - rows.at(-1).time <= hostPolicy.maxGapMs
      )
    })
  )
}
