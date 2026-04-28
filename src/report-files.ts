import * as glob from '@actions/glob'
import {create} from '@bufbuild/protobuf'
import {constants, promises as fs} from 'node:fs'
import * as path from 'node:path'
import {promisify} from 'node:util'
import {gzip} from 'node:zlib'
import {TestResultsFileSchema, type TestResultsFile} from './gen/depot/testresults/v1/test_results_pb.js'

const gzipAsync = promisify(gzip)
const MAX_REPORT_FILE_BYTES = 50 * 1024 * 1024
const MAX_REPORT_TOTAL_BYTES = 100 * 1024 * 1024
const READ_REGULAR_FILE_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

export interface DiscoveredFile {
  absolutePath: string
  filename: string
  dev: number
  ino: number
}

export const MAX_REPORT_FILES = 1000

interface DiscoverOptions {
  workspace?: string
}

interface Logger {
  info(message: string): void
}

export function splitPathInput(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export async function discoverTestResultFiles(input: string, options: DiscoverOptions = {}): Promise<DiscoveredFile[]> {
  const workspace = await fs.realpath(path.resolve(options.workspace || process.env.GITHUB_WORKSPACE || process.cwd()))
  const patterns = await expandDirectoryInputs(splitPathInput(input), workspace)
  const globber = await glob.create(patterns.join('\n'), {
    followSymbolicLinks: false,
    matchDirectories: false,
  })
  const seen = new Set<string>()
  const files: DiscoveredFile[] = []

  for await (const match of globber.globGenerator()) {
    const absolutePath = path.resolve(match)
    const realPath = await fs.realpath(absolutePath)
    if (!isInsideWorkspace(workspace, realPath)) {
      throw new Error(`Matched test report file is outside the workspace: ${absolutePath}`)
    }
    if (seen.has(realPath)) continue
    seen.add(realPath)

    const stat = await fs.stat(realPath)
    if (!stat.isFile()) continue
    if (files.length >= MAX_REPORT_FILES) {
      throw new Error(`Matched more than ${MAX_REPORT_FILES} test report files.`)
    }

    files.push({
      absolutePath: realPath,
      filename: path.relative(workspace, realPath).split(path.sep).join('/'),
      dev: stat.dev,
      ino: stat.ino,
    })
  }

  files.sort((a, b) => a.filename.localeCompare(b.filename))
  return files
}

export async function prepareReportFiles(files: DiscoveredFile[], logger: Logger): Promise<TestResultsFile[]> {
  if (files.length > MAX_REPORT_FILES) {
    throw new Error(`Matched more than ${MAX_REPORT_FILES} test report files.`)
  }

  const prepared: TestResultsFile[] = []
  let totalBytes = 0
  let totalGzippedBytes = 0

  for (const file of files) {
    const handle = await fs.open(file.absolutePath, READ_REGULAR_FILE_FLAGS)
    let contents: Buffer
    let fileBytes = 0
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) {
        throw new Error(`Matched test report is not a regular file: ${file.filename}`)
      }
      if (stat.dev !== file.dev || stat.ino !== file.ino) {
        throw new Error(`Test report file changed after discovery: ${file.filename}`)
      }
      fileBytes = stat.size
      if (fileBytes > MAX_REPORT_FILE_BYTES) {
        throw new Error(
          `Test report file ${file.filename} is ${formatBytes(fileBytes)}, exceeding the ${formatBytes(
            MAX_REPORT_FILE_BYTES,
          )} per-file limit.`,
        )
      }

      if (totalBytes + fileBytes > MAX_REPORT_TOTAL_BYTES) {
        throw new Error(
          `Matched test reports exceed the ${formatBytes(MAX_REPORT_TOTAL_BYTES)} total uncompressed size limit.`,
        )
      }

      contents = await handle.readFile()
    } finally {
      await handle.close()
    }

    if (contents.byteLength > MAX_REPORT_FILE_BYTES) {
      throw new Error(
        `Test report file ${file.filename} is ${formatBytes(contents.byteLength)}, exceeding the ${formatBytes(
          MAX_REPORT_FILE_BYTES,
        )} per-file limit.`,
      )
    }

    if (totalBytes + contents.byteLength > MAX_REPORT_TOTAL_BYTES) {
      throw new Error(
        `Matched test reports exceed the ${formatBytes(MAX_REPORT_TOTAL_BYTES)} total uncompressed size limit.`,
      )
    }

    const gzipped = await gzipAsync(contents)
    totalBytes += contents.byteLength
    totalGzippedBytes += gzipped.byteLength
    prepared.push(
      create(TestResultsFileSchema, {
        filename: file.filename,
        gzippedXml: gzipped,
      }),
    )
  }

  logger.info(`Compressed ${formatBytes(totalBytes)} of XML into ${formatBytes(totalGzippedBytes)}`)
  return prepared
}

function isInsideWorkspace(workspace: string, filePath: string): boolean {
  const relative = path.relative(workspace, filePath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function expandDirectoryInputs(inputs: string[], workspace: string): Promise<string[]> {
  const patterns: string[] = []

  for (const input of inputs) {
    const absolutePath = path.isAbsolute(input) ? path.resolve(input) : path.join(workspace, input)
    const realSearchRoot = await validateSearchRoot(input, absolutePath, workspace)

    let stat: Awaited<ReturnType<typeof fs.stat>> | undefined
    try {
      stat = await fs.stat(absolutePath)
    } catch {
      stat = undefined
    }

    if (stat?.isDirectory()) {
      await rejectWorkspaceRootDirectory(input, absolutePath, workspace)
      patterns.push(path.join(absolutePath, '**/*.xml'))
    } else {
      rejectWorkspaceRootRecursiveGlob(input, absolutePath, realSearchRoot, workspace)
      patterns.push(absolutePath)
    }
  }

  return patterns
}

async function validateSearchRoot(input: string, absoluteInput: string, workspace: string) {
  const searchRoot = findSearchRoot(absoluteInput)
  const realSearchRoot = await realExistingPath(searchRoot)
  if (!isInsideWorkspace(workspace, realSearchRoot)) {
    throw new Error(`Test report path is outside the workspace: ${input}`)
  }
  return realSearchRoot
}

async function rejectWorkspaceRootDirectory(input: string, absoluteInput: string, workspace: string) {
  const realInput = await fs.realpath(absoluteInput)
  if (realInput === workspace) {
    throw new Error(`Test report path is too broad; use a report subdirectory instead: ${input}`)
  }
}

function rejectWorkspaceRootRecursiveGlob(
  input: string,
  absoluteInput: string,
  realSearchRoot: string,
  workspace: string,
) {
  if (realSearchRoot === workspace && hasRecursiveGlob(absoluteInput)) {
    throw new Error(`Test report path is too broad; use a report subdirectory instead: ${input}`)
  }
}

function hasRecursiveGlob(pattern: string): boolean {
  return pattern.split(path.sep).includes('**')
}

function findSearchRoot(pattern: string): string {
  const parsed = path.parse(pattern)
  const segments = path.relative(parsed.root, pattern).split(path.sep)
  let searchRoot = parsed.root

  for (const segment of segments) {
    if (!segment || hasGlobPatternCharacter(segment)) break
    searchRoot = path.join(searchRoot, segment)
  }

  return searchRoot
}

function hasGlobPatternCharacter(segment: string): boolean {
  return /[*?\[]/.test(segment)
}

async function realExistingPath(filePath: string): Promise<string> {
  let current = path.resolve(filePath)

  while (true) {
    try {
      return await fs.realpath(current)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) throw new Error(`Unable to resolve test report path: ${filePath}`)
      current = parent
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib.toFixed(1)} KiB`
  return `${(kib / 1024).toFixed(1)} MiB`
}
