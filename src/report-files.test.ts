import assert from 'node:assert/strict'
import {mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import {promisify} from 'node:util'
import {gunzip} from 'node:zlib'
import {parseInputs, resolveInvocationKey, resolveToken} from './action-inputs.js'
import {
  discoverTestResultFiles,
  MAX_REPORT_FILES,
  prepareReportFiles,
  splitPathInput,
  type DiscoveredFile,
} from './report-files.js'

const gunzipAsync = promisify(gunzip)

test('splitPathInput trims blank lines', () => {
  assert.deepEqual(splitPathInput('test-results/\n\n other/**/*.xml \r\n'), ['test-results/', 'other/**/*.xml'])
})

test('resolveInvocationKey prefers explicit key, then GITHUB_ACTION, then default', () => {
  assert.equal(resolveInvocationKey('unit', 'github_step'), 'unit')
  assert.equal(resolveInvocationKey('', 'github_step'), 'github_step')
  assert.equal(resolveInvocationKey('', ''), 'default')
  assert.equal(resolveInvocationKey('  ', '  '), 'default')
})

test('resolveToken uses DEPOT_TOKEN only', () => {
  assert.equal(resolveToken({DEPOT_TOKEN: 'depot-token'}), 'depot-token')
  assert.equal(resolveToken({DEPOT_TOKEN: '  depot-token  '}), 'depot-token')
  assert.throws(() => resolveToken({UNRELATED_TOKEN: 'other-token'}), /must run in Depot CI/)
  assert.throws(() => resolveToken({}), /must run in Depot CI/)
})

test('parseInputs validates path and resolves defaults', () => {
  const inputs = parseInputs(' test-results/ ', ' unit ', {
    DEPOT_TOKEN: 'depot-token',
    GITHUB_ACTION: 'github_step',
  })

  assert.equal(inputs.pathInput, 'test-results/')
  assert.equal(inputs.invocationKey, 'unit')
  assert.equal(inputs.token, 'depot-token')

  assert.throws(() => parseInputs('   ', undefined, {DEPOT_TOKEN: 'depot-token'}), /Missing required input "path"/)

  assert.throws(() => parseInputs('test-results/', 'input-token', {}), /must run in Depot CI/)
})

test('discoverTestResultFiles expands directory inputs to XML files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-'))
  const originalWorkspace = process.env.GITHUB_WORKSPACE
  process.env.GITHUB_WORKSPACE = dir

  try {
    await mkdir(path.join(dir, 'test-results', 'nested'), {recursive: true})
    await writeFile(path.join(dir, 'test-results', 'unit.xml'), '<testsuite />')
    await writeFile(path.join(dir, 'test-results', 'nested', 'integration.xml'), '<testsuite />')
    await writeFile(path.join(dir, 'test-results', 'debug.log'), 'not xml')

    const files = await discoverTestResultFiles(path.join(dir, 'test-results'))

    assert.deepEqual(
      files.map((file) => file.filename),
      ['test-results/nested/integration.xml', 'test-results/unit.xml'],
    )
  } finally {
    restoreEnv('GITHUB_WORKSPACE', originalWorkspace)
    await rm(dir, {recursive: true, force: true})
  }
})

test('discoverTestResultFiles accepts explicit file paths and containing directories', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-'))
  const originalWorkspace = process.env.GITHUB_WORKSPACE
  process.env.GITHUB_WORKSPACE = dir

  try {
    await mkdir(path.join(dir, 'test-results'), {recursive: true})
    const reportPath = path.join(dir, 'test-results', 'junit.xml')
    await writeFile(reportPath, '<testsuite />')

    const explicitFiles = await discoverTestResultFiles('test-results/junit.xml')
    const directoryFiles = await discoverTestResultFiles('test-results/')

    assert.deepEqual(explicitFiles, directoryFiles)
    assert.deepEqual(
      explicitFiles.map((file) => file.filename),
      ['test-results/junit.xml'],
    )
  } finally {
    restoreEnv('GITHUB_WORKSPACE', originalWorkspace)
    await rm(dir, {recursive: true, force: true})
  }
})

test('discoverTestResultFiles rejects outside search roots before glob traversal', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-workspace-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-outside-'))
  const originalWorkspace = process.env.GITHUB_WORKSPACE
  process.env.GITHUB_WORKSPACE = workspace

  try {
    await writeFile(path.join(outside, 'junit.xml'), '<testsuite />')

    await assert.rejects(() => discoverTestResultFiles(path.join(outside, '*.xml')), /outside the workspace/)
    await assert.rejects(() => discoverTestResultFiles('../*.xml'), /outside the workspace/)
  } finally {
    restoreEnv('GITHUB_WORKSPACE', originalWorkspace)
    await rm(workspace, {recursive: true, force: true})
    await rm(outside, {recursive: true, force: true})
  }
})

test('discoverTestResultFiles supports multiline directory inputs and deduplicates overlaps', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-'))
  const originalWorkspace = process.env.GITHUB_WORKSPACE
  process.env.GITHUB_WORKSPACE = dir

  try {
    await mkdir(path.join(dir, 'unit'), {recursive: true})
    await mkdir(path.join(dir, 'integration'), {recursive: true})
    await writeFile(path.join(dir, 'unit', 'junit.xml'), '<testsuite name="unit" />')
    await writeFile(path.join(dir, 'integration', 'junit.xml'), '<testsuite name="integration" />')

    const files = await discoverTestResultFiles(
      `${path.join(dir, 'unit')}\n${path.join(dir, 'unit/**/*.xml')}\n${path.join(dir, 'integration')}`,
    )

    assert.deepEqual(
      files.map((file) => file.filename),
      ['integration/junit.xml', 'unit/junit.xml'],
    )
  } finally {
    restoreEnv('GITHUB_WORKSPACE', originalWorkspace)
    await rm(dir, {recursive: true, force: true})
  }
})

test('discoverTestResultFiles falls back to cwd-relative filenames', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-'))
  const originalWorkspace = process.env.GITHUB_WORKSPACE
  const originalCwd = process.cwd()
  delete process.env.GITHUB_WORKSPACE

  try {
    process.chdir(dir)
    await mkdir('results', {recursive: true})
    await writeFile(path.join('results', 'junit.xml'), '<testsuite />')

    const files = await discoverTestResultFiles('results')

    assert.deepEqual(
      files.map((file) => file.filename),
      ['results/junit.xml'],
    )
  } finally {
    process.chdir(originalCwd)
    restoreEnv('GITHUB_WORKSPACE', originalWorkspace)
    await rm(dir, {recursive: true, force: true})
  }
})

test('discoverTestResultFiles follows file symlinks inside the workspace', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-'))
  const originalWorkspace = process.env.GITHUB_WORKSPACE
  process.env.GITHUB_WORKSPACE = dir

  try {
    await mkdir(path.join(dir, 'reports'), {recursive: true})
    await mkdir(path.join(dir, 'real'), {recursive: true})
    await writeFile(path.join(dir, 'real', 'junit.xml'), '<testsuite />')
    await symlink(path.join(dir, 'real', 'junit.xml'), path.join(dir, 'reports', 'linked.xml'))

    const files = await discoverTestResultFiles(path.join(dir, 'reports', '*.xml'))

    assert.deepEqual(
      files.map((file) => file.filename),
      ['real/junit.xml'],
    )
  } finally {
    restoreEnv('GITHUB_WORKSPACE', originalWorkspace)
    await rm(dir, {recursive: true, force: true})
  }
})

test('discoverTestResultFiles does not traverse symlinked directories outside the workspace', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-workspace-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-outside-'))
  const originalWorkspace = process.env.GITHUB_WORKSPACE
  process.env.GITHUB_WORKSPACE = workspace

  try {
    await writeFile(path.join(outside, 'junit.xml'), '<testsuite />')
    await symlink(outside, path.join(workspace, 'linked-results'))

    await assert.rejects(() => discoverTestResultFiles('linked-results'), /outside the workspace/)
    await assert.rejects(() => discoverTestResultFiles('**/*.xml'), /too broad/)
  } finally {
    restoreEnv('GITHUB_WORKSPACE', originalWorkspace)
    await rm(workspace, {recursive: true, force: true})
    await rm(outside, {recursive: true, force: true})
  }
})

test('discoverTestResultFiles rejects symlinked glob roots before traversal', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-workspace-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-outside-'))
  const originalWorkspace = process.env.GITHUB_WORKSPACE
  process.env.GITHUB_WORKSPACE = workspace

  try {
    await mkdir(path.join(outside, 'nested'), {recursive: true})
    await writeFile(path.join(outside, 'nested', 'junit.xml'), '<testsuite />')
    await symlink(outside, path.join(workspace, 'linked-results'))

    await assert.rejects(() => discoverTestResultFiles('linked-results/**/*.xml'), /outside the workspace/)
  } finally {
    restoreEnv('GITHUB_WORKSPACE', originalWorkspace)
    await rm(workspace, {recursive: true, force: true})
    await rm(outside, {recursive: true, force: true})
  }
})

test('discoverTestResultFiles rejects literal symlinked directories with glob-like characters', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-workspace-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-outside-'))
  const originalWorkspace = process.env.GITHUB_WORKSPACE
  process.env.GITHUB_WORKSPACE = workspace

  try {
    await writeFile(path.join(outside, 'junit.xml'), '<testsuite />')
    await symlink(outside, path.join(workspace, 'linked(results)'))

    await assert.rejects(() => discoverTestResultFiles('linked(results)'), /outside the workspace/)
  } finally {
    restoreEnv('GITHUB_WORKSPACE', originalWorkspace)
    await rm(workspace, {recursive: true, force: true})
    await rm(outside, {recursive: true, force: true})
  }
})

test('discoverTestResultFiles rejects workspace-root recursive searches', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-workspace-'))
  const originalWorkspace = process.env.GITHUB_WORKSPACE
  process.env.GITHUB_WORKSPACE = workspace

  try {
    await writeFile(path.join(workspace, 'junit.xml'), '<testsuite />')

    await assert.rejects(() => discoverTestResultFiles('.'), /too broad/)
    await assert.rejects(() => discoverTestResultFiles('**/*.xml'), /too broad/)
  } finally {
    restoreEnv('GITHUB_WORKSPACE', originalWorkspace)
    await rm(workspace, {recursive: true, force: true})
  }
})

test('discoverTestResultFiles rejects matches outside the workspace', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-workspace-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-outside-'))
  const originalWorkspace = process.env.GITHUB_WORKSPACE
  process.env.GITHUB_WORKSPACE = workspace

  try {
    await writeFile(path.join(outside, 'junit.xml'), '<testsuite />')

    await assert.rejects(() => discoverTestResultFiles(path.join(outside, 'junit.xml')), /outside the workspace/)
  } finally {
    restoreEnv('GITHUB_WORKSPACE', originalWorkspace)
    await rm(workspace, {recursive: true, force: true})
    await rm(outside, {recursive: true, force: true})
  }
})

test('discoverTestResultFiles enforces report file count limit during discovery', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-workspace-'))
  const originalWorkspace = process.env.GITHUB_WORKSPACE
  process.env.GITHUB_WORKSPACE = workspace

  try {
    await mkdir(path.join(workspace, 'reports'), {recursive: true})
    await Promise.all(
      Array.from({length: MAX_REPORT_FILES + 1}, (_, index) =>
        writeFile(path.join(workspace, 'reports', `${index}.xml`), '<testsuite />'),
      ),
    )

    await assert.rejects(() => discoverTestResultFiles('reports'), /more than/)
  } finally {
    restoreEnv('GITHUB_WORKSPACE', originalWorkspace)
    await rm(workspace, {recursive: true, force: true})
  }
})

test('prepareReportFiles gzips each XML file independently', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-'))

  try {
    const reportPath = path.join(dir, 'junit.xml')
    const xml = '<testsuite><testcase name="passes" /></testsuite>'
    await writeFile(reportPath, xml)

    const files = await prepareReportFiles([await discoveredFile(reportPath, 'junit.xml')], noopCore())

    assert.equal(files.length, 1)
    assert.equal(files[0]?.filename, 'junit.xml')
    assert.equal((await gunzipAsync(files[0]!.gzippedXml)).toString(), xml)
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test('prepareReportFiles enforces per-file and total size limits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-'))

  try {
    const largePath = path.join(dir, 'large.xml')
    await writeFile(largePath, Buffer.alloc(50 * 1024 * 1024 + 1))

    await assert.rejects(
      async () => prepareReportFiles([await discoveredFile(largePath, 'large.xml')], noopCore()),
      /per-file limit/,
    )

    const firstPath = path.join(dir, 'first.xml')
    const secondPath = path.join(dir, 'second.xml')
    const thirdPath = path.join(dir, 'third.xml')
    await writeFile(firstPath, Buffer.alloc(40 * 1024 * 1024))
    await writeFile(secondPath, Buffer.alloc(40 * 1024 * 1024))
    await writeFile(thirdPath, Buffer.alloc(40 * 1024 * 1024))

    await assert.rejects(
      async () =>
        prepareReportFiles(
          [
            await discoveredFile(firstPath, 'first.xml'),
            await discoveredFile(secondPath, 'second.xml'),
            await discoveredFile(thirdPath, 'third.xml'),
          ],
          noopCore(),
        ),
      /total uncompressed size limit/,
    )
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test('prepareReportFiles rejects file identity changes after discovery', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-workspace-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'depot-test-report-action-outside-'))

  try {
    await mkdir(path.join(workspace, 'reports'), {recursive: true})
    const originalPath = path.join(workspace, 'reports', 'junit.xml')
    await writeFile(originalPath, '<testsuite name="safe" />')
    const files = [await discoveredFile(originalPath, 'reports/junit.xml')]

    await rm(path.join(workspace, 'reports'), {recursive: true})
    await mkdir(path.join(outside, 'reports'), {recursive: true})
    await writeFile(path.join(outside, 'reports', 'junit.xml'), '<testsuite name="outside" />')
    await symlink(path.join(outside, 'reports'), path.join(workspace, 'reports'))

    await assert.rejects(() => prepareReportFiles(files, noopCore()), /changed after discovery/)
  } finally {
    await rm(workspace, {recursive: true, force: true})
    await rm(outside, {recursive: true, force: true})
  }
})

test('prepareReportFiles enforces report file count limit', async () => {
  const files = Array.from({length: MAX_REPORT_FILES + 1}, (_, index) => ({
    absolutePath: `/tmp/report-${index}.xml`,
    filename: `report-${index}.xml`,
    dev: 1,
    ino: index + 1,
  }))

  await assert.rejects(() => prepareReportFiles(files, noopCore()), /more than/)
})

function noopCore() {
  return {
    info() {},
  }
}

async function discoveredFile(absolutePath: string, filename: string): Promise<DiscoveredFile> {
  const resolvedPath = await realpath(absolutePath)
  const fileStat = await stat(resolvedPath)
  return {
    absolutePath: resolvedPath,
    filename,
    dev: fileStat.dev,
    ino: fileStat.ino,
  }
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
