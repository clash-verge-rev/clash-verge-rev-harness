import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  lstatSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { dirname, resolve, relative, isAbsolute } from 'node:path'

import { assertBuildNotLeased } from './host.mjs'

const marker = '.perf-owner.json'
export function createArtifacts(project, path, kind) {
  const root = realpathSync(project)
  const output = resolve(path)
  const relativePath = relative(resolve(root, 'target/perf'), output)
  if (
    !relativePath ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath)
  )
    throw new Error('Artifacts must be a new directory below target/perf')
  let existing = dirname(output)
  while (true) {
    try {
      if (realpathSync(existing) !== existing)
        throw new Error('Symlinked artifact parent')
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      existing = dirname(existing)
    }
  }
  execFileSync('git', ['check-ignore', '-q', '--no-index', output], {
    cwd: root,
  })
  mkdirSync(dirname(output), { recursive: true })
  if (realpathSync(dirname(output)) !== dirname(output))
    throw new Error('Symlinked artifact parent')
  mkdirSync(output)
  writeFileSync(
    `${output}/${marker}`,
    JSON.stringify({
      version: 1,
      root,
      path: output,
      kind,
      owner: process.pid,
    }),
  )
  return output
}
export function cleanArtifacts(project, path) {
  const output = resolve(path)
  if (lstatSync(output).isSymbolicLink() || realpathSync(output) !== output)
    throw new Error('Refuse symlinked artifact directory')
  const owner = JSON.parse(readFileSync(`${output}/${marker}`, 'utf8'))
  const root = realpathSync(project)
  const relativePath = relative(resolve(root, 'target/perf'), output)
  if (
    owner.version !== 1 ||
    owner.path !== output ||
    owner.root !== root ||
    !relativePath ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath)
  )
    throw new Error('Not an owned artifact directory in this checkout')
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (error.code === 'ESRCH') return false
      throw error
    }
  }
  if (alive(owner.owner)) throw new Error('Artifact owner is still running')
  for (const name of readdirSync(output).filter(
    (name) =>
      /^child-\d+(?:-webview)?\.json$/.test(name) ||
      name === 'display-owner.json',
  )) {
    const child = JSON.parse(readFileSync(`${output}/${name}`, 'utf8'))
    if (alive(child.pid))
      throw new Error(
        'Recorded child PID is still live; inspect ownership first',
      )
  }
  assertBuildNotLeased(output)
  rejectDependencyLinks(root, output)
  rmSync(output, { recursive: true })
}

function rejectDependencyLinks(root, output) {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) {
        let destination
        try {
          destination = realpathSync(path)
        } catch (error) {
          if (error.code === 'ENOENT') continue
          throw error
        }
        const within = relative(output, destination)
        if (!within || (!within.startsWith('..') && !isAbsolute(within)))
          throw new Error(`Dependency link points into artifacts: ${path}`)
      } else if (entry.isDirectory()) visit(path)
    }
  }
  visit(resolve(root, 'node_modules'))
}
