import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { createArtifacts } from './artifacts.mjs'
import {
  captureBuildInputs,
  cargoMetadata,
  nativeBuild,
  privateBuild,
  treeIdentity,
} from './build-inputs.mjs'
import { hash, projectRoot, toolRoot, gitHead } from './project.mjs'
const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    output: { type: 'string', default: 'target/perf/build' },
  },
})
const project = projectRoot(values.project)
const output = resolve(project, values.output)
const command = (cmd, args, cwd = project) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim()
createArtifacts(project, output, 'build')
const paths = privateBuild(output)
const graph = cargoMetadata(project, 'clash-verge', ['perf-harness'], paths)
const before = captureBuildInputs(project, graph, output)
const toolBefore = treeIdentity(toolRoot, [resolve(toolRoot, 'target/perf')])
const adapterFiles = Object.fromEntries(
  readdirSync(resolve(project, 'scripts/perf'))
    .filter((path) => /\.(rs|ts|tsx|html|mts|json)$/.test(path))
    .sort()
    .map((path) => [
      path,
      hash(readFileSync(resolve(project, 'scripts/perf', path))),
    ]),
)
const configuration = JSON.parse(
  readFileSync(resolve(project, 'scripts/perf/tauri.json'), 'utf8'),
)
const actualConfiguration = {
  ...configuration,
  build: { ...configuration.build, frontendDist: paths.frontend },
}
const viteArgs = [
  'exec',
  'vite',
  'build',
  '--mode',
  'perf',
  '--config',
  'scripts/perf/vite.mts',
  '--outDir',
  paths.frontend,
]
execFileSync('pnpm', viteArgs, { cwd: project, stdio: 'inherit' })
const execution = nativeBuild(
  project,
  paths,
  'clash-verge',
  ['perf-harness'],
  graph.host,
  { TAURI_CONFIG: JSON.stringify(actualConfiguration) },
)
const after = captureBuildInputs(
  project,
  cargoMetadata(project, 'clash-verge', ['perf-harness'], paths),
  output,
)
if (
  before.sha256 !== after.sha256 ||
  toolBefore.sha256 !==
    treeIdentity(toolRoot, [resolve(toolRoot, 'target/perf')]).sha256
)
  throw new Error(
    'Candidate, local dependency, build configuration or harness changed during build; refuse manifest',
  )
const binary = resolve(output, 'clash-verge')
copyFileSync(resolve(execution.binaryDirectory, 'clash-verge'), binary)
const buildCommand =
  'pnpm exec vite build --mode perf --config scripts/perf/vite.mts --outDir <owned>/frontend; cargo build -p clash-verge --release --locked --target-dir <owned>/target --features perf-harness; CARGO_BUILD_BUILD_DIR=<owned>/intermediates'
const buildEnvironment = {
  ...execution.environment,
  CARGO_TARGET_DIR: '<owned>/target',
  CARGO_BUILD_BUILD_DIR: '<owned>/intermediates',
  TAURI_CONFIG: JSON.stringify({
    ...configuration,
    build: { ...configuration.build, frontendDist: '<owned>/frontend' },
  }),
}
writeFileSync(
  `${binary}.json`,
  JSON.stringify(
    {
      identityVersion: 2,
      project,
      head: gitHead(project),
      dirty: command('git', ['status', '--porcelain']),
      sourceSha256: before.inputs.find((input) => input.root === project)
        .sha256,
      buildInputs: { before, after },
      harnessSource: {
        head: gitHead(toolRoot),
        dirty: command('git', ['status', '--porcelain'], toolRoot),
        sha256: toolBefore.sha256,
      },
      adapterFiles,
      adapterSha256: hash(JSON.stringify(adapterFiles)),
      dependencySha256: hash(
        ['pnpm-lock.yaml', 'Cargo.lock']
          .map((path) => readFileSync(resolve(project, path)))
          .join('\n'),
      ),
      binarySha256: hash(readFileSync(binary)),
      frontendSha256: treeIdentity(paths.frontend).sha256,
      mode: 'release + perf-harness (private native outputs; resolved inputs recorded)',
      buildSettingsSha256: hash(
        JSON.stringify({
          configuration,
          host: graph.host,
          buildCommand,
          configurationHashes: before.configuration.map(
            ({ locations, kind, sha256 }) => ({
              locations: locations.map((path) => relative(project, path)),
              kind,
              sha256,
            }),
          ),
        }),
      ),
      buildEnvironment,
      buildCommand,
      execution: {
        ...execution,
        viteArgs,
        tauriConfigurationSource: resolve(project, 'scripts/perf/tauri.json'),
      },
      binary,
      toolchain: `${execution.compiler.version}; node ${process.version}; pnpm ${command('pnpm', ['--version'])}`,
    },
    null,
    2,
  ),
)
console.log(`Measurement binary and manifest: ${binary}`)
