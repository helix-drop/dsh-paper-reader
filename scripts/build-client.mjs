import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_DIR = path.join(ROOT_DIR, 'client')
const OUTPUT_FILE = path.join(ROOT_DIR, 'client.js')

export const CLIENT_SOURCE_FILES = [
  'i18n.js',
  'styles.css',
  'styles-pipeline.css',
  'styles-reader.css',
  'styles-bookmarks.css',
  'styles-citation.css',
  'ui-primitives.js',
  'weread-presets.js',
  'reading-helpers.js',
  'citation.js',
  'bookmarks-view.js',
  'reader-board.js',
  'pipeline-drawers.js',
  'pipeline-workspace.js',
  'task-helpers.js',
  'pipeline-panel.js',
  'reader-page.js',
  'plugin-entry.js',
]

function indentBody(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '')
    .split('\n')
    .map(line => (line === '' ? '' : `    ${line}`))
    .join('\n')
}

export async function buildClientSource(clientDir = CLIENT_DIR) {
  const parts = {}
  for (const name of CLIENT_SOURCE_FILES) {
    parts[name] = await fs.readFile(path.join(clientDir, name), 'utf8')
  }

  const rawCss = (
    parts['styles.css'] +
    '\n' +
    parts['styles-pipeline.css'] +
    '\n' +
    parts['styles-reader.css'] +
    '\n' +
    parts['styles-bookmarks.css'] +
    '\n' +
    parts['styles-citation.css']
  )
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '')
  if (rawCss.includes('`') || rawCss.includes('${')) {
    throw new Error('client/styles*.css must not contain unescaped backticks (`) or template interpolations (${)')
  }

  const assembled = [
    '/* @local/paper-reader — DSH Client. Editorial library + responsive paper reader. */',
    '/* Generated from client/* via `npm run build:client`. Edit source files in client/ and rebuild. */',
    'window.__ModuleLoader__.load({',
    "  id: '@local/paper-reader',",
    '  factory(require) {',
    "    const React = require('react')",
    '    const h = React.createElement',
    '    const { useState, useEffect, useRef, useCallback, useSyncExternalStore, useMemo } = React',
    "    const NS = 'paper-reader'",
    '',
    indentBody(parts['i18n.js']),
    '',
    '    /* Colors follow DSH theme tokens; @container responds to the main panel, not the monitor. */',
    '    const CSS = `',
    rawCss,
    '`',
    '',
    indentBody(parts['ui-primitives.js']),
    indentBody(parts['weread-presets.js']),
    indentBody(parts['reading-helpers.js']),
    indentBody(parts['citation.js']),
    indentBody(parts['bookmarks-view.js']),
    indentBody(parts['reader-board.js']),
    indentBody(parts['pipeline-drawers.js']),
    indentBody(parts['pipeline-workspace.js']),
    indentBody(parts['task-helpers.js']),
    indentBody(parts['pipeline-panel.js']),
    '',
    indentBody(parts['reader-page.js']),
    indentBody(parts['plugin-entry.js']),
    '  },',
    '})',
    '',
  ].join('\n')

  new vm.Script(assembled, { filename: 'client.js' })
  return assembled
}

async function main() {
  const checkOnly = process.argv.includes('--check')
  const built = await buildClientSource()

  if (checkOnly) {
    const current = await fs.readFile(OUTPUT_FILE, 'utf8')
    if (current !== built) {
      console.error('client.js is out of sync with client/* — run `npm run build:client` to update it.')
      process.exitCode = 1
      return
    }
    console.log('client.js is in sync with client/*.')
    return
  }

  await fs.writeFile(OUTPUT_FILE, built, 'utf8')
  console.log(`Built client.js (${built.split('\n').length - 1} lines, ${Buffer.byteLength(built)} bytes) from ${CLIENT_SOURCE_FILES.length} source files.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
