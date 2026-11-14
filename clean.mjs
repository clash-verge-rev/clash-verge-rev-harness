import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { cleanArtifacts } from './artifacts.mjs'
import { projectRoot } from './project.mjs'
const { values, positionals } = parseArgs({
  options: { project: { type: 'string' } },
  allowPositionals: true,
})
const project = projectRoot(values.project)
if (!positionals.length)
  throw new Error(
    'Pass exact owned build/run directories; no recursive workspace cleanup',
  )
for (const path of positionals) {
  cleanArtifacts(project, resolve(project, path))
  console.log(`Removed owned artifacts: ${path}`)
}
