/**
 * Codegen: converts TypeSpec-emitted JSON Schemas (contract/dist/json-schema/*.json)
 * into TypeScript types (src/generated/types.ts) and Zod schemas (src/generated/schemas.ts).
 *
 * Source of truth: contract/dist/json-schema/ (emitted by @typespec/json-schema with
 * emitAllModels: true). The OpenAPI3 emitter produces an empty document (the contract
 * is model-only, no HTTP operations), so we parse the per-model JSON Schema files instead.
 *
 * Run: `npm run contract:codegen`  (invokes `tsp compile ./contract` then this script).
 *
 * @generated THIS FILE IS NOT GENERATED — it is the generator. The files it writes
 *            (src/generated/*.ts) carry their own @generated header.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const SCHEMA_DIR = path.join(REPO_ROOT, 'contract', 'dist', 'json-schema')
const OUT_DIR = path.join(REPO_ROOT, 'src', 'generated')

/** Minimal JSON Schema draft 2020-12 AST covering what TypeSpec emits. */
interface JsonSchema {
  $id?: string
  $ref?: string
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null'
  enum?: (string | number)[]
  const?: string | number | boolean
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  anyOf?: JsonSchema[]
  allOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  unevaluatedProperties?: JsonSchema | boolean
  additionalProperties?: JsonSchema | boolean
  format?: string
  minimum?: number
  maximum?: number
}

function assertIsJsonSchema(value: unknown): JsonSchema {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Expected a JSON Schema object, got ${typeof value}`)
  }
  return value
}

/** Safe lookup that throws on a missing key (replaces non-null assertions). */
function requireKey<T>(record: Record<string, T>, key: string): T {
  const value = record[key]
  if (value === undefined) {
    throw new Error(`codegen: missing required key "${key}"`)
  }
  return value
}

/** Safe first element that throws on an empty array (replaces non-null assertions). */
function requireFirst<T>(arr: readonly T[]): T {
  const first = arr[0]
  if (first === undefined) {
    throw new Error('codegen: expected a non-empty array')
  }
  return first
}

/** "Foo.json" -> "Foo"; pass-through for already-clean names. */
function refToName(ref: string): string {
  const base = ref.split('/').pop() ?? ref
  return base.replace(/\.json$/, '').replace(/\.yaml$/, '')
}

/** Foo -> foo (lower-first), without mutating or indexing. */
function lowerFirst(name: string): string {
  const first = name.charAt(0)
  return first === '' ? '' : `${first.toLowerCase()}${name.slice(1)}`
}

/** PascalCase type name -> camelCase schema const name: RunInput -> runInputSchema. */
function schemaConstName(typeName: string): string {
  return `${lowerFirst(typeName)}Schema`
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
/** Quote a property key for TS/JS object literal if it is not a valid identifier. */
function propKey(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name)
}

/** Walk a schema node and collect every `$ref` target name it transitively mentions. */
function collectRefs(node: JsonSchema, out: Set<string>): void {
  if (node.$ref !== undefined) {
    out.add(refToName(node.$ref))
    return
  }
  if (node.type === 'array' && node.items !== undefined) {
    collectRefs(node.items, out)
    return
  }
  if (node.properties !== undefined) {
    for (const child of Object.values(node.properties)) collectRefs(child, out)
  }
  const mapSchema = node.unevaluatedProperties ?? node.additionalProperties
  if (typeof mapSchema === 'object') collectRefs(mapSchema, out)
  for (const child of node.anyOf ?? []) collectRefs(child, out)
  for (const child of node.allOf ?? []) collectRefs(child, out)
  for (const child of node.oneOf ?? []) collectRefs(child, out)
}

/** Direct dependencies of a named schema: the set of other named schemas it references. */
function depsOf(node: JsonSchema): Set<string> {
  const refs = new Set<string>()
  collectRefs(node, refs)
  return refs
}

/**
 * Topologically sort schemas so that dependencies precede dependents.
 * Throws on cycles (the current contract is a DAG; if a future contract introduces
 * recursion, wrap the back-edge ref in z.lazy(() => xSchema) and re-run).
 */
function topoSort(schemas: Map<string, JsonSchema>): string[] {
  const ordered: string[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (name: string): void => {
    if (visited.has(name)) return
    if (visiting.has(name)) {
      throw new Error(`Cycle detected at schema "${name}" — wrap the recursive $ref in z.lazy()`)
    }
    visiting.add(name)
    const node = schemas.get(name)
    if (node !== undefined) {
      for (const dep of depsOf(node)) {
        if (schemas.has(dep)) visit(dep)
      }
    }
    visiting.delete(name)
    visited.add(name)
    ordered.push(name)
  }
  for (const name of schemas.keys()) visit(name)
  return ordered
}

/** Generate a TS type expression string for a (sub)schema. */
function genType(node: JsonSchema): string {
  if (node.$ref !== undefined) return refToName(node.$ref)
  if (node.enum !== undefined) {
    return node.enum.map((v) => JSON.stringify(v)).join(' | ')
  }
  if (node.const !== undefined) return JSON.stringify(node.const)
  switch (node.type) {
    case 'string':
      return 'string'
    case 'integer':
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'array':
      return node.items !== undefined ? `Array<${genType(node.items)}>` : 'unknown[]'
    case 'object':
      return genObjectType(node)
    default:
      break
  }
  if (node.anyOf !== undefined) return node.anyOf.map(genType).join(' | ')
  if (node.oneOf !== undefined) return node.oneOf.map(genType).join(' | ')
  if (node.allOf !== undefined) return node.allOf.map(genType).join(' & ')
  return 'unknown'
}

function genObjectType(node: JsonSchema): string {
  const props = node.properties ?? {}
  const required = new Set(node.required ?? [])
  const propNames = Object.keys(props)
  const mapSchema = node.unevaluatedProperties ?? node.additionalProperties

  // Record-like type: empty declared properties, value schema via additional/unevaluated.
  if (propNames.length === 0 && typeof mapSchema === 'object') {
    return `Record<string, ${genType(mapSchema)}>`
  }
  if (propNames.length === 0) {
    return 'Record<string, unknown>'
  }

  const lines = propNames.map((name) => {
    const child = requireKey(props, name)
    const opt = required.has(name) ? '' : '?'
    return `  ${propKey(name)}${opt}: ${genType(child)};`
  })

  // Allow an index signature alongside known keys (not used by current contract).
  if (typeof mapSchema === 'object') {
    lines.push(`  [k: string]: ${genType(mapSchema)};`)
  }

  return `{\n${lines.join('\n')}\n}`
}

const ZOD_SCALAR: Record<string, string> = {
  string: 'z.string()',
  number: 'z.number()',
  boolean: 'z.boolean()',
}

/** Generate a Zod schema expression string for a (sub)schema. */
function genZod(node: JsonSchema): string {
  if (node.$ref !== undefined) return schemaConstName(refToName(node.$ref))
  if (node.enum !== undefined) {
    if (node.enum.length === 1) {
      return `z.literal(${JSON.stringify(requireFirst(node.enum))})`
    }
    return `z.enum([${node.enum.map((v) => JSON.stringify(v)).join(', ')}])`
  }
  if (node.const !== undefined) return `z.literal(${JSON.stringify(node.const)})`

  if (node.type !== undefined) {
    if (node.type === 'integer') return 'z.number().int()'
    if (node.type === 'array') {
      return node.items !== undefined ? `z.array(${genZod(node.items)})` : 'z.array(z.unknown())'
    }
    if (node.type === 'object') return genZodObject(node)
    const scalar = ZOD_SCALAR[node.type]
    if (scalar !== undefined) return scalar
  }

  if (node.anyOf !== undefined || node.oneOf !== undefined) {
    const members = node.anyOf ?? node.oneOf ?? []
    if (members.length === 1) return genZod(requireFirst(members))
    return `z.union([${members.map((m) => genZod(m)).join(', ')}])`
  }
  if (node.allOf !== undefined && node.allOf.length > 0) {
    if (node.allOf.length === 1) return genZod(requireFirst(node.allOf))
    const parts = node.allOf.map((m) => genZod(m))
    const inner = parts.slice(0, -1).join('.and(')
    const tail = requireFirst(parts.slice(-1))
    return `${tail}${inner ? `.and(${inner})` : ''}${')'.repeat(parts.length - 1)}`
  }
  return 'z.unknown()'
}

function genZodObject(node: JsonSchema): string {
  const props = node.properties ?? {}
  const required = new Set(node.required ?? [])
  const propNames = Object.keys(props)
  const mapSchema = node.unevaluatedProperties ?? node.additionalProperties

  if (propNames.length === 0 && typeof mapSchema === 'object') {
    return `z.record(z.string(), ${genZod(mapSchema)})`
  }
  if (propNames.length === 0) {
    return 'z.record(z.string(), z.unknown())'
  }

  const lines = propNames.map((name) => {
    const child = requireKey(props, name)
    const opt = required.has(name) ? '' : '.optional()'
    return `    ${propKey(name)}: ${genZod(child)}${opt},`
  })
  return `z.object({\n${lines.join('\n')}\n  })`
}

const HEADER = `/**
 * @generated — DO NOT EDIT BY HAND.
 * Generated by scripts/codegen.ts from contract/dist/json-schema/*.json (TypeSpec).
 * Re-run \`npm run contract:codegen\` after changing contract/*.tsp.
 */
`

async function loadSchemas(): Promise<Map<string, JsonSchema>> {
  const files = await readdir(SCHEMA_DIR)
  const schemas = new Map<string, JsonSchema>()
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const raw = await readFile(path.join(SCHEMA_DIR, file), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const schema = assertIsJsonSchema(parsed)
    const name =
      schema.$id !== undefined ? schema.$id.replace(/\.json$/, '') : file.replace(/\.json$/, '')
    schemas.set(name, schema)
  }
  return schemas
}

async function emitTypes(ordered: string[], schemas: Map<string, JsonSchema>): Promise<void> {
  const blocks = ordered.map((name) => {
    const node = schemas.get(name)
    if (node === undefined) {
      throw new Error(`codegen: missing schema "${name}"`)
    }
    return `export type ${name} = ${genType(node)}`
  })
  const body = `${HEADER}\n${blocks.join('\n\n')}\n`
  await writeFile(path.join(OUT_DIR, 'types.ts'), body, 'utf8')
}

async function emitSchemas(ordered: string[], schemas: Map<string, JsonSchema>): Promise<void> {
  const blocks = ordered.map((name) => {
    const node = schemas.get(name)
    if (node === undefined) {
      throw new Error(`codegen: missing schema "${name}"`)
    }
    return `export const ${schemaConstName(name)} = ${genZod(node)}`
  })
  const body = `${HEADER}\nimport { z } from 'zod'\n\n${blocks.join('\n\n')}\n`
  await writeFile(path.join(OUT_DIR, 'schemas.ts'), body, 'utf8')
}

async function emitIndex(): Promise<void> {
  const body = `${HEADER}\nexport type * from './types.js'\nexport * from './schemas.js'\n`
  await writeFile(path.join(OUT_DIR, 'index.ts'), body, 'utf8')
}

async function main(): Promise<void> {
  const schemas = await loadSchemas()
  if (schemas.size === 0) {
    throw new Error(
      `No JSON schemas found in ${SCHEMA_DIR}. Run \`npm run contract:compile\` first.`,
    )
  }
  const ordered = topoSort(schemas)
  await mkdir(OUT_DIR, { recursive: true })
  await emitTypes(ordered, schemas)
  await emitSchemas(ordered, schemas)
  await emitIndex()
  console.log(
    `codegen: wrote ${String(schemas.size)} models to ${path.relative(REPO_ROOT, OUT_DIR)}/`,
  )
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
