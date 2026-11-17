import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { CLIENT_SOURCE_FILES, buildClientSource } from './build-client.mjs'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

test('client.js stays byte-for-byte in sync with modular client/* sources and compiles cleanly', async () => {
  const clientDir = path.join(ROOT_DIR, 'client')
  const entries = (await fs.readdir(clientDir)).filter(name => !name.startsWith('.')).sort()
  assert.deepEqual(entries, [...CLIENT_SOURCE_FILES].sort())

  const expected = await buildClientSource(clientDir)
  const actual = await fs.readFile(path.join(ROOT_DIR, 'client.js'), 'utf8')
  assert.equal(
    actual,
    expected,
    'client.js drifted from client/* sources — run `npm run build:client` to synchronize',
  )
  assert.doesNotThrow(() => new vm.Script(actual, { filename: 'client.js' }))
})

test('pipeline backend modules preserve full export/prototype contracts without minified mega-lines', async () => {
  const tasksMod = require('../modules/pipeline/tasks.js')
  const routesMod = require('../modules/pipeline/routes.js')

  assert.deepEqual(Object.keys(tasksMod).sort(), [
    'STAGES',
    'TaskManager',
    'blockedPagesFromReport',
    'parseModelChoice',
    'reopenStuckBudget',
    'resolveFallbacks',
    'stuckPagesFromReports',
    'visionFallbackArgs',
  ])
  assert.deepEqual(Object.keys(routesMod).sort(), ['TaskManager', 'taskRoutes'])
  assert.equal(routesMod.TaskManager, tasksMod.TaskManager)

  const protoProps = Object.getOwnPropertyNames(tasksMod.TaskManager.prototype)
  assert.ok(protoProps.length >= 104, `expected >= 104 prototype methods, got ${protoProps.length}`)

  const taskSubdir = path.join(ROOT_DIR, 'modules', 'pipeline', 'tasks')
  const files = [
    path.join(ROOT_DIR, 'modules', 'pipeline', 'routes.js'),
    path.join(ROOT_DIR, 'modules', 'pipeline', 'tasks.js'),
    ...(await fs.readdir(taskSubdir))
      .filter(f => f.endsWith('.js'))
      .map(f => path.join(taskSubdir, f)),
  ]
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8')
    const maxLine = Math.max(...text.split('\n').map(line => line.length))
    assert.ok(
      maxLine <= 400,
      `${path.relative(ROOT_DIR, file)} contains an overly compressed line (${maxLine} chars)`,
    )
  }
})

test('shared Python runtime scripts remain synchronized with installed fnm-ai-convert skill scripts', async () => {
  const skillScriptsDir = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'DSH',
    'PaperReader',
    '.kimi-code',
    'skills',
    'fnm-ai-convert',
    'scripts',
  )
  let hasSkillDir = false
  try {
    hasSkillDir = (await fs.stat(skillScriptsDir)).isDirectory()
  } catch {
    hasSkillDir = false
  }
  if (!hasSkillDir) return

  for (const scriptName of ['harness_worker.py', 'issue_annotations.py']) {
    const repoCopy = await fs.readFile(path.join(ROOT_DIR, 'runtime', scriptName), 'utf8')
    const skillCopy = await fs.readFile(path.join(skillScriptsDir, scriptName), 'utf8')
    assert.equal(
      skillCopy,
      repoCopy,
      `Skill script ${scriptName} drifted from runtime/${scriptName}`,
    )
  }
})

test('mandatory orchestrator manual and README documentation links resolve on disk', async () => {
  const manualStat = await fs.stat(path.join(ROOT_DIR, 'docs', 'PIPELINE-MANUAL.md'))
  assert.ok(manualStat.isFile(), 'docs/PIPELINE-MANUAL.md must exist at docs/ root')

  const readme = await fs.readFile(path.join(ROOT_DIR, 'README.md'), 'utf8')
  const docLinks = [...readme.matchAll(/\]\((docs\/[^)#\s]+)\)/g)].map(m => m[1])
  assert.ok(docLinks.length > 0, 'README.md should reference docs/* manuals')
  for (const relPath of docLinks) {
    const stat = await fs.stat(path.join(ROOT_DIR, relPath))
    assert.ok(stat.isFile(), `Broken documentation link in README.md: ${relPath}`)
  }
})
