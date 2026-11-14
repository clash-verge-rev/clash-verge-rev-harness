import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { createArtifacts } from './artifacts.mjs'
import {
  captureBuildInputs,
  captureGeneratedOutputs,
  rootBuildOutput,
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
const generatedOutputPaths = [
  'acl-manifests.json',
  'capabilities.json',
  'macOS-schema.json',
  'desktop-schema.json',
].map((name) => resolve(project, 'src-tauri/gen/schemas', name))
const beforeGenerated = captureGeneratedOutputs(generatedOutputPaths)
const before = captureBuildInputs(project, graph, output, generatedOutputPaths)
const toolBefore = treeIdentity(toolRoot, [resolve(toolRoot, 'target/perf')])
writeFileSync(
  resolve(output, 'build-inputs-before.json'),
  JSON.stringify(
    { inputs: before, harness: toolBefore, generatedOutputs: beforeGenerated },
    null,
    2,
  ),
)
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
let execution, after, toolAfter, afterGenerated, snapshotError
try {
  execFileSync('pnpm', viteArgs, { cwd: project, stdio: 'inherit' })
  execution = nativeBuild(
    project,
    paths,
    'clash-verge',
    ['perf-harness'],
    graph.host,
    { TAURI_CONFIG: JSON.stringify(actualConfiguration) },
  )
} finally {
  try {
    afterGenerated = captureGeneratedOutputs(generatedOutputPaths)
    after = captureBuildInputs(
      project,
      cargoMetadata(project, 'clash-verge', ['perf-harness'], paths),
      output,
      generatedOutputPaths,
    )
    toolAfter = treeIdentity(toolRoot, [resolve(toolRoot, 'target/perf')])
    writeFileSync(
      resolve(output, 'build-inputs-after.json'),
      JSON.stringify(
        { inputs: after, harness: toolAfter, generatedOutputs: afterGenerated },
        null,
        2,
      ),
    )
  } catch (error) {
    snapshotError = error
    writeFileSync(
      resolve(output, 'build-inputs-after.json'),
      JSON.stringify({ error: String(error) }, null, 2),
    )
  }
}
if (snapshotError) throw snapshotError
if (before.sha256 !== after.sha256 || toolBefore.sha256 !== toolAfter.sha256)
  throw new Error(
    'Candidate, local dependency, build configuration or harness changed during build; refuse manifest',
  )
const rootOutDir = rootBuildOutput(execution, graph.packageId)
const consumedOutputs = captureGeneratedOutputs(
  ['acl-manifests.json', 'capabilities.json'].map((name) =>
    resolve(rootOutDir, name),
  ),
)
for (const item of consumedOutputs) {
  const generated = afterGenerated.find(
    (output) =>
      output.path ===
      resolve(project, 'src-tauri/gen/schemas', item.path.split('/').at(-1)),
  )
  if (!item.exists || !generated?.exists || item.sha256 !== generated.sha256)
    throw new Error(
      'Generated Tauri ACL changed before its private build copy; refuse manifest',
    )
}
const binary = resolve(output, 'clash-verge')
copyFileSync(resolve(execution.binaryDirectory, 'clash-verge'), binary)
const buildCommand =
  'pnpm exec vite build --mode perf --config scripts/perf/vite.mts --outDir <owned>/frontend; cargo build -p clash-verge --release --locked --target-dir <owned>/target --message-format json-render-diagnostics --features perf-harness; CARGO_BUILD_BUILD_DIR=<owned>/intermediates'
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
      generatedOutputs: {
        before: beforeGenerated,
        after: afterGenerated,
        consumed: consumedOutputs,
      },
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
          inputIdentityMethod:
            'immutable-inputs-v3-exact-tauri-generated-outputs',
          generatedOutputPaths: generatedOutputPaths.map((path) =>
            relative(project, path),
          ),
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
        rootBuildScriptOutDir: rootOutDir,
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
