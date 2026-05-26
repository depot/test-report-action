import assert from 'node:assert/strict'
import test from 'node:test'
import {DEPOT_OIDC_AUDIENCE, resolveReportCredential} from './credentials.js'

const DEPOT_CI_ENV = {
  GITHUB_ACTIONS: 'true',
  RUNNER_NAME: 'Depot CI',
  DEPOT_ORG_ID: 'org-123',
}

const DEPOT_CI_OIDC_REQUEST_URL = 'http://169.254.169.253/token?v=1'
const DEPOT_CI_OIDC_REQUEST_TOKEN = 'local'

type TestEnv = Record<string, string | undefined>

const NON_DEPOT_CI_ENVS: TestEnv[] = [
  {RUNNER_NAME: 'Depot CI', DEPOT_ORG_ID: 'org-123'},
  {GITHUB_ACTIONS: 'true', DEPOT_ORG_ID: 'org-123'},
  {GITHUB_ACTIONS: 'true', RUNNER_NAME: 'Depot CI'},
  {...DEPOT_CI_ENV, DEPOT_ORG_ID: ''},
  {...DEPOT_CI_ENV, DEPOT_ORG_ID: '   '},
  {...DEPOT_CI_ENV, RUNNER_NAME: 'GitHub Actions'},
  {...DEPOT_CI_ENV, GITHUB_ACTIONS: 'false'},
]

const PROCESS_ENV_KEYS = [
  'GITHUB_ACTIONS',
  'RUNNER_NAME',
  'DEPOT_ORG_ID',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
] as const

function restoreProcessEnv(originalEnv: TestEnv): void {
  for (const key of PROCESS_ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

test('DEPOT_OIDC_AUDIENCE matches the API verifier audience', () => {
  assert.equal(DEPOT_OIDC_AUDIENCE, 'https://depot.dev')
})

test('resolveReportCredential injects Depot CI metadata OIDC env vars', async () => {
  const env: TestEnv = {...DEPOT_CI_ENV}

  await resolveReportCredential(async () => 'oidc-token', env)

  assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_URL, DEPOT_CI_OIDC_REQUEST_URL)
  assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, DEPOT_CI_OIDC_REQUEST_TOKEN)
})

test('resolveReportCredential does not overwrite existing OIDC env vars', async () => {
  const env: TestEnv = {
    ...DEPOT_CI_ENV,
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'github-token',
  }

  await resolveReportCredential(async () => 'oidc-token', env)

  assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_URL, 'https://token.actions.githubusercontent.com')
  assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'github-token')
})

test('resolveReportCredential fills only missing OIDC env vars', async () => {
  const envWithUrl: TestEnv = {
    ...DEPOT_CI_ENV,
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com',
  }
  const envWithToken: TestEnv = {
    ...DEPOT_CI_ENV,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'github-token',
  }

  await resolveReportCredential(async () => 'oidc-token', envWithUrl)
  await resolveReportCredential(async () => 'oidc-token', envWithToken)

  assert.equal(envWithUrl.ACTIONS_ID_TOKEN_REQUEST_URL, 'https://token.actions.githubusercontent.com')
  assert.equal(envWithUrl.ACTIONS_ID_TOKEN_REQUEST_TOKEN, DEPOT_CI_OIDC_REQUEST_TOKEN)
  assert.equal(envWithToken.ACTIONS_ID_TOKEN_REQUEST_URL, DEPOT_CI_OIDC_REQUEST_URL)
  assert.equal(envWithToken.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'github-token')
})

test('resolveReportCredential does not inject without Depot CI markers', async () => {
  for (const baseEnv of NON_DEPOT_CI_ENVS) {
    const env = {...baseEnv}

    await resolveReportCredential(async () => 'oidc-token', env)
    assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_URL, undefined)
    assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined)
  }
})

test('resolveReportCredential requests the Depot audience-scoped OIDC token', async () => {
  const audiences: string[] = []
  const credential = await resolveReportCredential(async (audience) => {
    audiences.push(audience)
    return ' oidc-token '
  }, {})

  assert.deepEqual(audiences, [DEPOT_OIDC_AUDIENCE])
  assert.deepEqual(credential, {token: 'oidc-token'})
})

test('resolveReportCredential configures Depot CI OIDC env before requesting a token', async () => {
  const env: TestEnv = {...DEPOT_CI_ENV}

  const credential = await resolveReportCredential(async () => {
    assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_URL, DEPOT_CI_OIDC_REQUEST_URL)
    assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, DEPOT_CI_OIDC_REQUEST_TOKEN)
    return ' oidc-token '
  }, env)

  assert.deepEqual(credential, {token: 'oidc-token'})
})

test('resolveReportCredential configures process.env by default in Depot CI', async () => {
  const originalEnv: TestEnv = {}
  for (const key of PROCESS_ENV_KEYS) {
    originalEnv[key] = process.env[key]
  }

  try {
    process.env.GITHUB_ACTIONS = 'true'
    process.env.RUNNER_NAME = 'Depot CI'
    process.env.DEPOT_ORG_ID = 'org-123'
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN

    const credential = await resolveReportCredential(async () => {
      assert.equal(process.env.ACTIONS_ID_TOKEN_REQUEST_URL, DEPOT_CI_OIDC_REQUEST_URL)
      assert.equal(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, DEPOT_CI_OIDC_REQUEST_TOKEN)
      return ' oidc-token '
    })

    assert.deepEqual(credential, {token: 'oidc-token'})
  } finally {
    restoreProcessEnv(originalEnv)
  }
})

test('resolveReportCredential returns null when OIDC returns an empty token', async () => {
  const credential = await resolveReportCredential(async () => '   ', {})

  assert.equal(credential, null)
})

test('resolveReportCredential returns null when OIDC is unavailable', async () => {
  const credential = await resolveReportCredential(async () => {
    throw new Error('OIDC unavailable')
  }, {})

  assert.equal(credential, null)
})

test('resolveReportCredential returns null without injecting when non-Depot OIDC is unavailable', async () => {
  const env: TestEnv = {
    GITHUB_ACTIONS: 'true',
    RUNNER_NAME: 'GitHub Actions',
  }
  const credential = await resolveReportCredential(async () => {
    throw new Error('OIDC unavailable')
  }, env)

  assert.equal(credential, null)
  assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_URL, undefined)
  assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined)
})
