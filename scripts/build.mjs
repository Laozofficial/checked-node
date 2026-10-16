// Builds dist/index.mjs, dist/index.cjs and dist/*.d.ts.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const src = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
const m = src.match(/SDK_VERSION = '([^']+)'/)
if (!m || m[1] !== pkg.version) {
  console.error(`SDK_VERSION (${m ? m[1] : 'missing'}) does not match package.json (${pkg.version})`)
  process.exit(1)
}

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
const common = {
  entryPoints: [join(root, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  legalComments: 'none',
  logLevel: 'warning',
}
await build({ ...common, format: 'esm', outfile: join(dist, 'index.mjs') })
await build({ ...common, format: 'cjs', outfile: join(dist, 'index.cjs') })
execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.build.json')], {
  stdio: 'inherit',
})
for (const f of ['index.mjs', 'index.cjs']) console.log(`dist/${f}  ${(statSync(join(dist, f)).size / 1024).toFixed(2)} KB`)
