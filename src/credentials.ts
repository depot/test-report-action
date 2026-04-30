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
  } catch {
    // Missing id-token permission or unsupported runner environment.
  }

  return null
}
