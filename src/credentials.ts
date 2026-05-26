export const DEPOT_OIDC_AUDIENCE = 'https://depot.dev'
const DEPOT_CI_OIDC_REQUEST_URL = 'http://169.254.169.253/token?v=1'
const DEPOT_CI_OIDC_REQUEST_TOKEN = 'local'

type Env = Record<string, string | undefined>

export interface ReportCredential {
  token: string
}

function isRunningInDepotCI(env: Env): boolean {
  return env.GITHUB_ACTIONS === 'true' && env.RUNNER_NAME === 'Depot CI' && Boolean(env.DEPOT_ORG_ID?.trim())
}

function configureDepotCIOIDCEnv(env: Env): void {
  if (!isRunningInDepotCI(env)) return

  env.ACTIONS_ID_TOKEN_REQUEST_URL ||= DEPOT_CI_OIDC_REQUEST_URL
  env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ||= DEPOT_CI_OIDC_REQUEST_TOKEN
}

export async function resolveReportCredential(
  requestIDToken: (audience: string) => Promise<string>,
  env: Env = process.env,
): Promise<ReportCredential | null> {
  try {
    configureDepotCIOIDCEnv(env)

    const oidcToken = (await requestIDToken(DEPOT_OIDC_AUDIENCE)).trim()
    if (oidcToken) return {token: oidcToken}
  } catch {
    // Missing id-token permission or unsupported runner environment.
  }

  return null
}
