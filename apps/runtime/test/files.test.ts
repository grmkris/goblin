import { describe, expect, it } from 'vitest'
import { OWNER_VIEW, CLOSED_VIEW, pathIn, viewOf } from '../src/files/folders.ts'
import { fileDirectory, filePath, mayWrite } from '../src/files/store.ts'
import { Forbidden } from '../src/http/errors.ts'

describe('file paths', () => {
  it('accept the Shared areas, the Topic folders and plain paths under them', () => {
    expect(fileDirectory('/uploads')).toBe('/uploads')
    expect(fileDirectory('/agent/reports')).toBe('/agent/reports')
    expect(fileDirectory('/topics')).toBe('/topics')
    expect(fileDirectory('/topics/7')).toBe('/topics/7')
    expect(fileDirectory('/topics/7/agent')).toBe('/topics/7/agent')
    expect(filePath('/uploads/sales.csv')).toBe('/uploads/sales.csv')
    expect(filePath('/topics/7/uploads/2026-10-23/sales.csv')).toBe('/topics/7/uploads/2026-10-23/sales.csv')
  })
  it('refuse anything that could leave them', () => {
    expect(() => filePath('/uploads/../agent/x')).toThrow()
    expect(() => filePath('/agent')).toThrow()
    expect(() => filePath('/topics/7/notes.md')).toThrow()
    expect(() => filePath('/topics/07/agent/x')).toThrow()
    expect(() => fileDirectory('/topics/x')).toThrow()
    expect(() => fileDirectory('/')).toThrow()
    expect(() => fileDirectory('/etc')).toThrow()
  })
})

describe('what a caller reaches of the files (ADR 0115)', () => {
  const sealed = viewOf({ topic: 7, hub: false }, true)
  const keys = viewOf({ topic: 7, hub: false }, false)
  const hub = viewOf({ topic: 1, hub: true }, true)
  const keyInHub = viewOf({ topic: 1, hub: true }, false)

  it("reads a sealed Topic's own folder, and the Shared folder on a person's turn only", () => {
    expect(sealed.reads('/topics/7/uploads/a.csv')).toBe(true)
    expect(sealed.reads('/topics/7')).toBe(true)
    expect(sealed.reads('/topics/8/agent/b.md')).toBe(false)
    expect(sealed.reads('/topics')).toBe(false)
    expect(sealed.reads('/uploads/old.csv')).toBe(true)
    expect(sealed.reads('/agent')).toBe(true)
    expect(keys.reads('/topics/7/agent/out.md')).toBe(true)
    expect(keys.reads('/uploads/old.csv')).toBe(false)
    expect(keys.reads('/agent/received/x.png')).toBe(false)
  })

  it('reads every Topic from a hub, and the Shared folder there on a person’s turn only', () => {
    expect(hub.reads('/topics')).toBe(true)
    expect(hub.reads('/topics/8/agent/b.md')).toBe(true)
    expect(hub.reads('/uploads/old.csv')).toBe(true)
    expect(keyInHub.reads('/topics/8/agent/b.md')).toBe(true)
    expect(keyInHub.reads('/uploads/old.csv')).toBe(false)
  })

  it("writes only the Topic's own agent folder, where a relative path is; the owner anywhere", () => {
    expect(sealed.home).toBe('/topics/7/agent')
    expect(pathIn(sealed, 'reports/week.md')).toBe('/topics/7/agent/reports/week.md')
    expect(pathIn(sealed, '/topics/7/uploads/a.csv')).toBe('/topics/7/uploads/a.csv')
    expect(() => mayWrite(sealed, '/topics/7/agent/report.md')).not.toThrow()
    expect(() => mayWrite(sealed, '/topics/7/uploads/a.csv')).toThrow(Forbidden)
    expect(() => mayWrite(hub, '/topics/7/agent/report.md')).toThrow(Forbidden)
    expect(() => mayWrite(sealed, '/agent/report.md')).toThrow(Forbidden)
    expect(() => mayWrite(OWNER_VIEW, '/uploads/sales.csv')).not.toThrow()
    expect(CLOSED_VIEW.reads('/topics/7/agent/x')).toBe(false)
  })
})
