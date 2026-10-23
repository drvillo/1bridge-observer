import { randomBytes } from 'node:crypto'
import pg from 'pg'

export async function createDisposableDatabase(adminUrl: string): Promise<{
  databaseUrl: string
  drop(): Promise<void>
}> {
  const name = `observer_${randomBytes(4).toString('hex')}`
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end()
  }
  const databaseUrl = new URL(adminUrl)
  databaseUrl.pathname = `/${name}`
  return {
    databaseUrl: databaseUrl.toString(),
    drop: async () => {
      const closer = new pg.Client({ connectionString: adminUrl })
      await closer.connect()
      try {
        await closer.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      } finally {
        await closer.end()
      }
    },
  }
}
