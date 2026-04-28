export interface ActionInputs {
  pathInput: string
  invocationKey: string
  token: string
  workspace: string
}

export function parseInputs(
  pathInputValue: string,
  keyInputValue: string | undefined,
  env: NodeJS.ProcessEnv,
): ActionInputs {
  const pathInput = pathInputValue.trim()
  if (!pathInput) {
    throw new Error(
      'Missing required input "path". Provide a JUnit XML report path, directory, glob, or multiline list.',
    )
  }

  const invocationKey = resolveInvocationKey(keyInputValue, env.GITHUB_ACTION)
  const token = resolveToken(env)
  const workspace = env.GITHUB_WORKSPACE || process.cwd()

  return {pathInput, invocationKey, token, workspace}
}

export function resolveInvocationKey(keyInput: string | undefined, githubAction: string | undefined): string {
  return keyInput?.trim() || githubAction?.trim() || 'default'
}

export function resolveToken(env: NodeJS.ProcessEnv): string {
  const token = env.DEPOT_TOKEN?.trim()
  if (token) return token
  throw new Error('Depot test report credentials are unavailable. This action must run in Depot CI.')
}
