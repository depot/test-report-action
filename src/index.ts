import * as core from '@actions/core'
import {create} from '@bufbuild/protobuf'
import {createClient} from '@connectrpc/connect'
import {createConnectTransport} from '@connectrpc/connect-node'
import {parseInputs, type ActionInputs} from './action-inputs.js'
import {
  ReportTestResultsRequestSchema,
  TestResultsService,
  type ReportTestResultsRequest,
  type ReportTestResultsResponse,
} from './gen/depot/testresults/v1/test_results_pb.js'
import {discoverTestResultFiles, prepareReportFiles, splitPathInput} from './report-files.js'

const DEFAULT_API_URL = 'https://api.depot.dev'
const REPORT_RPC_TIMEOUT_MS = 60_000

interface ReportContext {
  requestHeaders: Record<string, string>
}

async function run() {
  const inputs = readInputs()
  core.setSecret(inputs.token)

  core.info(`Using invocation key "${inputs.invocationKey}"`)

  const files = await core.group('Discovering test reports', () =>
    discoverTestResultFiles(inputs.pathInput, {workspace: inputs.workspace}),
  )
  core.info(`Matched ${files.length} test report file${files.length === 1 ? '' : 's'}`)
  for (const file of files) {
    core.debug(`Matched test report file: ${file.filename}`)
  }

  if (files.length === 0) {
    throw new Error(`No test report files matched: ${formatInputForLog(inputs.pathInput)}`)
  }

  const reportFiles = await core.group('Preparing upload', () => prepareReportFiles(files, core))
  const request = create(ReportTestResultsRequestSchema, {
    invocationId: inputs.invocationKey,
    files: reportFiles,
  })
  const reportContext: ReportContext = {
    requestHeaders: {
      Authorization: `Bearer ${inputs.token}`,
    },
  }
  const response = await reportTestResults(request, reportContext).catch((error: unknown) => {
    throw new Error(`Depot test report upload failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  setOutputs(response)
  await writeSummarySafely(files.length, response)
  logResponse(response)
}

function readInputs(): ActionInputs {
  return parseInputs(core.getInput('path'), core.getInput('key'), process.env)
}

async function reportTestResults(request: ReportTestResultsRequest, context: ReportContext) {
  const transport = createConnectTransport({
    baseUrl: DEFAULT_API_URL,
    httpVersion: '2',
    defaultTimeoutMs: REPORT_RPC_TIMEOUT_MS,
    interceptors: [
      (next) => (req) => {
        for (const [name, value] of Object.entries(context.requestHeaders)) {
          req.header.set(name, value)
        }
        return next(req)
      },
    ],
  })
  const client = createClient(TestResultsService, transport)

  return client.reportTestResults(request)
}

function setOutputs(response: ReportTestResultsResponse) {
  core.setOutput('files-processed', response.filesProcessed)
  core.setOutput('files-skipped', response.filesSkipped)
  core.setOutput('tests-reported', response.testsReported)
  core.setOutput('duplicate-invocation', response.duplicateInvocation)
}

async function writeSummary(matchedFiles: number, response: ReportTestResultsResponse) {
  await core.summary
    .addHeading('Depot Test Reports')
    .addTable([
      [
        {data: 'Matched files', header: true},
        {data: 'Processed files', header: true},
        {data: 'Skipped files', header: true},
        {data: 'Tests reported', header: true},
      ],
      [
        String(matchedFiles),
        String(response.filesProcessed),
        String(response.filesSkipped),
        String(response.testsReported),
      ],
    ])
    .write()
}

async function writeSummarySafely(matchedFiles: number, response: ReportTestResultsResponse) {
  try {
    await writeSummary(matchedFiles, response)
  } catch (error) {
    core.debug(`Failed to write step summary: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function logResponse(response: ReportTestResultsResponse) {
  core.info(
    `files_processed=${response.filesProcessed} files_skipped=${response.filesSkipped} tests_reported=${response.testsReported} duplicate_invocation=${response.duplicateInvocation}`,
  )

  if (response.duplicateInvocation) {
    core.info('Depot ignored this upload because this invocation was already reported.')
    return
  }

  core.info(
    `Depot processed ${response.filesProcessed} file${response.filesProcessed === 1 ? '' : 's'} and reported ${
      response.testsReported
    } test${response.testsReported === 1 ? '' : 's'}.`,
  )

  if (response.filesSkipped > 0) {
    core.warning(`Depot skipped ${response.filesSkipped} file${response.filesSkipped === 1 ? '' : 's'} during ingest.`)
  }

  if (response.testsReported === 0) {
    core.warning('Depot did not report any tests from this upload.')
  }
}

function formatInputForLog(input: string): string {
  return splitPathInput(input).join(', ') || '<empty>'
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  core.setFailed(message)
})
