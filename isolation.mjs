import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { hash } from './project.mjs'

export const isolationMethod = 'command-boundaries-config-ps-start-utc-v1'
const fields = ['configuration', 'processes', 'proxy', 'dns']
const digest = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const observe = (read) => {
  try {
    return { value: read() }
  } catch (error) {
    return {
      error: String(
        error.code ??
          (error.status !== undefined ? 'command-failed' : error.message),
      ),
    }
  }
}

export function captureIsolation(policy) {
  const configuration = observe(() => {
    const roots = [],
      files = []
    const visit = (path, descend) => {
      const absolute = join(homedir(), path)
      for (const entry of readdirSync(absolute, { withFileTypes: true }).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        const name = join(path, entry.name),
          file = join(homedir(), name)
        if (entry.isSymbolicLink()) {
          if (
            descend ||
            policy.configDirectories.includes(entry.name) ||
            policy.configExtensions.includes(extname(entry.name))
          )
            throw new Error('Configuration symlink unavailable')
          continue
        }
        if (entry.isDirectory()) {
          if (descend || policy.configDirectories.includes(entry.name))
            visit(name, true)
        } else if (
          entry.isFile() &&
          policy.configExtensions.includes(extname(entry.name))
        ) {
          const before = lstatSync(file),
            sha256 = hash(readFileSync(file)),
            after = lstatSync(file)
          if (
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs
          )
            throw new Error('Configuration changed during snapshot')
          files.push({
            path: name,
            sha256,
            mtimeMs: after.mtimeMs,
            size: after.size,
          })
        }
      }
    }
    for (const path of policy.configRoots) {
      let state
      try {
        state = lstatSync(join(homedir(), path))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (state && (!state.isDirectory() || state.isSymbolicLink()))
        throw new Error('Configuration root unavailable')
      roots.push({ path, exists: !!state })
      if (state) visit(path, false)
    }
    return { roots, files }
  })
  const processes = observe(() =>
    execFileSync('/bin/ps', ['-axo', 'pid=,lstart=,comm='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    })
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        const row = line.match(/^\s*(\d+)\s+(.{24})\s+(.+)$/)
        if (!row) throw new Error('Process inventory unavailable')
        const role = Object.keys(policy.processNames).find(
          (name) => policy.processNames[name] === basename(row[3]),
        )
        return role
          ? [{ role, pid: Number(row[1]), start: row[2], executable: row[3] }]
          : []
      })
      .sort((a, b) => a.pid - b.pid),
  )
  const system = (option) =>
    observe(() => hash(execFileSync('/usr/sbin/scutil', [option])))
  return {
    at: Date.now(),
    configuration,
    processes,
    proxy: system('--proxy'),
    dns: system('--dns'),
  }
}

export function isolationBaseline(snapshot) {
  if (
    !snapshot ||
    !Number.isFinite(snapshot.at) ||
    snapshot.at <= 0 ||
    fields.some(
      (field) =>
        !snapshot[field] ||
        snapshot[field].error ||
        snapshot[field].value === undefined,
    )
  )
    return null
  const config = snapshot.configuration.value
  if (!config || typeof config !== 'object' || Array.isArray(config))
    return null
  const { roots, files } = config
  if (
    !Array.isArray(roots) ||
    !roots.length ||
    !roots.every(
      (r) => r && typeof r.path === 'string' && typeof r.exists === 'boolean',
    ) ||
    !Array.isArray(files) ||
    !files.every(
      (f) =>
        f &&
        typeof f.path === 'string' &&
        digest(f.sha256) &&
        Number.isFinite(f.mtimeMs) &&
        f.mtimeMs >= 0 &&
        Number.isInteger(f.size) &&
        f.size >= 0,
    )
  )
    return null
  if (
    !Array.isArray(snapshot.processes.value) ||
    !snapshot.processes.value.every(
      (p) =>
        p &&
        typeof p.role === 'string' &&
        Number.isInteger(p.pid) &&
        p.pid > 0 &&
        typeof p.start === 'string' &&
        p.start.length === 24 &&
        typeof p.executable === 'string' &&
        p.executable.startsWith('/'),
    ) ||
    !digest(snapshot.proxy.value) ||
    !digest(snapshot.dns.value)
  )
    return null
  return hash(
    JSON.stringify(
      Object.fromEntries(fields.map((field) => [field, snapshot[field].value])),
    ),
  )
}

export function isolationResult(before, after) {
  const baselines = {
    before: isolationBaseline(before),
    after: isolationBaseline(after),
  }
  const available =
    baselines.before !== null &&
    baselines.after !== null &&
    after.at >= before.at
  return {
    priorBaseline: 'not-assessed',
    status: !available
      ? 'unavailable'
      : baselines.before === baselines.after
        ? 'unchanged'
        : 'changed',
    changed: available
      ? fields.filter(
          (field) =>
            !isDeepStrictEqual(before[field].value, after[field].value),
        )
      : [],
    unavailable: ['before', 'after']
      .flatMap((stage) => {
        const snapshot = { before, after }[stage]
        if (baselines[stage] !== null) return []
        const missing = fields.filter(
          (field) => !snapshot?.[field] || snapshot[field].error,
        )
        return missing.length
          ? missing.map((field) => `${stage}.${field}`)
          : [stage]
      })
      .concat(before?.at > after?.at ? ['time-order'] : []),
  }
}

export function validIsolation(report) {
  const state = report.isolation
  return (
    state &&
    report.contract?.isolation?.method === isolationMethod &&
    digest(report.contract.isolation.policySha256) &&
    report.contract.isolation.baselineSha256 ===
      isolationBaseline(state.before) &&
    state.result?.status === 'unchanged' &&
    isDeepStrictEqual(state.result, isolationResult(state.before, state.after))
  )
}
