import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { RuntimeEnv } from '../../src/env.ts'
import { d1Of } from '../d1-sqlite.ts'
import { APP } from './issuer.ts'

/** Every real auth migration over local SQLite, including populated server grants and workspace membership. */
export const authFixture = () => {
  const db = new DatabaseSync(':memory:')
  const directory = new URL('../../migrations/', import.meta.url).pathname
  db.exec('PRAGMA foreign_keys = ON')
  for (const name of readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .toSorted())
    db.exec(readFileSync(join(directory, name), 'utf8'))
  const now = new Date().toISOString()
  for (const id of ['1', '2']) {
    db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)').run(
      `u${id}`,
      `User ${id}`,
      `user${id}@example.test`,
      now,
      now,
    )
    db.prepare('INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)').run(
      `w${id}`,
      `Workspace ${id}`,
      `workspace-${id}`,
      now,
    )
    db.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)').run(
      `m${id}`,
      `w${id}`,
      `u${id}`,
      'owner',
      now,
    )
  }
  const env: RuntimeEnv = Object.assign(Object.create(null), {
    APP_URL: APP,
    BETTER_AUTH_SECRET: 'workload-fixture-secret-at-least-32-characters',
    AUTH_DB: d1Of(db),
  })
  return { db, env }
}
