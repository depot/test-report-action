import * as core from '@actions/core'

export const DEPOT_OIDC_AUDIENCE = 'https://depot.dev'

export interface ReportCredential {
  token: string
}

export async function resolveReportCredential(
  requestIDToken: (audience: string) => Promise<string>,
): Promise<ReportCredential | null> {
  try {
    const oidcToken = (await requestIDToken(DEPOT_OIDC_AUDIENCE)).trim()
    if (oidcToken) return {token: oidcToken}

    core.warning('Unable to acquire Depot OIDC credential: OIDC token request returned an empty token')
  } catch (error) {
    core.warning(`Unable to acquire Depot OIDC credential: ${error instanceof Error ? error.message : String(error)}`)
  }

  return null
}
