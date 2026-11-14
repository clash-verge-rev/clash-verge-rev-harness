import { spawn, execFileSync } from 'node:child_process'
import {
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  realpathSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

import { hash, toolRoot } from './project.mjs'

const overlap = (a, b) =>
  a[0] < b[0] + b[2] &&
  a[0] + a[2] > b[0] &&
  a[1] < b[1] + b[3] &&
  a[1] + a[3] > b[1]
const rect = (value) =>
  Array.isArray(value) &&
  value.length === 4 &&
  value.every(Number.isFinite) &&
  value[2] > 0 &&
  value[3] > 0
export const validTopology = (screens) =>
  Array.isArray(screens) &&
  screens.length > 0 &&
  new Set(screens.map((s) => s?.id)).size === screens.length &&
  screens.every(
    (s) =>
      Number.isInteger(s?.id) &&
      s.id > 0 &&
      typeof s.main === 'boolean' &&
      typeof s.mirrored === 'boolean' &&
      s.online === true &&
      [s.bounds, s.frame, s.visibleFrame].every(rect) &&
      Number.isFinite(s.scale) &&
      s.scale > 0 &&
      Number.isFinite(s.refreshHz) &&
      s.refreshHz >= 0 &&
      [s.logical, s.pixels].every(
        (v) =>
          Array.isArray(v) &&
          v.length === 2 &&
          v.every((n) => Number.isFinite(n) && n > 0),
      ),
  )
export function validDisplayOwner(owner) {
  if (
    !owner ||
    owner.valid !== true ||
    owner.nonoverlap !== true ||
    !Number.isInteger(owner.displayID) ||
    owner.displayID <= 0 ||
    !validTopology(owner.before) ||
    !validTopology(owner.during)
  )
    return false
  const screen = owner.during.find((s) => s.id === owner.displayID)
  return (
    !owner.before.some((s) => s.id === owner.displayID) &&
    isDeepStrictEqual(
      owner.before,
      owner.during.filter((s) => s.id !== owner.displayID),
    ) &&
    screen?.main === false &&
    screen?.mirrored === false &&
    screen?.online === true &&
    screen?.scale === 2 &&
    Math.abs(screen?.refreshHz - 60) < 0.01 &&
    isDeepStrictEqual(screen?.logical, [1280, 900]) &&
    isDeepStrictEqual(screen?.pixels, [2560, 1800]) &&
    owner.before.every((s) => !overlap(s.bounds, screen.bounds)) &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.start === 'string' &&
    /^\d+$/.test(owner.start) &&
    typeof owner.executable === 'string' &&
    /^[a-f0-9]{64}$/.test(owner.executableSha256)
  )
}

export async function startDisplay(output, sampler) {
  const binary = resolve(output, 'display-helper')
  execFileSync('clang', [
    '-fobjc-arc',
    '-O2',
    '-Wall',
    '-Wextra',
    resolve(toolRoot, 'display.m'),
    '-framework',
    'AppKit',
    '-framework',
    'CoreGraphics',
    '-o',
    binary,
  ])
  const inventory = () =>
    JSON.parse(
      execFileSync(binary, ['--inventory'], {
        encoding: 'utf8',
        timeout: 10000,
      }),
    ).screens
  const before = inventory()
  if (!validTopology(before))
    throw new Error('Complete original display topology unavailable')
  writeFileSync(
    resolve(output, 'display-before.json'),
    JSON.stringify(before, null, 2),
  )
  const executable = realpathSync(binary),
    executableSha256 = hash(readFileSync(binary))
  const log = openSync(resolve(output, 'display-helper.log'), 'w')
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', log] })
  closeSync(log)
  const exited = new Promise((done) => child.once('exit', done))
  let owner, identity, error
  child.on('error', (e) => {
    error = e
  })
  const sample = () => {
    const row = execFileSync(sampler, [String(child.pid)], { encoding: 'utf8' })
      .trim()
      .split(' ')
    return {
      pid: Number(row[0]),
      start: row[1],
      executable: row.slice(5).join(' '),
    }
  }
  const alive = () =>
    !error && child.exitCode === null && child.signalCode === null
  const verify = () => {
    if (!alive())
      throw new Error(
        `Owned display helper exited: ${error ?? child.exitCode ?? child.signalCode}`,
      )
    const actual = sample()
    if (
      !identity ||
      !isDeepStrictEqual(actual, identity) ||
      actual.executable !== executable ||
      hash(readFileSync(binary)) !== executableSha256
    )
      throw new Error('Owned display helper PID/start/executable mismatch')
  }
  const stop = async () => {
    let exitedBeforeRequest = !alive()
    if (alive()) {
      if (identity) {
        try {
          verify()
        } catch (failure) {
          await Promise.race([exited, sleep(100)])
          if (alive()) throw failure
          exitedBeforeRequest = true
        }
      }
      if (alive()) child.stdin.end()
      await Promise.race([exited, sleep(5000)])
      if (alive()) {
        verify()
        child.kill('SIGTERM')
        await Promise.race([exited, sleep(5000)])
      }
      if (alive()) throw new Error('Owned display helper did not exit')
    }
    let after
    const deadline = Date.now() + 10000
    do {
      after = inventory()
      if (isDeepStrictEqual(before, after)) break
      await sleep(100)
    } while (Date.now() < deadline)
    const cleanup = {
      helperExited: !alive(),
      exitedBeforeRequest,
      topologyRestored: isDeepStrictEqual(before, after),
      before,
      after,
    }
    writeFileSync(
      resolve(output, 'display-cleanup.json'),
      JSON.stringify(cleanup, null, 2),
    )
    if (
      exitedBeforeRequest ||
      !cleanup.helperExited ||
      !cleanup.topologyRestored
    )
      throw new Error(
        'Virtual display cleanup did not restore original topology',
      )
    return cleanup
  }
  try {
    identity = sample()
    verify()
    let text = ''
    const ready = new Promise((done, reject) => {
      child.stdout.on('data', (data) => {
        text += data.toString()
        const newline = text.indexOf('\n')
        if (newline < 0) return
        try {
          done(JSON.parse(text.slice(0, newline)))
        } catch (e) {
          reject(e)
        }
      })
      child.once('error', reject)
      child.once('exit', () =>
        reject(new Error('Virtual display helper exited before readiness')),
      )
    })
    child.stdin.write('C')
    const created = await Promise.race([
      ready,
      sleep(15000).then(() => {
        throw new Error('Virtual display readiness timeout')
      }),
    ])
    if (created.pid !== identity.pid)
      throw new Error('Helper creation PID does not match owned process')
    owner = { ...created, ...identity, executableSha256 }
    writeFileSync(
      resolve(output, 'display-owner.json'),
      JSON.stringify(owner, null, 2),
    )
    if (!validDisplayOwner(owner) || !isDeepStrictEqual(before, owner.before))
      throw new Error(
        'Owned virtual display creation or physical topology invalid',
      )
    verify()
    return { owner, verify, stop }
  } catch (e) {
    try {
      await stop()
    } catch (cleanup) {
      throw new AggregateError(
        [e, cleanup],
        'Display startup and cleanup failed',
        { cause: cleanup },
      )
    }
    throw e
  }
}

export const virtualDisplayContract = {
  mode: 'virtual',
  logical: [1280, 900],
  pixels: [2560, 1800],
  scale: 2,
  refreshHz: 60,
  spaces: 'join-all-without-move',
}
export function validDisplayObservation(s) {
  if (s.displayMode === 'physical')
    return s.virtualScreen === null && s.expectedDisplayID === null
  const v = s.virtualScreen
  if (
    s.displayMode !== 'virtual' ||
    !v ||
    !Number.isInteger(v.id) ||
    v.id <= 0 ||
    v.id !== s.expectedDisplayID ||
    v.main !== false ||
    v.mirrored !== false ||
    v.scale !== 2 ||
    !Number.isFinite(v.refreshHz) ||
    Math.abs(v.refreshHz - 60) > 0.01 ||
    !Number.isInteger(v.collectionBehavior) ||
    (v.collectionBehavior & 1) !== 1 ||
    (v.collectionBehavior & 2) !== 0 ||
    v.contained !== true ||
    !isDeepStrictEqual(v.logical, [1280, 900]) ||
    !isDeepStrictEqual(v.pixels, [2560, 1800]) ||
    ![v.frame, v.visibleFrame, v.windowFrame, s.expectedDisplayFrame].every(
      (r) =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every(Number.isFinite) &&
        r[2] > 0 &&
        r[3] > 0,
    ) ||
    !isDeepStrictEqual(v.frame, s.expectedDisplayFrame) ||
    v.frame[2] !== 1280 ||
    v.frame[3] !== 900
  )
    return false
  const [x, y, w, h] = v.windowFrame,
    [sx, sy, sw, sh] = v.visibleFrame
  return x >= sx && y >= sy && x + w <= sx + sw && y + h <= sy + sh
}
export function validDisplayReport(report) {
  if (report.contract?.display?.mode === 'physical')
    return (
      isDeepStrictEqual(report.contract.display, { mode: 'physical' }) &&
      !report.displayOwner
    )
  const owner = report.displayOwner,
    cleanup = report.displayCleanup
  return (
    isDeepStrictEqual(report.contract?.display, virtualDisplayContract) &&
    validDisplayOwner(owner) &&
    cleanup?.helperExited === true &&
    cleanup?.exitedBeforeRequest === false &&
    cleanup?.topologyRestored === true &&
    isDeepStrictEqual(cleanup.before, owner.before) &&
    isDeepStrictEqual(cleanup.after, owner.before)
  )
}
