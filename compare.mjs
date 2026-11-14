import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { compare } from './report.mjs'
const { values, positionals: args } = parseArgs({
  args: process.argv.slice(2).filter((v) => v !== '--'),
  options: { 'adapter-review': { type: 'string' } },
  allowPositionals: true,
})
if (args.length < 2)
  throw new Error(
    'Usage: node compare.mjs baseline/summary.json candidate/summary.json [noise-threshold-percent] [--adapter-review rationale]',
  )
const threshold = args[2] === undefined ? null : Number(args[2])
if (threshold !== null && (!Number.isFinite(threshold) || threshold < 0))
  throw new Error(
    'threshold must be a nonnegative percentage justified by baseline noise',
  )
function load(path) {
  if (statSync(path).isFile()) return [JSON.parse(readFileSync(path))]
  if (existsSync(join(path, 'summary.json')))
    return load(join(path, 'summary.json'))
  return readdirSync(path)
    .sort()
    .flatMap((name) => load(join(path, name)))
}
let result
try {
  const [baseline, candidate] = args.slice(0, 2).map(load)
  result = compare(baseline, candidate, threshold, values['adapter-review'])
  if (
    baseline[0]?.build?.adapterSha256 !== candidate[0]?.build?.adapterSha256
  ) {
    const paths = new Set([
      ...Object.keys(baseline[0]?.build?.adapterFiles ?? {}),
      ...Object.keys(candidate[0]?.build?.adapterFiles ?? {}),
    ])
    result.adapterReview = {
      rationale: values['adapter-review'] ?? null,
      changedPaths: [...paths].filter(
        (path) =>
          baseline[0]?.build?.adapterFiles?.[path] !==
          candidate[0]?.build?.adapterFiles?.[path],
      ),
    }
  }
} catch (error) {
  result = { verdict: 'invalid', reason: String(error) }
}
console.log(JSON.stringify(result, null, 2))
if (['invalid', 'incomparable', 'ineligible'].includes(result.verdict))
  process.exitCode = 2
