import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { cpus, platform, release } from 'node:os'
import { join } from 'node:path'

const authorityDependency = 'github:drvillo/1bridge-authority#297f81d11ed3cee75f01d561a71da15de8e75697'
const authorityBuildSha256 = '204e58bcc1363f188715dc40bad202b5d5515feb955e4ec7cb2b2ad5c69a0a99'

async function installedAuthorityDigest(): Promise<string> {
  const packageRoot = join(process.cwd(), 'node_modules', '@drvillo', '1bridge-authority')
  const files = ['package.json', ...(await readdir(join(packageRoot, 'dist')))
    .filter(file => file.endsWith('.js')).sort().map(file => `dist/${file}`)]
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file).update('\0').update(await readFile(join(packageRoot, file))).update('\0')
  }
  return hash.digest('hex')
}

/** Requires clean exact source, reviewed authority build and a pinned disposable Postgres image. */
export async function readBenchmarkProvenance() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  if (pkg.dependencies['@drvillo/1bridge-authority'] !== authorityDependency
    || await installedAuthorityDigest() !== authorityBuildSha256) {
    throw new Error('Installed authority package differs from the pinned clean build')
  }
  const observerCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const observerDirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== ''
  if (observerDirty && process.env.OBSERVER_BENCH_ALLOW_DIRTY !== '1') {
    throw new Error('Commit the observer benchmark runner before recording final samples')
  }
  const postgresImage = process.env.OBSERVER_TEST_POSTGRES_IMAGE
  const postgresImageId = process.env.OBSERVER_TEST_POSTGRES_IMAGE_ID
  const postgresImageArchitecture = process.env.OBSERVER_TEST_POSTGRES_IMAGE_ARCHITECTURE
  if (!postgresImage?.startsWith('postgres@sha256:')
    || !/^sha256:[0-9a-f]{64}$/.test(postgresImageId ?? '')
    || !postgresImageArchitecture) {
    throw new Error('Benchmark requires a pinned Postgres image and inspected image provenance')
  }
  return { observerCommit, observerDirty, authorityDependency, authorityBuildSha256,
    environment: { node: process.version, platform: platform(), release: release(),
      cpuModel: cpus()[0]?.model ?? 'unknown', cpuCount: cpus().length,
      postgresImage, postgresImageId, postgresImageArchitecture } }
}
