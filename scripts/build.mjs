#!/usr/bin/env node
/**
 * build.mjs — Best-effort build of Claude Code v2.1.88 from source
 *
 * ⚠️  IMPORTANT: A complete rebuild requires the Bun runtime's compile-time
 *     intrinsics (feature(), MACRO, bun:bundle). This script provides a
 *     best-effort build using esbuild. See KNOWN_ISSUES.md for details.
 *
 * What this script does:
 *   1. Copy src/ → build-src/ (original untouched)
 *   2. Replace `feature('X')` → `false`  (compile-time → runtime)
 *   3. Replace `MACRO.VERSION` etc → string literals
 *   4. Replace `import from 'bun:bundle'` → stub
 *   5. Create stubs for missing feature-gated modules
 *   6. Bundle with esbuild → dist/cli.js
 *
 * Requirements: Node.js >= 18, npm
 * Usage:       node scripts/build.mjs
 */

import { readdir, readFile, writeFile, mkdir, cp, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as esbuild from 'esbuild'
import { join, dirname } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const _require = createRequire(import.meta.url)

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const VERSION = '2.1.88'
const BUILD = join(ROOT, 'build-src')
const ENTRY = join(BUILD, 'entry.ts')

// ── Helpers ────────────────────────────────────────────────────────────────

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory() && e.name !== 'node_modules') yield* walk(p)
    else yield p
  }
}

async function exists(p) { try { await stat(p); return true } catch { return false } }

async function ensureEsbuild() {
  try { execSync('npx esbuild --version', { stdio: 'pipe' }) }
  catch {
    console.log('📦 Installing esbuild...')
    execSync('npm install --save-dev esbuild', { cwd: ROOT, stdio: 'inherit' })
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 1: Copy source
// ══════════════════════════════════════════════════════════════════════════════

await rm(BUILD, { recursive: true, force: true })
await mkdir(BUILD, { recursive: true })
await cp(join(ROOT, 'src'), join(BUILD, 'src'), { recursive: true })
console.log('✅ Phase 1: Copied src/ → build-src/')

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 2: Transform source
// ══════════════════════════════════════════════════════════════════════════════

let transformCount = 0

// MACRO replacements
const MACROS = {
  'MACRO.VERSION': `'${VERSION}'`,
  'MACRO.BUILD_TIME': `''`,
  'MACRO.FEEDBACK_CHANNEL': `'https://github.com/anthropics/claude-code/issues'`,
  'MACRO.ISSUES_EXPLAINER': `'https://github.com/anthropics/claude-code/issues/new/choose'`,
  'MACRO.FEEDBACK_CHANNEL_URL': `'https://github.com/anthropics/claude-code/issues'`,
  'MACRO.ISSUES_EXPLAINER_URL': `'https://github.com/anthropics/claude-code/issues/new/choose'`,
  'MACRO.NATIVE_PACKAGE_URL': `'@anthropic-ai/claude-code'`,
  'MACRO.PACKAGE_URL': `'@anthropic-ai/claude-code'`,
  'MACRO.VERSION_CHANGELOG': `''`,
}

for await (const file of walk(join(BUILD, 'src'))) {
  if (!file.match(/\.[tj]sx?$/)) continue

  let src = await readFile(file, 'utf8')
  let changed = false

  // 2a. feature('X') → false (multi-line with optional trailing comma)
  // Use [\s\S]*? to match across lines and handle trailing commas
  if (/\bfeature\s*\(\s*['"][A-Z_]+['"][\s\S]*?\)/.test(src)) {
    src = src.replace(/\bfeature\s*\(\s*['"][A-Z_]+['"][\s\S]*?\)/g, 'false')
    changed = true
  }

  // 2b. MACRO.X → literals (sorted DESC by key length to handle VERSION_CHANGELOG before VERSION)
  const sortedMacros = Object.entries(MACROS).sort((a, b) => b[0].length - a[0].length)
  for (const [k, v] of sortedMacros) {
    if (src.includes(k)) {
      src = src.replaceAll(k, v)
      changed = true
    }
  }

  // 2c. Remove bun:bundle import (feature() is already replaced)
  if (src.includes("from 'bun:bundle'") || src.includes('from "bun:bundle"')) {
    src = src.replace(/import\s*\{\s*feature\s*\}\s*from\s*['"]bun:bundle['"];?\n?/g, '// feature() replaced with false at build time\n')
    changed = true
  }

  // 2d. Remove type-only import of global.d.ts
  if (src.includes("import '../global.d.ts'") || src.includes("import './global.d.ts'")) {
    src = src.replace(/import\s*['"][.\/]*global\.d\.ts['"];?\n?/g, '')
    changed = true
  }

  // 2e. Fix invalid commander short flag '-d2e' (npm commander requires single char short flags)
  //     In Bun's bundled commander this was accepted. npm's commander rejects it.
  if (src.includes('-d2e')) {
    src = src.replace(/-d2e, --debug-to-stderr/g, '--debug-to-stderr')
    src = src.replace(/process\.argv\.includes\('--debug-to-stderr'\) \|\| process\.argv\.includes\('-d2e'\)/g, "process.argv.includes('--debug-to-stderr')")
    changed = true
  }

  if (changed) {
    await writeFile(file, src, 'utf8')
    transformCount++
  }
}
console.log(`✅ Phase 2: Transformed ${transformCount} files`)

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 3: Create entry wrapper
// ══════════════════════════════════════════════════════════════════════════════

await writeFile(ENTRY, `#!/usr/bin/env node
// Claude Code v${VERSION} — built from source
// Copyright (c) Anthropic PBC. All rights reserved.
import './src/entrypoints/cli.tsx'
`, 'utf8')
console.log('✅ Phase 3: Created entry wrapper')

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 3.5: Patch jsonc-parser ESM files for Node ESM compatibility
// jsonc-parser uses extensionless imports ('./impl/format' vs './impl/format.js')
// which fail in Node's ESM loader. Fix: add .js extensions.
// ══════════════════════════════════════════════════════════════════════════════

const JSONC_ESM_DIR = join(ROOT, 'node_modules/jsonc-parser/lib/esm')
if (await exists(JSONC_ESM_DIR)) {
  async function patchJsoncImports(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await patchJsoncImports(fullPath)
      } else if (entry.name.endsWith('.js')) {
        let content = await readFile(fullPath, 'utf-8')
        const patched = content.replace(/from\s+'\.\/([^']+)'/g, (match, path) => {
          if (!path.endsWith('.js')) return `from './${path}.js'`
          return match
        })
        if (patched !== content) {
          await writeFile(fullPath, patched)
        }
      }
    }
  }
  await patchJsoncImports(JSONC_ESM_DIR)
  console.log('✅ Phase 3.5: Patched jsonc-parser ESM imports')
} else {
  console.log('⚠️ Phase 3.5: jsonc-parser ESM dir not found, skipping')
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 4: Iterative stub + bundle
// ══════════════════════════════════════════════════════════════════════════════

await ensureEsbuild()

const OUT_DIR = join(ROOT, 'dist')
await mkdir(OUT_DIR, { recursive: true })
const OUT_FILE = join(OUT_DIR, 'cli.js')

// Run up to 10 rounds of: esbuild → collect missing → create stubs → retry
const MAX_ROUNDS = 10
let succeeded = false

for (let round = 1; round <= MAX_ROUNDS; round++) {
  console.log(`\n🔨 Phase 4 round ${round}/${MAX_ROUNDS}: Bundling...`)

  const bannerText = `// Claude Code v${VERSION} (built from source)\n// Copyright (c) Anthropic PBC. All rights reserved.\n`
  const result = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: OUT_FILE,
    banner: { js: bannerText },
    packages: 'external',
    tsconfig: join(ROOT, 'tsconfig.json'),
    allowOverwrite: true,
    plugins: [{
      name: 'bundle-dynamic-require',
      setup(build) {
        const bundlePackages = new Set(['semver', 'proper-lockfile', 'yaml', 'undici'])
        build.onResolve({ filter: /^[^.]/ }, args => {
          const parts = args.path.split('/')
          const pkgName = args.path.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
          if (bundlePackages.has(pkgName)) {
            const resolved = _require.resolve(args.path, { paths: [args.resolveDir] })
            return { path: resolved, external: false, namespace: 'file' }
          }
        })
      }
    }],
    logLevel: 'error',
    logLimit: 0,
    sourcemap: true,
    loader: { '.md': 'text' },
    metafile: false,
    write: true,
  }).catch(e => e)
  if (result.errors?.length === 0) {
    // No errors — build succeeded
    succeeded = true
    break
  }

  // Parse errors into categories
  const errors = (result.errors || []).map(e => JSON.parse(JSON.stringify({
    severity: 'error',
    text: e.text,
    location: e.location ? { file: e.location.file, line: e.location.line, column: e.location.column } : null,
  })))

  const missing = new Map()     // resolved path → set of importers
  const noExport = new Map()    // resolved path → Set of missing export names
  let stubCount = 0

  for (const entry of errors) {
    const text = entry.text || ''
    const locFile = entry.location?.file || ''

    // ── Type 1: Could not resolve "module"  ────────────────────────────
    if (text.includes('Could not resolve')) {
      const modText = text.match(/Could not resolve "([^"]+)"/)
      if (!modText) continue
      const mod = modText[1]
      if (mod.startsWith('node:') || mod.startsWith('bun:') || mod.startsWith('/')) continue

      if (mod.startsWith('.')) {
        const sourceDir = dirname(locFile.replace(/\\/g, '/'))
        const resolved = join(sourceDir, mod).replace(/\\/g, '/')
        if (!missing.has(resolved)) missing.set(resolved, new Set())
        missing.get(resolved).add(locFile)
      } else {
        const resolved = join(BUILD, 'src', mod).replace(/\\/g, '/')
        if (!missing.has(resolved)) missing.set(resolved, new Set())
        missing.get(resolved).add(locFile)
      }
      continue
    }

    // ── Type 2: No matching export in "file" for import "name" ─────────
    const noExportMatch = text.match(/No matching export in "([^"]+)" for import "([^"]+)"/)
    if (noExportMatch) {
      let filePath = noExportMatch[1].replace(/\\/g, '/')
      // The error path is relative to root. Resolve to build-src.
      if (filePath.startsWith('src/')) {
        filePath = join(BUILD, filePath).replace(/\\/g, '/')
      }
      if (!noExport.has(filePath)) noExport.set(filePath, new Set())
      noExport.get(filePath).add(noExportMatch[2])
      continue
    }
  }

  // ── Handle Type 1: Create new stubs for missing modules ─────────────
  if (missing.size > 0) {
    console.log(`   Found ${missing.size} missing modules, creating stubs...`)
    for (const [resolved, importers] of missing) {
      if (await exists(resolved)) continue
      await mkdir(dirname(resolved), { recursive: true }).catch(() => {})

      if (/\.(txt|md|json|yml|yaml)$/.test(resolved)) {
        const ext = resolved.split('.').pop()
        const content = ext === 'json' ? '{}' : ext === 'yml' || ext === 'yaml' ? '# empty' : ''
        await writeFile(resolved, content, 'utf8')
        stubCount++
      } else if (/\.[tj]sx?$/.test(resolved)) {
        const name = resolved.split('/').pop().replace(/\.[tj]sx?$/, '')
        const safeName = name.replace(/[^a-zA-Z0-9_$]/g, '_') || 'stub'
        await writeFile(resolved,
`// Auto-generated stub: imported by ${[...importers].join(', ')}
const ${safeName} = {};
export default ${safeName};
export { ${safeName} };
`, 'utf8')
        stubCount++
      }
    }
    console.log(`   Created ${stubCount} stubs`)
  }

  // ── Handle Type 2: Add missing named exports to existing stubs ──────
  const noExportNames = new Map()  // filePath → display name for logging
  if (noExport.size > 0) {
    console.log(`   Found ${noExport.size} files with missing exports, patching...`)
    let patchCount = 0
    for (const [filePath, exportNames] of noExport) {
      if (!(await exists(filePath))) continue
      let content = await readFile(filePath, 'utf8')
      for (const name of exportNames) {
        // Skip if the export already exists in the file
        if (content.includes(`export { ${name}`) || content.includes(`export const ${name}`) ||
            content.includes(`export function ${name}`) || content.includes(`export class ${name}`) ||
            content.includes(`export enum ${name}`) || content.includes(`export interface ${name}`) ||
            content.includes(`export type ${name}`)) {
          continue
        }
        // Append the missing export
        const safeName = name.replace(/[^a-zA-Z0-9_$]/g, '_') || 'stub'
        content += `\nexport const ${safeName} = undefined;\n`
        noExportNames.set(filePath, name)
        patchCount++
      }
      await writeFile(filePath, content, 'utf8')

      // ALSO patch the original src/ copy: tsconfig has "baseUrl": "." + "src/*": ["src/*"]
      // so bare imports like `src/types/foo.js` resolve to ROOT/src/ NOT build-src/src/
      const buildSrcPrefix = join(BUILD, 'src').replace(/\\/g, '/') + '/'
      if (filePath.startsWith(buildSrcPrefix)) {
        const origPath = filePath.replace(buildSrcPrefix, join(ROOT, 'src').replace(/\\/g, '/') + '/')
        if (await exists(origPath)) {
          let origContent = await readFile(origPath, 'utf8')
          for (const name of exportNames) {
            if (origContent.includes(`export { ${name}`) || origContent.includes(`export const ${name}`) ||
                origContent.includes(`export function ${name}`) || origContent.includes(`export class ${name}`) ||
                origContent.includes(`export enum ${name}`) || origContent.includes(`export interface ${name}`) ||
                origContent.includes(`export type ${name}`)) {
              continue
            }
            const safeName = name.replace(/[^a-zA-Z0-9_$]/g, '_') || 'stub'
            origContent += `\nexport const ${safeName} = undefined;\n`
          }
          await writeFile(origPath, origContent, 'utf8')
        }
      }
    }
    if (patchCount > 0) console.log(`   Patched ${patchCount} missing exports`)
  }

  // ── Stop if nothing was fixed this round ────────────────────────────
  if (missing.size === 0 && noExport.size === 0) {
    console.log('   No fixable errors found.')
    break
  }
}

if (succeeded) {
  const size = (await stat(OUT_FILE)).size
  console.log(`\n✅ Build succeeded: ${OUT_FILE}`)
  console.log(`   Size: ${(size / 1024 / 1024).toFixed(1)}MB`)
  console.log(`\n   Usage:  node ${OUT_FILE} --version`)
  console.log(`           node ${OUT_FILE} -p "Hello"`)
} else {
  console.error('\n❌ Build failed after all rounds.')
  console.error('   The transformed source is in build-src/ for inspection.')
  process.exit(1)
}

if (succeeded) {
  const size = (await stat(OUT_FILE)).size
  console.log(`\n✅ Build succeeded: ${OUT_FILE}`)
  console.log(`   Size: ${(size / 1024 / 1024).toFixed(1)}MB`)
  console.log(`\n   Usage:  node ${OUT_FILE} --version`)
  console.log(`           node ${OUT_FILE} -p "Hello"`)
} else {
  console.error('\n❌ Build failed after all rounds.')
  console.error('   The transformed source is in build-src/ for inspection.')
  console.error('\n   To fix manually:')
  console.error('   1. Check build-src/ for the transformed files')
  console.error('   2. Create missing stubs in build-src/src/')
  console.error('   3. Re-run: node scripts/build.mjs')
  process.exit(1)
}
