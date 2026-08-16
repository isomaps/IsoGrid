import type {
  ColumnDef, ColumnFilterConfig, ColumnFilterModel, ColumnType,
  FilterCondition, FilterOperator, FilterType,
} from '../core/types'
import type { MessageKey } from '../core/i18n'
import { getPath } from '../ui/dom'

/* ------------------------------------------------------------------------ */
/* Opérateurs disponibles par type de filtre                                 */
/* ------------------------------------------------------------------------ */

export const OPERATORS: Record<FilterType, FilterOperator[]> = {
  text: ['contains', 'notContains', 'equals', 'notEquals', 'startsWith', 'endsWith', 'blank', 'notBlank'],
  number: ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'between', 'blank', 'notBlank'],
  date: ['equals', 'notEquals', 'before', 'after', 'between', 'blank', 'notBlank'],
  boolean: ['is'],
  set: ['in', 'notIn'],
}

export const DEFAULT_OPERATOR: Record<FilterType, FilterOperator> = {
  text: 'contains',
  number: 'equals',
  date: 'equals',
  boolean: 'is',
  set: 'in',
}

/** Opérateurs qui n'attendent aucune valeur de saisie. */
export const NULLARY_OPERATORS = new Set<FilterOperator>(['blank', 'notBlank'])

/** Opérateurs qui attendent deux valeurs (`value` et `value2`). */
export const BINARY_OPERATORS = new Set<FilterOperator>(['between'])

const OPERATOR_LABELS: Record<FilterOperator, MessageKey> = {
  contains: 'opContains',
  notContains: 'opNotContains',
  equals: 'opEquals',
  notEquals: 'opNotEquals',
  startsWith: 'opStartsWith',
  endsWith: 'opEndsWith',
  blank: 'opBlank',
  notBlank: 'opNotBlank',
  gt: 'opGt',
  gte: 'opGte',
  lt: 'opLt',
  lte: 'opLte',
  between: 'opBetween',
  before: 'opBefore',
  after: 'opAfter',
  in: 'opIn',
  notIn: 'opNotIn',
  is: 'opIs',
}

export const operatorLabelKey = (op: FilterOperator): MessageKey => OPERATOR_LABELS[op]

/* ------------------------------------------------------------------------ */
/* Résolution de la configuration d'un filtre de colonne                     */
/* ------------------------------------------------------------------------ */

/** Type de filtre déduit du type de colonne quand rien n'est précisé. */
function filterTypeFromColumnType(type: ColumnType | undefined): FilterType {
  switch (type) {
    case 'number': return 'number'
    case 'date':
    case 'datetime': return 'date'
    case 'boolean': return 'boolean'
    case 'set': return 'set'
    default: return 'text'
  }
}

export function resolveFilterConfig(col: ColumnDef): ColumnFilterConfig | null {
  if (col.filter === false) return null
  if (col.filter == null || col.filter === true) {
    const type = filterTypeFromColumnType(col.type)
    return { type, operators: OPERATORS[type], defaultOperator: DEFAULT_OPERATOR[type] }
  }
  if (typeof col.filter === 'string') {
    return { type: col.filter, operators: OPERATORS[col.filter], defaultOperator: DEFAULT_OPERATOR[col.filter] }
  }
  const cfg = col.filter
  return {
    ...cfg,
    operators: cfg.operators ?? OPERATORS[cfg.type],
    defaultOperator: cfg.defaultOperator ?? DEFAULT_OPERATOR[cfg.type],
  }
}

/* ------------------------------------------------------------------------ */
/* Normalisation                                                             */
/* ------------------------------------------------------------------------ */

/** Une condition est-elle exploitable ? Sert à ne pas envoyer de bruit au serveur. */
export function isConditionComplete(cond: FilterCondition): boolean {
  if (NULLARY_OPERATORS.has(cond.op)) return true
  if (cond.op === 'in' || cond.op === 'notIn') {
    return Array.isArray(cond.value) && cond.value.length > 0
  }
  if (cond.value == null || cond.value === '') return false
  if (BINARY_OPERATORS.has(cond.op) && (cond.value2 == null || cond.value2 === '')) return false
  return true
}

/**
 * Retire les conditions incomplètes. Retourne `null` s'il ne reste rien —
 * auquel cas le filtre doit être supprimé de l'état, pas stocké vide.
 */
export function normalizeFilter(model: ColumnFilterModel | null | undefined): ColumnFilterModel | null {
  if (!model) return null
  const conditions = model.conditions.filter(isConditionComplete)
  if (conditions.length === 0) return null
  return { type: model.type, conditions, join: conditions.length > 1 ? (model.join ?? 'and') : undefined }
}

/* ------------------------------------------------------------------------ */
/* Évaluation — mode client uniquement                                       */
/* ------------------------------------------------------------------------ */

const norm = (v: unknown): string =>
  String(v ?? '')
    .toLocaleLowerCase()
    // Insensible aux accents : « Genève » se trouve en tapant « geneve ».
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

const toNumber = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'))
  return Number.isNaN(n) ? null : n
}

const toTime = (v: unknown): number | null => {
  if (v == null || v === '') return null
  if (v instanceof Date) return v.getTime()
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

/** Ramène un instant au début de sa journée locale — les filtres date sont au jour. */
const startOfDay = (t: number): number => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const isBlank = (v: unknown): boolean =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0)

function evaluateCondition(value: unknown, cond: FilterCondition, type: FilterType): boolean {
  switch (cond.op) {
    case 'blank': return isBlank(value)
    case 'notBlank': return !isBlank(value)
  }

  if (type === 'set') {
    const list = (cond.value as unknown[]) ?? []
    // Comparaison en chaîne : le serveur et le DOM ramènent tout à du texte.
    const hit = list.some(v => String(v ?? '') === String(value ?? ''))
    return cond.op === 'notIn' ? !hit : hit
  }

  if (type === 'boolean') {
    const expected = cond.value === true || cond.value === 'true'
    return Boolean(value) === expected
  }

  if (type === 'number') {
    const a = toNumber(value)
    const b = toNumber(cond.value)
    if (a == null || b == null) return false
    switch (cond.op) {
      case 'equals': return a === b
      case 'notEquals': return a !== b
      case 'gt': return a > b
      case 'gte': return a >= b
      case 'lt': return a < b
      case 'lte': return a <= b
      case 'between': {
        const c = toNumber(cond.value2)
        if (c == null) return false
        const [lo, hi] = b <= c ? [b, c] : [c, b]
        return a >= lo && a <= hi
      }
      default: return true
    }
  }

  if (type === 'date') {
    const a = toTime(value)
    const b = toTime(cond.value)
    if (a == null || b == null) return false
    const da = startOfDay(a)
    const db = startOfDay(b)
    switch (cond.op) {
      case 'equals': return da === db
      case 'notEquals': return da !== db
      case 'before': return da < db
      case 'after': return da > db
      case 'between': {
        const c = toTime(cond.value2)
        if (c == null) return false
        const dc = startOfDay(c)
        const [lo, hi] = db <= dc ? [db, dc] : [dc, db]
        return da >= lo && da <= hi
      }
      default: return true
    }
  }

  // text
  const a = norm(value)
  const b = norm(cond.value)
  switch (cond.op) {
    case 'contains': return a.includes(b)
    case 'notContains': return !a.includes(b)
    case 'equals': return a === b
    case 'notEquals': return a !== b
    case 'startsWith': return a.startsWith(b)
    case 'endsWith': return a.endsWith(b)
    default: return true
  }
}

export function evaluateFilter(value: unknown, model: ColumnFilterModel): boolean {
  const results = model.conditions.map(c => evaluateCondition(value, c, model.type))
  if (results.length === 0) return true
  return model.join === 'or' ? results.some(Boolean) : results.every(Boolean)
}

/** Filtrage complet d'un jeu de lignes — mode client. */
export function applyFilters<TRow>(
  rows: TRow[],
  filters: Record<string, ColumnFilterModel>,
  columns: ColumnDef<TRow>[],
  quickFilter: string,
): TRow[] {
  const entries = Object.entries(filters)
  const q = norm(quickFilter).trim()
  if (entries.length === 0 && !q) return rows

  const byId = new Map(columns.map(c => [c.id, c]))
  const quickCols = columns.filter(c => c.hide !== true)

  return rows.filter((row) => {
    for (const [colId, model] of entries) {
      const col = byId.get(colId)
      const value = getPath(row, col?.field ?? colId)
      if (!evaluateFilter(value, model)) return false
    }
    if (q) {
      const hit = quickCols.some(c => norm(getPath(row, c.field ?? c.id)).includes(q))
      if (!hit) return false
    }
    return true
  })
}

/** Tri d'un jeu de lignes — mode client. */
export function applySort<TRow>(
  rows: TRow[],
  sort: Array<{ id: string; desc: boolean }>,
  columns: ColumnDef<TRow>[],
): TRow[] {
  if (sort.length === 0) return rows
  const byId = new Map(columns.map(c => [c.id, c]))
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

  // `slice()` : ne jamais réordonner le tableau de l'appelant.
  return rows.slice().sort((ra, rb) => {
    for (const s of sort) {
      const col = byId.get(s.id)
      const field = col?.field ?? s.id
      const va = getPath(ra, field)
      const vb = getPath(rb, field)

      // Les valeurs manquantes finissent toujours en bas, quel que soit le sens.
      if (isBlank(va) && isBlank(vb)) continue
      if (isBlank(va)) return 1
      if (isBlank(vb)) return -1

      let cmp: number
      if (col?.type === 'number') {
        cmp = (toNumber(va) ?? 0) - (toNumber(vb) ?? 0)
      } else if (col?.type === 'date' || col?.type === 'datetime') {
        cmp = (toTime(va) ?? 0) - (toTime(vb) ?? 0)
      } else if (col?.type === 'boolean') {
        cmp = Number(Boolean(va)) - Number(Boolean(vb))
      } else {
        cmp = collator.compare(String(va), String(vb))
      }
      if (cmp !== 0) return s.desc ? -cmp : cmp
    }
    return 0
  })
}
