import { isDeepStrictEqual } from 'node:util'

import { workload } from './workload.mjs'
import { hash } from './project.mjs'
import { validDisplayObservation, validDisplayReport } from './display.mjs'
import { validIsolation } from './isolation.mjs'

import { validEligibility } from './host.mjs'

export const SCHEMA = 'webview-replay-v9'
export const phases = ['foreground', 'hidden', 'restored']
export const roles = ['webview', 'main']
export const quantile = (values, p) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  const index = (v.length - 1) * p
  return (
    v[Math.floor(index)] +
    (v[Math.ceil(index)] - v[Math.floor(index)]) * (index % 1)
  )
}
export function delta(previous, next) {
  if (
    !previous ||
    previous.pid !== next.pid ||
    previous.start !== next.start ||
    ![previous.time, next.time, previous.cpu, next.cpu].every(
      Number.isFinite,
    ) ||
    next.time <= previous.time ||
    next.cpu < previous.cpu
  )
    return null
  return ((next.cpu - previous.cpu) / (next.time - previous.time)) * 100000
}
export function summarize(rows, seconds) {
  const output = {}
  for (const phase of phases)
    for (const role of roles) {
      const selected = rows.filter((r) => r.phase === phase && r.role === role)
      const samples = selected.map((r, i) => ({
        ...r,
        percent: delta(selected[i - 1], r),
        cpuDelta: i ? r.cpu - selected[i - 1].cpu : null,
      }))
      const valid = samples.filter((r) => Number.isFinite(r.percent))
      const memory = samples.map((r) => r.rss)
      const span =
        samples.length > 1 ? samples.at(-1).time - samples[0].time : 0
      const continuous =
        samples.length > 1 &&
        samples.every(
          (r) =>
            [r.time, r.cpu, r.rss, r.footprint].every(Number.isFinite) &&
            Number.isInteger(r.pid) &&
            r.pid > 0 &&
            /^\d+$/.test(r.start) &&
            r.time >= 0 &&
            r.cpu >= 0 &&
            r.rss > 0 &&
            r.footprint > 0,
        ) &&
        samples.every(
          (r, i) =>
            !i ||
            (r.time > samples[i - 1].time &&
              r.time - samples[i - 1].time < 2500 &&
              r.cpu >= samples[i - 1].cpu &&
              r.pid === samples[i - 1].pid &&
              r.start === samples[i - 1].start),
        )
      output[`${phase}/${role}`] = {
        count: samples.length,
        cpuCount: valid.length,
        missing: Math.max(0, Math.floor(seconds) - samples.length),
        coverage: Math.min(1, samples.length / seconds),
        continuous,
        observedSeconds: span / 1000,
        intervalCoverage: Math.min(1, span / ((seconds - 1) * 1000)),
        cpuMean: null,
        cpuP50: quantile(
          valid.map((r) => r.percent),
          0.5,
        ),
        cpuP95: quantile(
          valid.map((r) => r.percent),
          0.95,
        ),
        cpuPeak: quantile(
          valid.map((r) => r.percent),
          1,
        ),
        cpuSeconds: valid.length
          ? valid.reduce((sum, r) => sum + r.cpuDelta, 0)
          : null,
        footprintP50: quantile(
          samples.map((r) => r.footprint),
          0.5,
        ),
        footprintP95: quantile(
          samples.map((r) => r.footprint),
          0.95,
        ),
        footprintPeak: quantile(
          samples.map((r) => r.footprint),
          1,
        ),
        footprintDelta: continuous
          ? samples.at(-1).footprint - samples[0].footprint
          : null,
        rssP50: quantile(memory, 0.5),
        rssP95: quantile(memory, 0.95),
        rssPeak: quantile(memory, 1),
        rssDelta: continuous ? samples.at(-1).rss - samples[0].rss : null,
        rssSlopeBytesPerSecond:
          span >= 60000 && continuous
            ? (samples.at(-1).rss - samples[0].rss) / (span / 1000)
            : null,
      }
      output[`${phase}/${role}`].cpuMean =
        valid.length && span > 0
          ? (output[`${phase}/${role}`].cpuSeconds / span) * 100000
          : null
    }
  return output
}
export function replayValues(sequence) {
  return {
    up: 100000 + (sequence % 20) * 10000,
    down: 500000 + (sequence % 30) * 20000,
  }
}
export const validVisibility = (s) =>
  typeof s.hidden === 'boolean' &&
  (s.phase === 'hidden'
    ? s.visible === false && s.hidden
    : phases.includes(s.phase) &&
      s.visible === true &&
      !s.hidden &&
      s.occluded === false &&
      s.activeSpace === true)
export const validObservation = (s) =>
  !s.error &&
  validWorkload(s) &&
  validVisibility(s) &&
  validDisplayObservation(s) &&
  s.nativeFocused === false &&
  s.appActive === false &&
  s.top === true &&
  s.clickThrough === true &&
  [s.now, s.source, s.worker, s.draw].every(
    (v) => Number.isFinite(v) && v > 0,
  ) &&
  s.now >= s.source &&
  s.now - s.source < 2500 &&
  s.now >= s.worker &&
  s.now - s.worker < 3500 &&
  s.now >= s.draw &&
  (s.phase === 'hidden' || s.now - s.draw < 2500)
export function validWorkload(s) {
  if (!s) return false
  if (s.scenario === 'logs' || s.scenario === 'connections') {
    const subscriptions =
      s.scenario === 'logs' ? 1 : s.phase === 'hidden' ? 0 : 2
    return (
      Number.isInteger(s.received) &&
      s.received > 0 &&
      s.gaps === 0 &&
      (s.layer !== 'page' ||
        (s.subscriptions === subscriptions &&
          Number.isInteger(s.delivered) &&
          s.delivered >= 0))
    )
  }
  if (s.scenario && s.scenario !== 'traffic') return false
  const expected = replayValues(s.points)
  return (
    Number.isInteger(s.received) &&
    Number.isInteger(s.points) &&
    s.points > 0 &&
    s.received >= s.points &&
    s.received - s.points < 60 &&
    s.lastUp === expected.up &&
    s.lastDown === expected.down &&
    s.gaps === 0
  )
}
export function compare(a, b, threshold = null, adapterReview = null) {
  const stats = new Map()
  const text = (value) => typeof value === 'string' && value.length > 0
  const object = (value) =>
    value && typeof value === 'object' && !Array.isArray(value)
  const expectedMarks = [
    'ready',
    ...phases.flatMap((phase) => [phase, `${phase}:end`]),
  ]
  const valid = (x) =>
    x?.schema === SCHEMA &&
    !x.error &&
    validDisplayReport(x) &&
    validIsolation(x) &&
    validEligibility(x) &&
    x.lifecycle?.status === 'complete' &&
    x.measurementLeaseReleased === true &&
    x.build?.identityVersion === 2 &&
    x.build.buildInputs?.before?.packages?.length > 0 &&
    x.build.buildInputs.before.sha256 === x.build.buildInputs.after?.sha256 &&
    x.contract.samplingSchedule === 'absolute-one-second-slots-v1' &&
    text(x?.harnessSha256) &&
    [
      'head',
      'sourceSha256',
      'dependencySha256',
      'binarySha256',
      'frontendSha256',
      'buildSettingsSha256',
      'mode',
      'buildCommand',
      'binary',
      'toolchain',
    ].every((key) => text(x.build?.[key])) &&
    object(x.build.adapterFiles) &&
    Object.keys(x.build.adapterFiles).length > 0 &&
    Object.values(x.build.adapterFiles).every(text) &&
    x.build.adapterSha256 === hash(JSON.stringify(x.build.adapterFiles)) &&
    typeof x.build.dirty === 'string' &&
    object(x.build.buildEnvironment) &&
    [
      'method',
      'mode',
      'toolchain',
      'buildSettingsSha256',
      'platform',
      'machine',
      'arch',
      'host',
      'hardware',
      'power',
      'powerSource',
      'webkit',
      'replay',
      'automation',
    ].every((key) => text(x.contract?.[key])) &&
    object(x.contract.buildEnvironment) &&
    x.build.buildSettingsSha256 === x.contract.buildSettingsSha256 &&
    [
      'warmup',
      'intervalMs',
      'transitionSeconds',
      'readinessAllowanceSeconds',
    ].every((key) => Number.isFinite(x.contract[key]) && x.contract[key] > 0) &&
    validContract(x.contract) &&
    typeof x.contract.consoleLocked === 'boolean' &&
    x.contract.windowPolicy === 'nonactivating-top-click-through-v1' &&
    x.contract.rangeMinutes === 10 &&
    ['window', 'viewport'].every(
      (key) =>
        Array.isArray(x.contract[key]) &&
        x.contract[key].length === (key === 'window' ? 2 : 3) &&
        x.contract[key].every((v) => Number.isFinite(v) && v > 0),
    ) &&
    Number.isFinite(x.contract?.seconds) &&
    x.contract.seconds >= 5 &&
    Array.isArray(x.contract.phaseTargets) &&
    x.contract.phaseTargets.length === phases.length &&
    x.contract.phaseTargets.every((n) => Number.isInteger(n) && n > 0) &&
    Array.isArray(x.runs) &&
    x.runs.length &&
    x.runs.every((r) => {
      if (
        !r?.ok ||
        !Array.isArray(r.samples) ||
        !r.samples.every(
          (s) => s && roles.includes(s.role) && phases.includes(s.phase),
        ) ||
        !Array.isArray(r.marks) ||
        !r.marks.every((m) => m && typeof m.name === 'string')
      )
        return false
      stats.set(r, summarize(r.samples, x.contract.seconds))
      return (
        (x.contract.scenario === 'traffic' ||
          (r.recovery?.stopped === r.recovery?.idle &&
            r.recovery?.resumed >= r.recovery?.idle + 2)) &&
        r.cleanup?.mainExited &&
        r.cleanup?.driverClosed &&
        r.cleanup?.webviewExited &&
        Array.isArray(r.consoleStates) &&
        r.consoleStates.length === expectedMarks.length &&
        r.consoleStates.every(
          (s, i) =>
            s &&
            s.name === (i ? expectedMarks[i] : 'initial') &&
            typeof s.locked === 'boolean' &&
            Number.isFinite(s.time) &&
            s.time > 0 &&
            (!i || s.time >= r.consoleStates[i - 1].time),
        ) &&
        Number.isInteger(r.replay?.sent) &&
        r.replay.sent > 0 &&
        Number.isFinite(r.replay.maxLateMs) &&
        r.replay.maxLateMs >= 0 &&
        r.replay.maxLateMs < x.contract.replayMs &&
        !r.replay.error &&
        r.actualWarmupMs >= x.contract.warmup * 1000 &&
        Array.isArray(r.observations) &&
        r.observations.length > 0 &&
        r.observations.every(
          (s, i) =>
            validObservation(s) &&
            s.displayMode === x.contract.display.mode &&
            (s.displayMode !== 'virtual' ||
              s.expectedDisplayID === x.displayOwner.displayID) &&
            (s.scenario ?? 'traffic') === x.contract.scenario &&
            (s.layer ?? 'component') === x.contract.layer &&
            (!i || s.now > r.observations[i - 1].now),
        ) &&
        r.marks.length === expectedMarks.length &&
        r.marks.every(
          (m, i) =>
            m.name === expectedMarks[i] &&
            Number.isFinite(m.time) &&
            m.time > 0 &&
            (!i ||
              ((m.scenario ?? 'traffic') === x.contract.scenario &&
                (m.layer ?? 'component') === x.contract.layer &&
                validObservation({ ...m, phase: m.name.split(':')[0] }) &&
                m.displayMode === x.contract.display.mode &&
                (m.displayMode !== 'virtual' ||
                  m.expectedDisplayID === x.displayOwner.displayID) &&
                /^[a-f0-9]{64}$/.test(m.pixelsSha256))) &&
            (!phases.includes(m.name) ||
              (m.target === x.contract.phaseTargets[phases.indexOf(m.name)] &&
                m.received === m.target)) &&
            (!i || m.time > r.marks[i - 1].time),
        ) &&
        roles.every((role) =>
          r.samples
            .filter((s) => s.role === role)
            .every(
              (s, i, rows) =>
                !i ||
                (s.pid === rows[i - 1].pid &&
                  s.start === rows[i - 1].start &&
                  s.time > rows[i - 1].time &&
                  s.cpu >= rows[i - 1].cpu &&
                  phases.indexOf(s.phase) >= phases.indexOf(rows[i - 1].phase)),
            ),
        ) &&
        validStats(stats.get(r)) &&
        phases.every((phase) => {
          const start = r.marks.find((m) => m.name === phase)
          const end = r.marks.find((m) => m.name === `${phase}:end`)
          const observed = r.observations.filter((s) => s.phase === phase)
          return (
            start &&
            end &&
            observed.length > 0 &&
            [
              start.deadlineIndex,
              end.deadlineIndex,
              start.senderSent,
              end.senderSent,
            ].every((n) => Number.isInteger(n) && n >= 0) &&
            end.deadlineIndex > start.deadlineIndex &&
            end.senderSent >= start.senderSent &&
            end.senderSent <= r.replay.sent &&
            start.senderSent >= start.received &&
            end.senderSent >= end.received &&
            Math.abs(
              end.received -
                start.received -
                (end.deadlineIndex - start.deadlineIndex),
            ) <= 2 &&
            observed.every(
              (s) =>
                s.now >= start.now &&
                s.now <= end.now &&
                s.received >= start.received &&
                s.received <= end.received,
            ) &&
            validDelivery(start, end, phase) &&
            end.worker > start.worker &&
            (phase === 'hidden' ||
              (end.draw > start.draw &&
                end.pixelsSha256 !== start.pixelsSha256))
          )
        })
      )
    })
  const groups = [a, b].map((input) => (Array.isArray(input) ? input : [input]))
  if (
    groups.some((group) =>
      group.some(
        (report) =>
          report?.schema === SCHEMA &&
          report?.eligibility?.status === 'excluded',
      ),
    )
  )
    return {
      verdict: 'ineligible',
      reason:
        'performance sample excluded; retained observations and reasons must be inspected',
      exclusions: groups
        .flat()
        .filter((report) => report?.eligibility?.status === 'excluded')
        .map((report) => report.eligibility.reasons),
    }
  if (groups.some((group) => !group.length || !group.every(valid)))
    return { verdict: 'invalid', reason: 'failed, malformed or missing runs' }
  if (
    groups.some((group) =>
      group
        .slice(1)
        .some(
          (report) =>
            report.build.binarySha256 !== group[0].build.binarySha256 ||
            ['invalid', 'incomparable', 'ineligible'].includes(
              compare(group[0], report).verdict,
            ),
        ),
    )
  )
    return {
      verdict: 'invalid',
      reason: 'group contains mixed builds, contracts, or invalid runs',
    }
  ;[a, b] = groups.map((group) => ({
    ...group[0],
    runs: group.flatMap((report) => report.runs),
  }))
  if (
    [a, b].some((x) =>
      x.runs.some((r) =>
        r.consoleStates.some((s) => s.locked !== x.contract.consoleLocked),
      ),
    )
  )
    return {
      verdict: 'incomparable',
      reason: 'console lock state changed at observed boundaries',
    }
  if (
    a.contract.isolation.baselineSha256 !== b.contract.isolation.baselineSha256
  )
    return {
      verdict: 'incomparable',
      reason: 'watched configuration, processes, proxy or DNS baseline differs',
    }
  if (
    !isDeepStrictEqual(a.contract, b.contract) ||
    ['mode', 'buildCommand', 'toolchain', 'buildEnvironment'].some(
      (key) => !isDeepStrictEqual(a.build[key], b.build[key]),
    ) ||
    a.harnessSha256 !== b.harnessSha256
  )
    return {
      verdict: 'incomparable',
      reason: 'harness, platform, build mode, workload or environment differ',
    }
  if (
    a.build.adapterSha256 !== b.build.adapterSha256 &&
    (typeof adapterReview !== 'string' || !adapterReview.trim())
  )
    return {
      verdict: 'incomparable',
      reason:
        'adapter differs; review changed sources and pass --adapter-review with rationale and evidence',
    }
  for (const phase of phases) {
    for (const name of [phase, `${phase}:end`]) {
      const sizes = [a, b].map((x) =>
        x.runs.map((r) => r.marks.find((m) => m.name === name)?.received),
      )
      if (!sizes.flat().every(Number.isFinite))
        return { verdict: 'invalid', reason: 'missing observed workload size' }
      if (
        Math.abs(quantile(sizes[0], 0.5) - quantile(sizes[1], 0.5)) > 2 ||
        sizes.some((s) => Math.max(...s) - Math.min(...s) > 2)
      )
        return {
          verdict: 'incomparable',
          reason: `${name}: input size varies by more than two replay points`,
        }
    }
  }
  const same = a.build.binarySha256 === b.build.binarySha256
  const enough = a.runs.length >= 3 && b.runs.length >= 3
  const metrics = {}
  for (const phase of phases)
    for (const role of roles)
      for (const metric of ['cpuMean', 'rssP50', 'footprintP50']) {
        const key = `${phase}/${role}`
        const av = a.runs.map((r) => stats.get(r)[key][metric])
        const bv = b.runs.map((r) => stats.get(r)[key][metric])
        const before = quantile(av, 0.5),
          after = quantile(bv, 0.5)
        const noise = Math.max(...av) - Math.min(...av)
        const candidateRange = Math.max(...bv) - Math.min(...bv)
        const overlap =
          Math.max(...av) >= Math.min(...bv) &&
          Math.max(...bv) >= Math.min(...av)
        metrics[`${key}/${metric}`] = {
          before,
          after,
          delta: after - before,
          baselineRange: noise,
          candidateRange,
          verdict:
            same ||
            !enough ||
            threshold === null ||
            !av.every(Number.isFinite) ||
            !bv.every(Number.isFinite) ||
            overlap ||
            Math.abs(after - before) <=
              Math.max(
                noise,
                candidateRange,
                (Math.abs(before) * threshold) / 100,
              )
              ? 'inconclusive'
              : after < before
                ? 'lower'
                : 'higher',
        }
      }
  return {
    verdict: 'inconclusive',
    kind: same ? 'A/A' : 'A/B',
    reason: same
      ? 'same binary; natural variation only'
      : 'inspect independent-run metrics; no universal pass threshold',
    metrics,
  }
}
export function markdown(report) {
  const lines = [
    `# ${report.contract.scenario} / ${report.contract.layer} - replay measurement`,
    '',
    `Transport: ${report.contract.transport}. Allocator: ${report.contract.allocator}. Profile: ${report.contract.profile}; source interval ${report.contract.replayMs} ms.`,
    '',
    `Lifecycle phases complete: ${report.runs.filter((r) => r.ok).length}/${report.runs.length}. Performance eligibility: ${report.eligibility?.status ?? 'unavailable'}; reasons: ${report.eligibility?.reasons?.join(', ') || 'none'}.`,
    '',
    'Host CPU/load/memory pressure describe whole-host capacity, including the candidate. Build-process presence is a separate conservative exclusion and does not prove load intensity or causation. Zero automatic retries; excluded raw attempts are retained. No benefit conclusion is available from ineligible samples.',
    '',
    'CPU: one fully occupied core = 100%. Memory: RSS and physical footprint are separate process byte counts, not exclusive ownership. Null = unavailable; first CPU observation has no delta. Slope requires 60 seconds of continuous observations.',
    '',
    '| Run / stage / role | CPU mean / P50 / P95 / peak (%) | CPU s | RSS P50 / P95 / peak / delta (bytes) | Footprint P50 / P95 / peak / delta (bytes) | Samples / coverage |',
    '|---|---|---|---|---|---|',
  ]
  for (const [i, run] of report.runs.entries()) {
    if (run.error) lines.push(`\nRun ${i + 1} failed: ${run.error}\n`)
    for (const [key, s] of Object.entries(run.stats))
      lines.push(
        `| ${i + 1}/${key} | ${[s.cpuMean, s.cpuP50, s.cpuP95, s.cpuPeak].map((v) => v?.toFixed(2) ?? 'unavailable').join(' / ')} | ${s.cpuSeconds?.toFixed(3) ?? 'unavailable'} | ${[s.rssP50, s.rssP95, s.rssPeak, s.rssDelta].map((v) => v ?? 'unavailable').join(' / ')} | ${[s.footprintP50, s.footprintP95, s.footprintPeak, s.footprintDelta].map((v) => v ?? 'unavailable').join(' / ')} | ${s.count} / ${(s.coverage * 100).toFixed(1)}% |`,
      )
  }
  lines.push(
    '',
    `Isolation: ${report.isolation?.result?.status ?? 'pending'}; prior baseline not assessed. Boundary snapshots do not provide continuous monitoring or identify who changed state.`,
  )
  lines.push(
    '',
    'Scope: page = production page/hooks with a JavaScript transport adapter; component = production rendering components with fixtures; DOM = fixed text rows without React. Traffic retains its append-boundary Worker/Canvas path. No Mihomo Core or native Mihomo plugin IPC is measured. Hidden Connections may unsubscribe while the source continues. Shared GPU/network processes are excluded. Memory growth alone is not proof of a leak.',
    '',
    'Next measurement: use WebKit CPU sampling for the highest-CPU foreground/restored phase; use Allocation/Heap captures for repeatable RSS growth. React Compiler is an untested local A/B candidate only.',
  )
  return lines.join('\n') + '\n'
}
export const validStats = (stats) =>
  Object.values(stats).every(
    (s) =>
      s.continuous &&
      s.coverage >= 0.8 &&
      s.intervalCoverage >= 0.8 &&
      s.cpuCount >= 3,
  )

function validContract(contract) {
  try {
    const expected = workload(
      contract.scenario,
      contract.layer,
      contract.profile,
    )
    return (
      Object.entries(expected).every(
        ([key, value]) => contract[key] === value,
      ) && ['default', 'diagnostic-malloc'].includes(contract.allocator)
    )
  } catch {
    return false
  }
}

export function validDelivery(start, end, phase) {
  if (start.layer !== 'page') return true
  return start.scenario === 'connections' && phase === 'hidden'
    ? end.delivered === start.delivered
    : end.delivered > start.delivered
}
