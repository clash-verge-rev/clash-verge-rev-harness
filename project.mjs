import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, isAbsolute } from 'node:path'

export const toolRoot = import.meta.dirname
export const hash = (data) => createHash('sha256').update(data).digest('hex')
export function projectRoot(path) {
  if (!path || !isAbsolute(path))
    throw new Error('Pass --project with an absolute CVR checkout path')
  const root = realpathSync(path)
  for (const file of [
    'package.json',
    'scripts/perf/app.rs',
    'scripts/perf/vite.mts',
  ])
    readFileSync(resolve(root, file))
  return root
}
export function automation() {
  const require = createRequire(resolve(toolRoot, 'package.json'))
  const packages = ['@wdio/tauri-service', 'webdriverio', 'ws']
  return {
    load: (name) => import(require.resolve(name)),
    identity: Object.fromEntries(
      packages.map((name) => [
        name,
        JSON.parse(
          readFileSync(resolve(toolRoot, 'node_modules', name, 'package.json')),
        ).version,
      ]),
    ),
  }
}
export function harnessHash() {
  return hash(
    [
      'run.mjs',
      'report.mjs',
      'sample.c',
      'workload.mjs',
      'project.mjs',
      'package.json',
      'pnpm-lock.yaml',
      'artifacts.mjs',
      'display.mjs',
      'display.m',
      'isolation.mjs',
      'host.mjs',
    ]
      .map((path) => `${path}\0${hash(readFileSync(resolve(toolRoot, path)))}`)
      .join('\n'),
  )
}

export function gitHead(root) {
  const run = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  const head = run(['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (head.status === 0) return head.stdout.trim()
  if (head.status === 1) {
    const branch = run(['symbolic-ref', '--quiet', 'HEAD'])
    if (branch.status === 0) {
      const reference = run([
        'show-ref',
        '--verify',
        '--quiet',
        branch.stdout.trim(),
      ])
      if (reference.status === 1) return null
    }
  }
  throw new Error(
    head.error?.message || head.stderr.trim() || 'Cannot resolve Git HEAD',
  )
}
