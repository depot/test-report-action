# Depot Test Report Action

Upload JUnit XML test reports from Depot CI jobs and jobs using Depot GitHub
Action runners so Depot can show parsed test failures and counts in the
dashboard.

## Usage

```yaml
steps:
  - run: npm test -- --reporter=junit --outputFile=test-results/junit.xml

  - uses: depot/test-report-action@v1
    if: ${{ !cancelled() }}
    with:
      path: test-results/
```

The `if: ${{ !cancelled() }}` guard is recommended because test commands often
exit non-zero when tests fail. Without the guard, GitHub Actions semantics skip
later steps and the report upload will not run for the failures you most need to
inspect.

This action is for Depot CI jobs and jobs using Depot GitHub Action runners. It
requests an OIDC token for Depot; workflow authors do not pass a
token to this action.

Depot CI uses native sandbox OIDC automatically. Jobs using Depot GitHub Action
runners run under GitHub Actions and require the normal GitHub OIDC permission:

```yaml
permissions:
  id-token: write
```

## Inputs

| Input  | Required | Default                           | Description                                                             |
| ------ | -------- | --------------------------------- | ----------------------------------------------------------------------- |
| `path` | Yes      | None                              | Path or glob for JUnit XML reports. Newline-separated values are valid. |
| `key`  | No       | `GITHUB_ACTION`, then `"default"` | Optional invocation key for duplicate detection.                        |

When `path` points at a directory, the action uploads `**/*.xml` under that
directory. When `path` is a file or glob, the action uses it as provided.
Your test command must write JUnit XML before this action runs.

Matched report files must resolve inside `GITHUB_WORKSPACE` and may not exceed
1,000 files, 50 MiB each, or 100 MiB total before compression.

## Outputs

| Output                 | Description                                                             |
| ---------------------- | ----------------------------------------------------------------------- |
| `files-processed`      | Number of files accepted by Depot.                                      |
| `files-skipped`        | Number of files skipped by Depot during ingest.                         |
| `tests-reported`       | Number of tests parsed from accepted reports.                           |
| `duplicate-invocation` | Whether Depot ignored this upload because the invocation was duplicate. |

## Multiple Paths

```yaml
- uses: depot/test-report-action@v1
  if: ${{ !cancelled() }}
  with:
    path: |
      test-results/rspec/
      test-results/playwright/
```

## Multiple Action Steps

Use a different `key` only when the same job calls this action more than once.
Depot uses the key to deduplicate each upload invocation; test suites are still
derived from the JUnit XML contents.

```yaml
- uses: depot/test-report-action@v1
  if: ${{ !cancelled() }}
  with:
    path: test-results/part-1/
    key: upload-1

- uses: depot/test-report-action@v1
  if: ${{ !cancelled() }}
  with:
    path: test-results/part-2/
    key: upload-2
```

## Behavior

Missing or blank `path` and zero matching files fail the action by default.
Unsupported runner environments, missing OIDC permission on Depot GitHub Action
runner jobs, and Depot upload failures are logged as warnings and do not fail
the job.
When OIDC credentials are unavailable, the action skips before reading and
compressing matched report contents, so report size limits are only checked when
an upload is attempted.

If invalid path configuration should also be best-effort for a workflow, opt
into GitHub Actions' native behavior:

```yaml
- uses: depot/test-report-action@v1
  if: ${{ !cancelled() }}
  continue-on-error: true
  with:
    path: test-results/
```

Duplicate invocations are treated as successful no-ops. Step summary write
failures are logged at debug level and do not fail the action.

## License

MIT License - see [LICENSE](LICENSE) for details.
