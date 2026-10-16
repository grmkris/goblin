import { type ASTNode, parseExpression, split, tokenize } from '@openuidev/lang-core'
import { z } from 'zod/v4'
import { componentSchemas } from './library.tsx'

/**
 * The program the Renderer draws: each statement checked here, printed back one per line with JSON strings. Replies use
 * data and components, never executable verbs, and reference expansion is bounded before OpenUI materializes it.
 * OpenUI strips comments and Markdown fences before it parses a reply and this tokenizer does not, so raw source could
 * check as one program and render as another (`pad = #'` hides a second `root` in a string); the printed program reads
 * the same to both. Undefined when the root is not a Stack; a reply too complex or unsupported throws.
 */
export function canonicalProgram(source: string): string | undefined {
  const statements = split(tokenize(source))
  if (statements.length > 64 || new Set(statements.map(({ id }) => id)).size !== statements.length) return undefined
  const definitions = new Map(statements.map(({ id, tokens }) => [id, parseExpression(tokens)]))
  let remaining = 2000
  const path = new Set<string>()
  const visit = (node: ASTNode, depth: number): unknown => {
    if (--remaining < 0 || depth > 32) throw new Error('Reply is too complex')
    switch (node.k) {
      case 'Num':
        if (!Number.isFinite(node.v)) throw new Error('Unsupported number')
        return node.v
      case 'Str':
      case 'Bool':
        return node.v
      case 'Null':
        return null
      case 'Ref':
      case 'StateRef': {
        const target = definitions.get(node.n)
        if (target === undefined || path.has(node.n)) throw new Error('Unresolved reference')
        if (node.k === 'StateRef' && !scalar(target)) throw new Error('State must be a scalar')
        path.add(node.n)
        const value = visit(target, depth + 1)
        path.delete(node.n)
        return value
      }
      case 'Arr':
        return node.els.map((child) => visit(child, depth + 1))
      case 'Obj':
        return Object.fromEntries(node.entries.map(([key, value]) => [key, visit(value, depth + 1)]))
      case 'Comp':
        if (node.fn) throw new Error('Unsupported function')
        return componentValue(
          node.name,
          node.args.map((arg) => visit(arg, depth + 1)),
        )
      case 'UnaryOp':
        if (node.op !== '-' || node.operand.k !== 'Num') throw new Error('Unsupported expression')
        return -node.operand.v
      case 'Assign':
      case 'BinOp':
      case 'Index':
      case 'Member':
      case 'Ph':
      case 'RuntimeRef':
      case 'Ternary':
        throw new Error('Unsupported expression')
    }
  }
  const root = definitions.get('root')
  if (root?.k !== 'Comp' || root.name !== 'Stack') return undefined
  // Orphaned statements also get checked: a hidden Query must never reach Renderer.
  for (const node of definitions.values()) visit(node, 0)
  return [...definitions].map(([id, node]) => `${id} = ${print(node)}`).join('\n')
}

/** A checked expression as text OpenUI reads back unchanged: strings and keys as JSON, references by name. */
function print(node: ASTNode): string {
  switch (node.k) {
    case 'Str':
      return JSON.stringify(node.v)
    case 'Num':
    case 'Bool':
      return String(node.v)
    case 'Null':
      return 'null'
    case 'Ref':
    case 'StateRef':
      return node.n
    case 'Arr':
      return `[${node.els.map(print).join(', ')}]`
    case 'Obj':
      return `{${node.entries.map(([key, value]) => `${JSON.stringify(key)}: ${print(value)}`).join(', ')}}`
    case 'Comp':
      return `${node.name}(${node.args.map(print).join(', ')})`
    case 'UnaryOp':
      if (node.op !== '-' || node.operand.k !== 'Num') throw new Error('Unsupported expression')
      return String(-node.operand.v)
    case 'Assign':
    case 'BinOp':
    case 'Index':
    case 'Member':
    case 'Ph':
    case 'RuntimeRef':
    case 'Ternary':
      throw new Error('Unsupported expression')
  }
}

/** State defaults remain data, including a negative numeric literal. */
function scalar(node: ASTNode): boolean {
  return (
    ['Str', 'Num', 'Bool', 'Null'].includes(node.k) ||
    (node.k === 'UnaryOp' && node.op === '-' && node.operand.k === 'Num')
  )
}

/** Validate positional arguments with the same Zod schemas used to declare the component library. */
function componentValue(name: string, args: readonly unknown[]): unknown {
  const schema = componentSchemas.get(name)
  if (schema === undefined) throw new Error('Unsupported component')
  const names = Object.keys(schema.shape)
  if (args.length > names.length) throw new Error('Unexpected argument')
  const props = Object.fromEntries<unknown>(names.map((key, index) => [key, args[index]]))
  if (!z.safeParse(schema, props).success) throw new Error('Invalid component props')
  return { type: 'element', typeName: name, props, partial: false }
}
