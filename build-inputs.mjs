import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import { hash } from './project.mjs'

const command = (name, args, cwd, env = process.env) =>
  execFileSync(name, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim()
const inside = (root, path) => {
  const name = relative(root, path)
  return !name || (!name.startsWith('..') && !isAbsolute(name))
}
export function privateBuild(output) {
  if (realpathSync(output) !== output)
    throw new Error('Build output must have a canonical private path')
  const paths = Object.fromEntries(
    ['target', 'intermediates', 'frontend'].map((name) => [
      name,
      resolve(output, name),
    ]),
  )
  for (const path of Object.values(paths)) mkdirSync(path)
  return paths
}
export function buildEnvironment(project, paths, extra = {}) {
  for (const [key, value] of Object.entries(process.env))
    if (/RUSTFLAGS$/.test(key) && /incremental|out-dir|save-temps/.test(value))
      throw new Error(`External compiler output flags are unsupported: ${key}`)
  if (process.env.RUSTC || process.env.CARGO_BUILD_RUSTC)
    throw new Error(
      'Custom compiler overrides are unsupported; select the project rustup toolchain',
    )
  if (process.env.CARGO_BUILD_TARGET)
    throw new Error(
      'Configured Cargo build targets are unsupported; native host only',
    )
  return {
    ...process.env,
    ...extra,
    CARGO_BUILD_BUILD_DIR: paths.intermediates,
    CARGO_TARGET_DIR: paths.target,
    CARGO_INCREMENTAL: '0',
    CARGO_BUILD_INCREMENTAL: 'false',
    RUSTC_WRAPPER: '',
    RUSTC_WORKSPACE_WRAPPER: '',
    CARGO_BUILD_RUSTC_WRAPPER: '',
    CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: '',
    RUSTC: command('rustup', ['which', 'rustc'], project),
  }
}
export function cargoMetadata(project, packageName, features, paths) {
  const host = command('rustc', ['-vV'], project).match(/^host: (.+)$/m)?.[1]
  if (!host) throw new Error('Cannot determine native Cargo target')
  const args = [
    'metadata',
    '--format-version',
    '1',
    '--locked',
    '--offline',
    '--filter-platform',
    host,
  ]
  if (features.length) args.push('--features', features.join(','))
  const metadata = JSON.parse(
    command('cargo', args, project, buildEnvironment(project, paths)),
  )
  const root = metadata.packages.find(
    (p) => p.name === packageName && metadata.workspace_members.includes(p.id),
  )
  if (!root) throw new Error(`No workspace package: ${packageName}`)
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const reachable = new Set()
  const visit = (id) => {
    if (reachable.has(id)) return
    reachable.add(id)
    for (const dep of nodes.get(id)?.deps || []) visit(dep.pkg)
  }
  visit(root.id)
  return {
    host,
    packageId: root.id,
    metadata,
    local: metadata.packages.filter(
      (p) => reachable.has(p.id) && p.source === null,
    ),
  }
}
export function treeIdentity(root, excluded = []) {
  root = realpathSync(root)
  const files = []
  const visit = (directory, logical, ancestors) => {
    const canonical = realpathSync(directory)
    if (excluded.some((path) => inside(path, canonical))) return
    if (ancestors.includes(canonical))
      throw new Error(`Input symlink cycle: ${directory}`)
    const chain = [...ancestors, canonical]
    for (const name of readdirSync(directory).sort()) {
      if (name === '.git' || name === 'node_modules') continue
      const path = resolve(directory, name),
        key = logical ? `${logical}/${name}` : name
      const resolved = realpathSync(path)
      if (excluded.some((skip) => inside(skip, resolved))) continue
      const stat = lstatSync(path)
      if (
        stat.isDirectory() ||
        (stat.isSymbolicLink() && lstatSync(resolved).isDirectory())
      )
        visit(path, key, chain)
      else if (lstatSync(resolved).isFile())
        files.push([key, hash(readFileSync(path))])
      else throw new Error(`Unsupported build input: ${path}`)
    }
  }
  visit(root, '', [])
  return {
    sha256: hash(JSON.stringify(files)),
    files: files.length,
    entries: Object.fromEntries(files),
  }
}
export function captureGeneratedOutputs(paths) {
  return paths.map((path) => {
    path = resolve(path)
    let ancestor = path
    while (true) {
      try {
        lstatSync(ancestor)
        break
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        ancestor = dirname(ancestor)
      }
    }
    if (
      lstatSync(ancestor).isSymbolicLink() ||
      realpathSync(ancestor) !== ancestor
    )
      throw new Error(`Symlinked generated output: ${path}`)
    if (ancestor !== path) return { path, exists: false }
    if (!lstatSync(path).isFile())
      throw new Error(`Generated output is not a regular file: ${path}`)
    const bytes = readFileSync(path)
    return { path, exists: true, size: bytes.length, sha256: hash(bytes) }
  })
}
export function rootBuildOutput(execution, packageId) {
  const outputs = execution.buildScriptOutputs.filter(
    (output) => output.packageId === packageId,
  )
  if (outputs.length !== 1)
    throw new Error('Expected one root package build-script OUT_DIR')
  return outputs[0].outDir
}
export function captureBuildInputs(
  project,
  graph,
  output,
  generatedOutputPaths = [],
) {
  captureGeneratedOutputs(generatedOutputPaths)
  const excluded = [
    resolve(project, 'target'),
    graph.metadata.target_directory,
    graph.metadata.build_directory,
    output,
    ...generatedOutputPaths,
  ].map((path) => (existsSync(path) ? realpathSync(path) : resolve(path)))
  const roots = [
    ...new Set([
      project,
      ...graph.local.map((p) => realpathSync(dirname(p.manifest_path))),
    ]),
  ].sort()
  if (excluded.some((skip) => roots.some((root) => inside(skip, root))))
    throw new Error('Declared compiler output overlaps a local source root')
  const packages = graph.local
    .map((p) => ({
      name: p.name,
      version: p.version,
      manifest: realpathSync(p.manifest_path),
      root: realpathSync(dirname(p.manifest_path)),
    }))
    .sort((a, b) => a.manifest.localeCompare(b.manifest))
  const config = new Map()
  const addConfig = (path, kind) => {
    if (!existsSync(path)) return
    const canonical = realpathSync(path)
    const entry = config.get(canonical) || { kind, locations: [] }
    if (kind === 'cargo-configuration') entry.kind = kind
    if (!entry.locations.includes(path)) entry.locations.push(path)
    config.set(canonical, entry)
  }
  for (const root of roots) {
    for (let path = root; ; path = dirname(path)) {
      for (const name of ['Cargo.toml', '.cargo/config', '.cargo/config.toml'])
        addConfig(
          resolve(path, name),
          name === 'Cargo.toml' ? 'workspace-manifest' : 'cargo-configuration',
        )
      if (path === dirname(path)) break
    }
  }
  const cargoHome =
    process.env.CARGO_HOME || resolve(process.env.HOME, '.cargo')
  for (const name of ['config', 'config.toml'])
    addConfig(resolve(cargoHome, name), 'cargo-configuration')
  const configuration = [...config]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, entry]) => {
      const bytes = readFileSync(path)
      if (entry.kind === 'cargo-configuration') {
        if (
          /incremental\s*=|out-dir|save-temps|(?:^|[\s{,.])["']?(?:target|rustc|include)["']?\s*=/m.test(
            bytes.toString(),
          )
        )
          throw new Error(
            `Unsupported external compiler output or target setting: ${path}`,
          )
      }
      return {
        path,
        ...entry,
        locations: entry.locations.sort(),
        sha256: hash(bytes),
      }
    })
  const inputs = roots.map((root) => ({
    root,
    ...treeIdentity(root, excluded),
  }))
  const resolved = graph.metadata.packages
    .map((p) => ({ id: p.id, source: p.source, checksum: p.checksum || null }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return {
    packages,
    inputs,
    configuration,
    resolved,
    generatedOutputPaths,
    sha256: hash(
      JSON.stringify({
        packages,
        inputs,
        configuration,
        resolved,
        generatedOutputPaths,
      }),
    ),
  }
}
const checkPrivatePaths = (paths) => {
  for (const path of Object.values(paths))
    if (realpathSync(path) !== path || !lstatSync(path).isDirectory())
      throw new Error('Compiler output escaped its private directory')
}
export function nativeBuild(
  project,
  paths,
  packageName,
  features,
  host,
  extra = {},
) {
  checkPrivatePaths(paths)
  const args = [
    'build',
    '-p',
    packageName,
    '--release',
    '--locked',
    '--target-dir',
    paths.target,
    '--message-format',
    'json-render-diagnostics',
  ]
  if (features.length) args.push('--features', features.join(','))
  const env = buildEnvironment(project, paths, extra)
  const messages = execFileSync('cargo', args, {
    cwd: project,
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const buildScriptOutputs = messages
    .filter((message) => message.reason === 'build-script-executed')
    .map((message) => ({
      packageId: message.package_id,
      outDir: message.out_dir,
    }))
  for (const { outDir } of buildScriptOutputs)
    if (realpathSync(outDir) !== outDir || !inside(paths.intermediates, outDir))
      throw new Error('Build-script output escaped its private directory')
  checkPrivatePaths(paths)
  return {
    args,
    buildScriptOutputs,
    outputs: paths,
    compiler: {
      path: realpathSync(env.RUSTC),
      sha256: hash(readFileSync(env.RUSTC)),
      version: command(env.RUSTC, ['--version'], project),
    },
    environment: Object.fromEntries(
      Object.entries(env).filter(([key]) =>
        /^(RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTUP_TOOLCHAIN|CARGO_ENCODED_RUSTFLAGS|CARGO_TARGET_DIR|CARGO_BUILD_.*|CARGO_PROFILE_.*|CARGO_INCREMENTAL|CARGO_TARGET_[A-Z0-9_]+_(LINKER|RUSTFLAGS|RUNNER)|TAURI_CONFIG)$/.test(
          key,
        ),
      ),
    ),
    host,
    binaryDirectory: resolve(paths.target, 'release'),
  }
}
