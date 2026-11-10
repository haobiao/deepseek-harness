/**
 * Publication policy for the unsigned Windows release: one Release per product
 * version, fixed tag, replaceable assets, and reuse from the nightly sync.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

interface Job {
  if?: string
  needs?: string | string[]
  permissions?: Record<string, string>
  'runs-on'?: string
  'timeout-minutes'?: number
  uses?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
  outputs?: Record<string, string>
  defaults?: { run?: { shell?: string } }
  steps?: { name?: string; run?: string; uses?: string; id?: string; env?: Record<string, string>; with?: Record<string, unknown> }[]
}

interface Workflow {
  on: Record<string, unknown>
  permissions?: Record<string, string>
  concurrency?: Record<string, unknown>
  jobs: Record<string, Job>
}

function workflow(file: string): Workflow {
  return load(readFileSync(resolve(root, '.github/workflows', file), 'utf8')) as Workflow
}

const publication = workflow('publish-unsigned-release.yml')
const nightly = workflow('nightly-upstream-sync.yml')

function job(workflowFile: Workflow, name: string): Job {
  const value = workflowFile.jobs[name]
  if (!value) throw new TypeError(`missing job: ${name}`)
  return value
}

function step(workflowJob: Job, name: string) {
  const value = workflowJob.steps?.find(candidate => candidate.name === name)
  if (!value) throw new TypeError(`missing step: ${name}`)
  return value
}

describe('unsigned Windows release publication', () => {
  it('is only reachable by manual dispatch or reuse from another workflow', () => {
    expect(Object.keys(publication.on).sort()).toEqual(['workflow_call', 'workflow_dispatch'])
  })

  it('keeps the workflow token read-only except where dispatch and publishing need it', () => {
    expect(publication.permissions).toMatchObject({ contents: 'read', actions: 'read' })
    expect(job(publication, 'resolve').permissions).toMatchObject({ contents: 'read', actions: 'write' })
    expect(job(publication, 'publish').permissions).toMatchObject({ contents: 'write', actions: 'read' })
  })

  it('compiles a fresh installer on manual dispatch instead of reusing history', () => {
    const inputs = (publication.on.workflow_dispatch as { inputs: Record<string, unknown> }).inputs
    expect(inputs).not.toHaveProperty('package_run_id')
    expect(inputs).not.toHaveProperty('package_run_attempt')
    expect(inputs).toMatchObject({
      preset: { default: 'test' },
      update_channel: { default: 'nightly' },
      compression_level: { default: '7' },
    })
    const build = step(job(publication, 'resolve'), 'Build or resolve the packaging run')
    expect(build.run).toContain('if [ "$TRIGGER" = "workflow_dispatch" ]')
    expect(build.run).toContain('gh workflow run windows-package.yml')
    expect(build.run).toContain('--ref master')
    expect(build.run).toContain('-f signing=unsigned')
    expect(build.run).toContain('gh run watch')
    // No historical-run auto-selection loop.
    expect(build.run).not.toContain('--limit 30')
    const callInputs = (publication.on.workflow_call as { inputs: Record<string, { required?: boolean }> }).inputs
    expect(callInputs.package_run_id?.required).toBe(true)
    // Waiting on the build it dispatched needs a runner budget larger than the
    // packaging job's own 120-minute cap.
    expect(job(publication, 'resolve')['timeout-minutes']).toBeGreaterThan(120)
  })

  it('never interpolates secrets into the workflow', () => {
    expect(JSON.stringify(publication)).not.toContain('secrets.')
  })

  it('builds the tag from the packaged product version instead of the artifact name', () => {
    const version = step(job(publication, 'resolve'), 'Derive product version and fixed release tag')
    expect(version.run).toContain("version('apps/desktop/package.json')")
    expect(version.run).toContain("version('package.json')")
    expect(version.run).toContain('win-unsigned-v${desktop}')
    const checkout = job(publication, 'resolve').steps?.find(candidate => candidate.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with?.ref).toBe('${{ steps.run.outputs.commit }}')
  })

  it('only accepts an unexpired unsigned artifact from the packaging attempt it publishes', () => {
    const resolveRun = step(job(publication, 'resolve'), 'Build or resolve the packaging run')
    expect(resolveRun.run).toContain('windows-x64-unsigned-hosted-')
    expect(resolveRun.run).toContain('select(.expired == false)')
    expect(resolveRun.run).toContain(String.raw`endswith("-\($id)-\($attempt)")`)
    expect(resolveRun.run).toContain('attempts/$attempt')
  })

  it('refuses a second Release for a version that already exists', () => {
    const guard = step(job(publication, 'resolve'), 'Reject a conflicting release for the same version')
    expect(guard.run).toContain('releases?per_page=100')
    expect(guard.run).toContain('sub("^win-unsigned-"; "")')
    expect(guard.run).toContain('sub("^v"; "")')
    expect(guard.run).toContain('git/ref/tags/$TAG')
    expect(guard.run).toContain('REPLACE_ASSETS')
    // A release from another tag family must never have its assets replaced.
    expect(guard.run).toContain('if [ -n "$conflict" ]')
    expect(guard.run).toContain('select(.tag_name != $tag)')
  })

  it('verifies the installer is unsigned and version-compatible before publishing', () => {
    const verify = step(job(publication, 'publish'), 'Verify installer is an unsigned Windows build')
    expect(verify.run).toContain('^deepseek-harness-(?<version>.+)-win-x64-unsigned\\.exe$')
    expect(verify.run).toContain('Get-AuthenticodeSignature')
    expect(verify.run).toContain("$signature.Status -ne 'NotSigned'")
    expect(verify.run).toContain('StartsWith($env:PRODUCT_VERSION +')
    expect(verify.run).toContain('SHA256SUMS')
    expect(verify.run).toContain('20MB')
  })

  it('replaces assets in place so the Release URL stays stable', () => {
    const release = step(job(publication, 'publish'), 'Create or replace the versioned release')
    expect(release.run).toContain('gh release upload $env:TAG')
    expect(release.run).toContain('--clobber')
    expect(release.run).toContain('gh release delete-asset')
    expect(release.run).toContain('gh release edit')
    expect(release.run).toContain("'release', 'create', $env:TAG")
    for (const trigger of ['workflow_dispatch', 'workflow_call']) {
      const inputs = (publication.on[trigger] as { inputs: Record<string, { default?: unknown }> }).inputs
      expect(inputs.replace_assets?.default).toBe(true)
    }
  })

  it('runs the native Windows verification on PowerShell', () => {
    const publish = job(publication, 'publish')
    expect(publish['runs-on']).toBe('windows-latest')
    expect(publish.defaults?.run?.shell).toBe('pwsh')
  })
})

describe('nightly upstream sync publication', () => {
  it('exposes the packaging run id for the publishing job', () => {
    expect(job(nightly, 'package').outputs?.run_id).toBe('${{ steps.watch.outputs.run_id }}')
    const watch = step(job(nightly, 'package'), 'Wait for packaging result')
    expect(watch.id).toBe('watch')
    expect(watch.run).toContain('run_id=$run_id')
  })

  it('publishes unsigned packages right after a successful packaging run', () => {
    const publish = job(nightly, 'publish')
    expect(publish.uses).toBe('./.github/workflows/publish-unsigned-release.yml')
    expect(publish.needs).toEqual(['sync', 'package'])
    expect(publish.if).toContain("needs.package.result == 'success'")
    expect(publish.if).toContain('needs.package.outputs.run_id')
    expect(publish.if).toContain("(inputs.signing || 'unsigned') == 'unsigned'")
    // The reusable workflow's resolve job requests actions: write, so the
    // caller must grant at least that much.
    expect(publish.permissions).toMatchObject({ contents: 'write', actions: 'write' })
    expect(publish.with).toMatchObject({
      package_run_id: '${{ needs.package.outputs.run_id }}',
      replace_assets: true,
    })
  })

  it('reports publication failures through the existing failure issue', () => {
    expect(job(nightly, 'notify').needs).toEqual(['sync', 'package', 'publish'])
  })
})
