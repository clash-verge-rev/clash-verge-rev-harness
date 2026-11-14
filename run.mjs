import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  realpathSync,
} from 'node:fs'
import { createServer, createConnection } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

import {
  hash,
  projectRoot,
  toolRoot,
  harnessHash,
  automation,
} from './project.mjs'

import { startDisplay, virtualDisplayContract } from './display.mjs'
import { createArtifacts } from './artifacts.mjs'
import {
  captureIsolation,
  isolationBaseline,
  isolationMethod,
  isolationResult,
} from './isolation.mjs'
import {
  delta,
  summarize,
  markdown,
  phases,
  roles,
  validStats,
  validWorkload,
  replayValues,
  SCHEMA,
  validObservation,
  validVisibility,
  validDelivery,
} from './report.mjs'
import { acquireMeasurement, hostPolicy, monitorHost } from './host.mjs'
import { fixture, workload } from './workload.mjs'

const { values } = parseArgs({
  args: process.argv.slice(2).filter((v) => v !== '--'),
  options: {
    project: { type: 'string' },
    display: { type: 'string', default: 'physical' },
    'capture-smoke': { type: 'boolean', default: false },
    output: { type: 'string', default: `target/perf/runs/${Date.now()}` },
    binary: { type: 'string', default: 'target/perf/build/clash-verge' },
    repeat: { type: 'string', default: '3' },
    seconds: { type: 'string', default: '20' },
    warmup: { type: 'string', default: '10' },
    'fail-phase': { type: 'string' },
    scenario: { type: 'string', default: 'traffic' },
    layer: { type: 'string', default: 'component' },
    profile: { type: 'string', default: 'steady' },
    allocator: { type: 'string', default: 'default' },
  },
})
const project = projectRoot(values.project)
const driver = automation(project)
const { createTauriCapabilities } = await driver.load('@wdio/tauri-service')
const { remote } = await driver.load('webdriverio')
const { default: WebSocket } = await driver.load('ws')
const { WebSocketServer } = WebSocket
const seconds = Number(values.seconds),
  warmup = Number(values.warmup),
  repeat = Number(values.repeat)
const workloadContract = workload(values.scenario, values.layer, values.profile)
const { replayMs } = workloadContract
if (!['physical', 'virtual'].includes(values.display))
  throw new Error('Unknown display mode')
if (!['default', 'diagnostic-malloc'].includes(values.allocator))
  throw new Error('Unknown allocator')
if (
  Object.keys(process.env).some((key) =>
    /^(DYLD_|__XPC_DYLD_|Malloc|__XPC_Malloc)/.test(key),
  )
)
  throw new Error(
    'Ambient engine/allocator overrides are not supported; use --allocator',
  )
if (process.platform !== 'darwin') throw new Error('macOS only')
function readConsole() {
  const consoleState = JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
      input: execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a']),
      encoding: 'utf8',
    }),
  )
  const locked = consoleState.IOConsoleLocked
  if (typeof locked !== 'boolean')
    throw new Error('Environment unavailable: unknown console lock state')
  return locked
}
function checkConsole() {
  const locked = readConsole()
  if (locked)
    throw new Error(
      'Environment unavailable: an unlocked graphical session is required; window focus is not required',
    )
  return locked
}
const consoleLocked = checkConsole()
if (
  ![seconds, warmup, repeat].every(Number.isFinite) ||
  seconds < 5 ||
  warmup < 2 ||
  repeat < 1 ||
  !Number.isInteger(repeat)
)
  throw new Error('Require seconds >= 5, warmup >= 2, integer repeat >= 1')
const phaseTargets = phases.map(
  (_, i) =>
    Math.ceil(((warmup + 5) * 1000) / replayMs) +
    i * Math.ceil(((seconds + 2) * 1000) / replayMs),
)
if ((phaseTargets[2] * replayMs) / 1000 + seconds + 5 >= 600)
  throw new Error(
    'Total replay including transition allowance must be < 10 minutes',
  )
const binary = realpathSync(resolve(project, values.binary)),
  output = resolve(project, values.output)
const webcontentBinary = realpathSync(
  '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent',
)
const build = JSON.parse(readFileSync(`${binary}.json`))
if (hash(readFileSync(binary)) !== build.binarySha256)
  throw new Error('Binary does not match build manifest')
if (
  build.identityVersion !== 2 ||
  build.buildInputs?.before?.sha256 !== build.buildInputs?.after?.sha256 ||
  !build.buildInputs?.before?.packages?.length
)
  throw new Error(
    'Build lacks resolved, stable native-input identity; rebuild with this harness',
  )
if (build.project !== project)
  throw new Error('Build belongs to a different project checkout')
createArtifacts(project, output, 'run')
const command = (name, args) =>
  execFileSync(name, args, { encoding: 'utf8' }).trim()
const report = {
  schema: SCHEMA,
  build,
  contract: {
    automationPackages: driver.identity,
    display:
      values.display === 'virtual'
        ? virtualDisplayContract
        : { mode: 'physical' },
    ...workloadContract,
    allocator: values.allocator,
    consoleLocked,
    method: 'mach-rusage-v0-seconds/rss-and-footprint-bytes-v2',
    mode: build.mode,
    buildSettingsSha256: build.buildSettingsSha256,
    buildEnvironment: build.buildEnvironment,
    toolchain: build.toolchain,
    platform: command('sw_vers', []),
    machine: command('sysctl', ['-n', 'hw.model']),
    arch: process.arch,
    host: hash(command('scutil', ['--get', 'LocalHostName'])),
    hardware: command('sysctl', ['hw.ncpu', 'hw.memsize']),
    power: command('pmset', ['-g', 'custom']),
    powerSource: command('pmset', ['-g', 'batt']).split('\n')[0],
    webkit: command('defaults', [
      'read',
      '/System/Library/Frameworks/WebKit.framework/Resources/Info',
      'CFBundleVersion',
    ]),
    seconds,
    warmup,
    phaseTargets,
    transitionSeconds: 2,
    readinessAllowanceSeconds: 5,
    intervalMs: 1000,
    samplingSchedule: 'absolute-one-second-slots-v1',
    window: [1000, 700],
    windowPolicy: 'nonactivating-top-click-through-v1',
    rangeMinutes: 10,
    replay:
      values.scenario === 'traffic'
        ? 'deterministic-v1, 5Hz, no prefill, append boundary, default bezier, blur pause false'
        : 'deterministic-v2, no prefill, fixture source, bounded history, connection turnover every 10 snapshots',
    automation:
      'wdio plugin 1.5.1; 20Hz macOS runloop pump plus one fixed async WebDriver observation/second',
  },
  runs: [],
}
report.units = {
  time: 'monotonic milliseconds',
  cpu: 'cumulative CPU seconds',
  percent: 'one CPU core = 100%',
  rss: 'resident size bytes',
  footprint: 'physical footprint bytes',
  start: 'Mach process start ticks',
}
report.monotonicOriginEpochMs = performance.timeOrigin
report.harnessSha256 = harnessHash()
let interrupted = false
const abort = new AbortController()
const pause = (ms) => sleep(ms, undefined, { signal: abort.signal })
const waitUntilDeadline = async (deadline) => {
  while (performance.now() < deadline)
    await pause(Math.max(1, Math.ceil(deadline - performance.now())))
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = true
    process.exitCode = 1
    abort.abort()
  })
const assert = (value, reason) => {
  if (!value) throw new Error(reason)
}
const drawn = (s) => s.now >= s.draw && s.now - s.draw < 2500
const marker = (s) => ({
  ...s,
  pixelsSha256: hash(s.pixels),
  pixels: undefined,
  ua: undefined,
  token: undefined,
})
async function freePort() {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise((done) => server.close(done))
  return port
}
const policyBytes = readFileSync(
  resolve(project, 'scripts/perf/isolation.json'),
)
const isolationPolicy = JSON.parse(policyBytes)
report.isolation = { before: captureIsolation(isolationPolicy) }
report.contract.isolation = {
  method: isolationMethod,
  policySha256: hash(policyBytes),
  baselineSha256: isolationBaseline(report.isolation.before),
}
let display, lease, host
report.eligibility = {
  policy: hostPolicy,
  status: 'excluded',
  reasons: ['measurement-not-started'],
  observations: [],
  windows: [],
}
try {
  lease = acquireMeasurement(output, binary)
  report.measurementOwner = lease.owner
  execFileSync('cc', [
    '-O2',
    resolve(toolRoot, 'sample.c'),
    '-o',
    `${output}/sample`,
  ])

  assert(
    report.contract.isolation.baselineSha256 !== null,
    'Complete isolation baseline unavailable',
  )
  if (values.display === 'virtual') {
    display = await startDisplay(output, `${output}/sample`)
    report.displayOwner = display.owner
  }
  host = monitorHost(output)
  report.eligibility = host.evidence
  for (let iteration = 0; iteration < repeat && !interrupted; iteration++) {
    host.check()
    await host.quiet(abort.signal)
    display?.verify()
    const hostStarted = performance.now()
    const initialLocked = checkConsole()
    const token = randomUUID(),
      port = await freePort()
    const run = {
      token,
      hostStarted,
      ok: false,
      samples: [],
      observations: [],
      consoleStates: [
        { name: 'initial', locked: initialLocked, time: Date.now() },
      ],
      marks: [],
      stats: {},
      cleanup: {},
      replay: { sent: 0, maxLateMs: 0 },
    }
    report.runs.push(run)
    const replay = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise((done) => replay.on('listening', done))
    let sequence = 0,
      replayStarted,
      timer
    replay.on('connection', () => {
      if (replayStarted !== undefined) {
        run.replay.error = 'unexpected replay reconnection'
        clearTimeout(timer)
        return
      }
      replayStarted = performance.now()
      timer = setTimeout(send, replayMs)
    })
    const deadlineIndex = () =>
      Math.floor((performance.now() - replayStarted) / replayMs)
    function send() {
      const deadline = replayStarted + (sequence + 1) * replayMs
      const late = performance.now() - deadline
      if (late < 0) {
        timer = setTimeout(send, Math.ceil(-late))
        return
      }
      run.replay.maxLateMs = Math.max(run.replay.maxLateMs, late)
      if (late >= replayMs) {
        run.replay.error = `replay source missed a complete ${replayMs} ms period`
        return
      }
      sequence++
      run.replay.sent = sequence
      const timestamp = Date.now()
      const point = JSON.stringify({
        sequence,
        timestamp,
        ...(values.scenario === 'traffic'
          ? replayValues(sequence)
          : { payload: fixture(values.scenario, sequence, values.profile) }),
      })
      for (const socket of replay.clients)
        if (socket.readyState === 1) socket.send(point)
      timer = setTimeout(
        send,
        Math.max(
          0,
          replayStarted + (sequence + 1) * replayMs - performance.now(),
        ),
      )
    }
    const log = openSync(`${output}/${iteration + 1}.log`, 'w')
    const child = spawn(binary, [], {
      env: {
        ...process.env,
        PERF_TOKEN: token,
        PERF_DISPLAY_MODE: values.display,
        PERF_DISPLAY_ID: display ? String(display.owner.displayID) : '',
        PERF_SCENARIO: values.scenario,
        PERF_LAYER: values.layer,
        ...(values.allocator === 'diagnostic-malloc'
          ? { Malloc: '1', __XPC_Malloc: '1' }
          : {}),
        PERF_REPLAY_PORT: String(replay.address().port),
        TAURI_WEBDRIVER_PORT: String(port),
      },
      stdio: ['ignore', log, log],
    })
    closeSync(log)
    if (child.pid)
      writeFileSync(
        `${output}/child-${iteration + 1}.json`,
        JSON.stringify({ pid: child.pid }),
      )
    let browser, childError, previous, mainStart
    const identities = {}
    child.on('error', (error) => {
      childError = error
    })
    const exited = new Promise((done) => child.once('exit', done))
    const alive = () =>
      !childError && child.exitCode === null && child.signalCode === null
    const collect = (pids) =>
      command(`${output}/sample`, pids.map(String))
        .split('\n')
        .map((line) => {
          const [pid, start, cpu, rss, footprint, ...path] = line.split(' ')
          return {
            pid: Number(pid),
            start,
            cpu: Number(cpu),
            rss: Number(rss),
            footprint: Number(footprint),
            path: path.join(' '),
            time: performance.now(),
          }
        })
    const identify = (role, row) => {
      assert(
        row.path === (role === 'main' ? binary : webcontentBinary),
        `unexpected ${role} process executable: ${row.path}`,
      )
      assert(
        BigInt(row.start) >= BigInt(mainStart),
        'process predates owned application',
      )
      const identity = `${row.pid}/${row.start}`
      assert(
        !identities[role] || identities[role] === identity,
        'process identity changed during scenario',
      )
      identities[role] = identity
    }
    const observe = async (action, pixels) => {
      const native = await window.__TAURI_INTERNALS__.invoke('perf_state', {
        action,
      })
      const canvas = document.querySelector('canvas')
      const scenario =
        new URLSearchParams(location.search).get('scenario') ?? 'traffic'
      const data = document.documentElement.dataset
      return {
        ...native,
        scenario,
        layer: new URLSearchParams(location.search).get('layer') ?? 'component',
        delivered: Number(data.perfDelivered || 0),
        subscriptions: Number(data.perfSubscriptions || 0),
        error:
          data.perfError ||
          document.querySelector('[role=alert]')?.textContent ||
          null,
        now: Date.now(),
        hidden: document.hidden,
        focused: document.hasFocus(),
        received: Number(document.documentElement.dataset.perfReceived),
        source: Number(document.documentElement.dataset.perfSourceTime),
        gaps: Number(document.documentElement.dataset.perfGaps),
        worker: Number(
          scenario === 'traffic' ? data.perfWorker : data.perfSourceTime,
        ),
        points: Number(document.documentElement.dataset.perfPoints),
        lastUp: Number(document.documentElement.dataset.perfLastUp),
        lastDown: Number(document.documentElement.dataset.perfLastDown),
        draw: Number(
          scenario === 'traffic' ? canvas?.dataset.perfDraw : data.perfDraw,
        ),
        pixels: pixels
          ? scenario === 'traffic'
            ? canvas?.toDataURL()
            : document.getElementById('root')?.textContent
          : null,
        ua: navigator.userAgent,
      }
    }
    const observationScript = `const done = arguments[arguments.length - 1]; (${observe.toString()})(arguments[0], arguments[1]).then(done, (error) => done({ error: String(error) }));`
    const state = (action = 'state', pixels = false) =>
      browser.executeAsyncScript(observationScript, [action, pixels])
    const checked = async (action, pixels) => {
      host.check()
      assert(!interrupted, 'interrupted')
      assert(!run.replay.error, run.replay.error)
      assert(
        alive(),
        `owned app exited: ${childError ?? child.exitCode ?? child.signalCode}`,
      )
      display?.verify()
      const value = await state(action, pixels)
      value.displayMode = values.display
      if (display)
        value.expectedDisplayFrame = display.owner.during.find(
          (screen) => screen.id === display.owner.displayID,
        ).frame
      assert(!value.error, value.error)
      assert(!run.replay.error, run.replay.error)
      run.lastObservation = { ...value, pixels: undefined, ua: undefined }
      assert(
        value.token === token && value.main === child.pid,
        'instance identity mismatch',
      )
      if (!identities.webview) {
        run.initialAttribution = collect([value.webview])[0]
        writeFileSync(
          `${output}/child-${iteration + 1}-webview.json`,
          JSON.stringify({ pid: value.webview }),
        )
        identify('webview', run.initialAttribution)
      }
      assert(
        value.nativeFocused === false && value.appActive === false,
        'measurement window unexpectedly activated',
      )
      assert(
        value.top === true && value.clickThrough === true,
        'measurement window must be natively topmost and click-through',
      )
      return value
    }
    try {
      mainStart = collect([child.pid])[0].start
      const deadline = Date.now() + 30000
      while (true) {
        assert(
          Date.now() < deadline && !interrupted && alive(),
          'embedded WebDriver readiness deadline or app exit',
        )
        try {
          if (
            (
              await fetch(`http://127.0.0.1:${port}/status`, {
                signal: AbortSignal.timeout(500),
              })
            ).ok
          )
            break
        } catch {}
        await pause(100)
      }
      const listener = command('lsof', [
        '-nP',
        '-a',
        '-p',
        String(child.pid),
        `-iTCP:${port}`,
        '-sTCP:LISTEN',
      ])
      assert(
        listener.includes(`127.0.0.1:${port}`) &&
          !listener.includes(`*:${port}`),
        'driver must belong to this app and bind loopback',
      )
      const capabilities = createTauriCapabilities(binary)
      delete capabilities['wdio:tauriServiceOptions']
      browser = await remote({
        hostname: '127.0.0.1',
        port,
        capabilities,
        logLevel: 'error',
        connectionRetryCount: 0,
        connectionRetryTimeout: 5000,
      })
      const handles = await browser.getWindowHandles()
      assert(handles.length === 1, 'expected exactly one measurement WebView')
      await browser.switchToWindow(handles[0])
      if (values.scenario !== 'traffic') await checked('show')
      // Replay's parent effect starts the socket after the graph installs its listeners.
      await browser.waitUntil(
        async () => {
          const s = await checked()
          return (
            validWorkload(s) &&
            s.received >= 3 &&
            s.now >= s.worker &&
            s.now - s.worker < 2500
          )
        },
        {
          timeout: 20000,
          interval: 100,
          timeoutMsg: 'replay receiver not ready before show',
        },
      )
      run.initialData = run.lastObservation
      await checked('show')
      await browser.waitUntil(
        async () => {
          const s = await checked()
          return validObservation({ phase: 'foreground', ...s })
        },
        {
          timeout: 15000,
          interval: 250,
          timeoutMsg: 'traffic data path/page not ready',
        },
      )
      run.userAgent = (await checked()).ua
      run.backgroundLoad = command('sysctl', ['-n', 'vm.loadavg'])
      const viewport = await browser.executeScript(
        'return [innerWidth, innerHeight, devicePixelRatio]',
        [],
      )
      run.viewport = { dom: viewport, driver: await browser.getWindowRect() }
      const driverScale = run.viewport.driver.width / 1000
      assert(
        viewport[0] === 1000 &&
          viewport[1] > 0 &&
          viewport[1] <= 700 &&
          (driverScale === 1 || driverScale === viewport[2]) &&
          run.viewport.driver.height / driverScale === 700,
        `unexpected window dimensions: ${JSON.stringify(run.viewport)}`,
      )
      assert(
        !report.contract.viewport ||
          JSON.stringify(report.contract.viewport) === JSON.stringify(viewport),
        'viewport changed between runs',
      )
      report.contract.viewport = viewport
      if (values['capture-smoke']) {
        writeFileSync(
          `${output}/owned-webview-${iteration + 1}.png`,
          Buffer.from(await browser.takeScreenshot(), 'base64'),
        )
      }
      run.marks.push({ name: 'ready', time: Date.now() })
      const readyAt = performance.now()
      assert(
        phaseTargets[0] - (await checked()).received >=
          (warmup * 1000) / replayMs,
        'readiness exceeded fixed replay allowance',
      )
      for (const phase of phases) {
        run.consoleStates.push({
          name: phase,
          locked: readConsole(),
          time: Date.now(),
        })
        const operation = performance.now()
        let s = await checked(phase === 'hidden' ? 'hide' : 'show', true)
        assert(
          s.visible === (phase !== 'hidden'),
          `${phase}: native visibility mismatch`,
        )
        const beforeDraw = s.draw
        await browser.waitUntil(
          async () => {
            s = await checked('state', true)
            return (
              validVisibility({ phase, ...s }) &&
              (phase === 'hidden' || (s.draw > beforeDraw && drawn(s)))
            )
          },
          {
            timeout: 5000,
            interval: 100,
            timeoutMsg: `${phase}: window/Canvas readiness deadline`,
          },
        )
        const operationMs = performance.now() - operation
        const target = phaseTargets[phases.indexOf(phase)]
        await browser.waitUntil(
          async () => {
            s = await checked('state', true)
            assert(
              s.received <= target,
              `${phase}: missed replay anchor ${target}`,
            )
            return s.received === target
          },
          {
            timeout: Math.max(1000, (target - s.received) * replayMs + 1000),
            interval: 50,
            timeoutMsg: `${phase}: replay anchor deadline`,
          },
        )
        assert(
          validObservation({ phase, ...s }),
          `${phase}: invalid traffic observation`,
        )
        const first = s,
          start = performance.now(),
          firstIndex = deadlineIndex(),
          phaseEpoch = Date.now()
        if (phase === 'foreground') {
          run.actualWarmupMs = start - readyAt
          assert(
            run.actualWarmupMs >= warmup * 1000,
            'insufficient actual warmup',
          )
        }
        run.marks.push({
          name: phase,
          time: phaseEpoch,
          operationMs,
          transitionMs: start - operation,
          target,
          ...marker(s),
          deadlineIndex: firstIndex,
          senderSent: run.replay.sent,
        })
        previous = {}
        if (values['fail-phase'] === phase)
          throw new Error(`injected failure at ${phase}`)
        for (let slot = 0; slot < seconds; slot++) {
          await waitUntilDeadline(start + slot * 1000)
          s = await checked()
          run.observations.push({ phase, ...run.lastObservation })
          assert(
            validObservation({ phase, ...s }),
            `${phase}: invalid visibility, workload or freshness`,
          )
          assert(
            performance.now() - replayStarted < 600000,
            'replay exceeded raw history window',
          )
          const samples = collect(roles.map((role) => s[role]))
          run.attribution = {
            main: s.main,
            webview: s.webview,
            observed: samples,
          }
          for (let i = 0; i < roles.length; i++) {
            const row = { ...samples[i], phase, role: roles[i] }
            identify(row.role, row)
            row.percent = delta(previous[row.role], row)
            row.cpuDelta =
              row.percent === null ? null : row.cpu - previous[row.role].cpu
            run.samples.push(row)
            previous[row.role] = row
          }
          assert(
            performance.now() < start + Math.min(slot + 1, seconds) * 1000,
            `${phase}: observation missed a one-second sampling slot`,
          )
        }
        await waitUntilDeadline(start + seconds * 1000)
        s = await checked('state', true)
        const endIndex = deadlineIndex()
        const expected = endIndex - firstIndex
        assert(
          validObservation({ phase, ...s }) &&
            validDelivery(first, s, phase) &&
            s.worker > first.worker &&
            Math.abs(s.received - first.received - expected) <= 2,
          `${phase}: unstable or lost workload`,
        )
        if (phase !== 'hidden')
          assert(
            s.draw > first.draw && s.pixels !== first.pixels,
            `${phase}: view did not render fresh data`,
          )
        run.marks.push({
          name: `${phase}:end`,
          time: s.now,
          ...marker(s),
          deadlineIndex: endIndex,
          senderSent: run.replay.sent,
        })
        run.consoleStates.push({
          name: `${phase}:end`,
          locked: readConsole(),
          time: Date.now(),
        })
      }
      if (values.scenario !== 'traffic') {
        clearTimeout(timer)
        await pause(replayMs + 100)
        const stopped = await checked()
        await pause(2100)
        const idle = await checked()
        assert(
          idle.received === stopped.received,
          'source advanced while stopped',
        )
        replayStarted = performance.now() - sequence * replayMs
        timer = setTimeout(send, replayMs)
        await browser.waitUntil(
          async () => {
            const recovered = await checked()
            run.recovery = {
              stopped: stopped.received,
              idle: idle.received,
              resumed: recovered.received,
              draw: recovered.draw,
            }
            return (
              recovered.received >= idle.received + 2 &&
              recovered.draw > idle.draw
            )
          },
          {
            timeout: 6000,
            interval: 250,
            timeoutMsg: 'source stop/recovery failed',
          },
        )
      }
      run.stats = summarize(run.samples, seconds)
      assert(
        validStats(run.stats),
        'insufficient coverage or process discontinuity',
      )
      run.ok = true
    } catch (error) {
      run.error = String(error)
      process.exitCode = 1
    } finally {
      run.hostEnded = performance.now()
      host.cleanup()
      if (host.evidence.status === 'excluded') interrupted = true
      await browser?.deleteSession().catch(() => {})
      try {
        if (alive() && collect([child.pid])[0].start === mainStart) {
          child.kill('SIGTERM')
          await Promise.race([exited, sleep(5000)])
          if (alive() && collect([child.pid])[0].start === mainStart) {
            child.kill('SIGKILL')
            await Promise.race([exited, sleep(2000)])
          }
        }
      } catch (error) {
        run.cleanup.error = String(error)
      }
      clearTimeout(timer)
      for (const socket of replay.clients) socket.terminate()
      await new Promise((done) => replay.close(done))
      const webviewRemains = () => {
        if (!identities.webview) return false
        const [pid, start] = identities.webview.split('/')
        try {
          return collect([pid])[0].start === start
        } catch {
          try {
            process.kill(Number(pid), 0)
            return true
          } catch (error) {
            return error.code !== 'ESRCH'
          }
        }
      }
      if (identities.webview) {
        const deadline = Date.now() + 5000
        while (webviewRemains() && Date.now() < deadline) await sleep(100)
      }
      const resourcesStopped = async () => {
        run.cleanup.mainExited =
          child.pid === undefined ||
          child.exitCode !== null ||
          child.signalCode !== null
        if (identities.webview) run.cleanup.webviewExited = !webviewRemains()
        run.cleanup.driverClosed = await new Promise((done) => {
          const socket = createConnection({ host: '127.0.0.1', port })
          const finish = (closed) => {
            socket.destroy()
            done(closed)
          }
          socket.once('connect', () => finish(false))
          socket.once('error', (error) => finish(error.code === 'ECONNREFUSED'))
          socket.setTimeout(500, () => finish(false))
        })
        return (
          run.cleanup.mainExited &&
          run.cleanup.driverClosed &&
          run.cleanup.webviewExited !== false
        )
      }
      if (!(await resourcesStopped())) {
        run.ok = false
        run.error = `${run.error ?? ''} cleanup failed`
        process.exitCode = 1
        interrupted = true
        if (display) {
          run.cleanup.waitingForNativeShutdown = true
          writeFileSync(
            `${output}/${iteration + 1}.json`,
            JSON.stringify(run, null, 2),
          )
          writeFileSync(
            `${output}/summary.json`,
            JSON.stringify(report, null, 2),
          )
          console.error(
            'Native cleanup incomplete; retaining owned virtual display until app, WebContent and driver stop. Inspect saved cleanup evidence.',
          )
          while (!(await resourcesStopped())) await sleep(1000)
          run.cleanup.waitingForNativeShutdown = false
        }
      }
      run.lifecycle = {
        status: run.ok ? 'complete' : 'incomplete',
        cleanupComplete:
          run.cleanup.mainExited === true &&
          run.cleanup.driverClosed === true &&
          run.cleanup.webviewExited === true,
      }
      run.stats = summarize(run.samples, seconds)
      writeFileSync(
        `${output}/${iteration + 1}.json`,
        JSON.stringify(run, null, 2),
      )
      const columns = [
        'phase',
        'role',
        'time',
        'pid',
        'start',
        'cpu',
        'percent',
        'rss',
        'footprint',
      ]
      writeFileSync(
        `${output}/${iteration + 1}.csv`,
        [
          columns.join(','),
          ...run.samples.map((r) =>
            columns.map((c) => r[c] ?? 'unavailable').join(','),
          ),
        ].join('\n'),
      )
      writeFileSync(`${output}/summary.json`, JSON.stringify(report, null, 2))
      writeFileSync(`${output}/report.md`, markdown(report))
    }
    console.log(`Run ${iteration + 1}: ${run.ok ? 'passed' : run.error}`)
  }
} catch (error) {
  report.error = String(error)
  if (!lease)
    report.eligibility.reasons = ['native-measurement-lease-unavailable']
  process.exitCode = 1
} finally {
  if (host) report.eligibility = await host.stop(report)
  if (report.eligibility.status !== 'eligible') process.exitCode = 1
  if (display) {
    try {
      report.displayCleanup = await display.stop()
    } catch (error) {
      report.error = String(error)
      process.exitCode = 1
    }
  }
  report.isolation.after = captureIsolation(isolationPolicy)
  report.isolation.result = isolationResult(
    report.isolation.before,
    report.isolation.after,
  )
  if (report.isolation.result.status !== 'unchanged') {
    report.error = [report.error, `Isolation ${report.isolation.result.status}`]
      .filter(Boolean)
      .join('; ')
    process.exitCode = 1
  }
  report.lifecycle = {
    status:
      report.runs.length === repeat && report.runs.every((run) => run.ok)
        ? 'complete'
        : 'incomplete',
    isolation: report.isolation.result.status,
  }
  if (
    lease &&
    report.runs.every(
      (run) =>
        run.cleanup.mainExited === true &&
        run.cleanup.driverClosed === true &&
        run.cleanup.webviewExited !== false,
    ) &&
    (!display || report.displayCleanup?.helperExited === true)
  ) {
    try {
      lease.release()
      report.measurementLeaseReleased = true
    } catch (error) {
      report.error = String(error)
      process.exitCode = 1
    }
  }
  writeFileSync(`${output}/summary.json`, JSON.stringify(report, null, 2))
  writeFileSync(`${output}/report.md`, markdown(report))
}
console.log(`Reports: ${output}`)
