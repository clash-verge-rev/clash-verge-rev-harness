import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { projectRoot } from './project.mjs'

const require = createRequire(
  resolve(projectRoot(process.env.CVR_PROJECT), 'package.json'),
)
const js = require('@eslint/js')
const globals = require('globals')
export default [
  {
    files: ['**/*.mjs'],
    ...js.configs.recommended,
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
]
