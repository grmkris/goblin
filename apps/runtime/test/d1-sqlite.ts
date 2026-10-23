import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { fake } from './fake.ts'

/** A statement's SQL and its bound values, as `prepare` and `bind` made it. */
type Bound = { readonly sql: string; readonly params: readonly SQLInputValue[] }

/** Whether `sql` reads rows: a select, or a write that answers rows (`returning`). */
const readsRows = (sql: string): boolean => /^\s*(?:select|with|pragma)\b/iu.test(sql) || /\breturning\b/iu.test(sql)

/**
 * A D1 database over node:sqlite, for the code that calls D1's own API (`prepare`, `bind`, `first`, `all`, `run`,
 * `batch` and `exec`) against the real auth migrations, Better Auth's own D1 dialect included (which reads `all`'s
 * `meta`). A batch runs in one transaction, as D1 runs one. The code under test reaches only these members of the
 * database and its statements.
 */
export const d1Of = (db: DatabaseSync): D1Database => {
  const bound = new WeakMap<D1PreparedStatement, Bound>()
  const statement = (sql: string, params: readonly SQLInputValue[] = []): D1PreparedStatement => {
    const made = fake<D1PreparedStatement>({
      bind: (...values: unknown[]) => statement(sql, values.map(valueOf)),
      first: <T>(column?: string) => {
        const row = db.prepare(sql).get(...params)
        // SAFETY: the caller names the row's shape (`first<Row>()`), as it does against D1, which checks nothing either.
        return Promise.resolve(row === undefined ? null : column === undefined ? row : row[column]) as Promise<T>
      },
      all: <T>() => {
        const prepared = db.prepare(sql)
        if (!readsRows(sql)) {
          const { changes, lastInsertRowid } = prepared.run(...params)
          const meta = { changes: Number(changes), last_row_id: Number(lastInsertRowid) }
          return Promise.resolve(fake<D1Result<T>>({ results: [], success: true, meta: fake<D1Result['meta']>(meta) }))
        }
        // SAFETY: as for `first`, the caller names the rows' shape.
        const results = prepared.all(...params) as T[]
        const meta = fake<D1Result['meta']>({ changes: results.length, last_row_id: 0 })
        return Promise.resolve(fake<D1Result<T>>({ results, success: true, meta }))
      },
      run: <T>() => {
        db.prepare(sql).run(...params)
        return Promise.resolve(fake<D1Result<T>>({ success: true, results: [] }))
      },
    })
    bound.set(made, { sql, params })
    return made
  }
  const batch = <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    db.exec('BEGIN')
    try {
      // As D1's batch does: each statement's rows, none for a write.
      const answers = statements.map((each) => {
        const { sql, params } = bound.get(each) ?? { sql: '', params: [] }
        const prepared = db.prepare(sql)
        if (!/^\s*(?:select|with)\b/iu.test(sql)) {
          prepared.run(...params)
          return fake<D1Result<T>>({ success: true, results: [] })
        }
        // SAFETY: as for `all`, the caller names the rows' shape.
        return fake<D1Result<T>>({ success: true, results: prepared.all(...params) as T[] })
      })
      db.exec('COMMIT')
      return Promise.resolve(answers)
    } catch (cause) {
      db.exec('ROLLBACK')
      return Promise.reject(cause)
    }
  }
  const exec = (sql: string) => {
    db.exec(sql)
    return Promise.resolve(fake<D1ExecResult>({ count: 1, duration: 0 }))
  }
  return fake<D1Database>({ prepare: (sql: string) => statement(sql), batch, exec })
}

/** A bound value as node:sqlite takes it: D1 binds strings, numbers and nulls here. */
const valueOf = (value: unknown): SQLInputValue =>
  typeof value === 'string' || typeof value === 'number' || value === null ? value : JSON.stringify(value)
