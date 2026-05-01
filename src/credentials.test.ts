import assert from 'node:assert/strict'
import test from 'node:test'
import {DEPOT_OIDC_AUDIENCE, resolveReportCredential} from './credentials.js'

test('DEPOT_OIDC_AUDIENCE matches the API verifier audience', () => {
  assert.equal(DEPOT_OIDC_AUDIENCE, 'https://depot.dev')
})

test('resolveReportCredential requests the Depot audience-scoped OIDC token', async () => {
  const audiences: string[] = []
  const credential = await resolveReportCredential(async (audience) => {
    audiences.push(audience)
    return ' oidc-token '
  })

  assert.deepEqual(audiences, [DEPOT_OIDC_AUDIENCE])
  assert.deepEqual(credential, {token: 'oidc-token'})
})

test('resolveReportCredential returns null when OIDC returns an empty token', async () => {
  const credential = await resolveReportCredential(async () => '   ')

  assert.equal(credential, null)
})

test('resolveReportCredential returns null when OIDC is unavailable', async () => {
  const credential = await resolveReportCredential(async () => {
    throw new Error('OIDC unavailable')
  })

  assert.equal(credential, null)
})
