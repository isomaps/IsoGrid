import type { AnyRow, ColumnDef } from './types'
import { getPath } from '../ui/dom'

/**
 * Groupage de lignes et agrégats — mode client uniquement.
 *
 * Le groupage transforme une liste plate en arbre, puis la ré-aplatit selon
 * les groupes ouverts. C'est cette seconde liste que la virtualisation
 * consomme : l'index d'affichage ne désigne plus une ligne de données mais
 * une « ligne visible », qui peut être un en-tête de groupe.
 *
 * Le mode serveur n'est PAS couvert : il exige un protocole où le serveur
 * renvoie les groupes d'un niveau (SELECT … GROUP BY) puis les enfants d'un
 * groupe déplié, avec un cache par branche. C'est un chantier à part entière,
 * et aucune grille à migrer n'en a besoin — toutes celles qui groupent
 * chargent leurs lignes en mémoire.
 */

/**
 * Identifiant de la colonne d'arborescence.
 *
 * Comme la colonne de sélection, c'est une VRAIE colonne du modèle : les
 * décalages sticky et le redimensionnement fonctionnent alors sans traitement
 * particulier.
 */
export const GROUP_COLUMN_ID = '__isg_group__'

/**
 * Séparateur des chemins de groupe.
 *
 * Un caractère de contrôle, et non un espace ou un slash : le chemin est
 * construit à partir de VALEURS de données, qui contiennent couramment l'un
 * et l'autre. « Alpes Conseil » + « Sion » et « Alpes » + « Conseil Sion »
 * produiraient sinon le même chemin, donc le même état d'ouverture.
 */
const PATH_SEPARATOR = '\u0000'

/* ------------------------------------------------------------------------ */
/* Agrégats                                                                  */
/* ------------------------------------------------------------------------ */

export type BuiltInAggFunc = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'first' | 'last'

/** Agrégateur sur mesure : reçoit les valeurs brutes des feuilles du groupe. */
export type AggFunc = BuiltInAggFunc | ((values: unknown[]) => unknown)

const toNumber = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'))
  return Number.isNaN(n) ? null : n
}

function aggregate(values: unknown[], fn: AggFunc): unknown {
  if (typeof fn === 'function') return fn(values)

  if (fn === 'count') return values.length
  if (fn === 'first') return values[0]
  if (fn === 'last') return values[values.length - 1]

  // Les valeurs non numériques sont ignorées plutôt que comptées comme 0 :
  // une cellule vide ne doit pas tirer une moyenne vers le bas.
  const numbers = values.map(toNumber).filter((n): n is number => n != null)
  if (numbers.length === 0) return null

  switch (fn) {
    case 'sum': return numbers.reduce((a, b) => a + b, 0)
    case 'avg': return numbers.reduce((a, b) => a + b, 0) / numbers.length
    case 'min': return Math.min(...numbers)
    case 'max': return Math.max(...numbers)
    default: return null
  }
}

/* ------------------------------------------------------------------------ */
/* Arbre                                                                     */
/* ------------------------------------------------------------------------ */

export interface GroupNode<TRow = AnyRow> {
  /** Chemin complet, unique — sert de clé d'état d'ouverture. */
  path: string
  /** Valeur brute du groupe. */
  key: unknown
  /** Colonne sur laquelle ce niveau groupe. */
  columnId: string
  /** 0 pour le premier niveau de groupage. */
  level: number
  /** Nombre de feuilles sous ce nœud, tous sous-niveaux confondus. */
  count: number
  /** Agrégats calculés, par identifiant de colonne. */
  aggregates: Record<string, unknown>
  children: GroupNode<TRow>[]
  /** Feuilles directes — non vide seulement au dernier niveau de groupage. */
  leaves: TRow[]
}

export type DisplayRow<TRow = AnyRow> =
  | { kind: 'group'; node: GroupNode<TRow>; expanded: boolean }
  | { kind: 'leaf'; row: TRow; level: number }

/* ------------------------------------------------------------------------ */
/* Modèle                                                                    */
/* ------------------------------------------------------------------------ */

export interface GroupingOptions {
  /**
   * Niveaux ouverts au premier rendu. `0` = tout replié, `-1` = tout
   * déplié, `n` = les n premiers niveaux.
   */
  defaultExpanded?: number
}

export class GroupingModel<TRow extends AnyRow = AnyRow> {
  /** Colonnes de groupage, dans l'ordre des niveaux. */
  private groupBy: string[] = []
  /** Chemins des groupes DÉPLIÉS. */
  private expanded = new Set<string>()
  private roots: GroupNode<TRow>[] = []
  private flat: DisplayRow<TRow>[] = []
  private built = false

  constructor(private options: GroupingOptions = {}) {}

  isActive(): boolean {
    return this.groupBy.length > 0
  }

  getGroupBy(): string[] {
    return this.groupBy.slice()
  }

  setGroupBy(columnIds: string[]): void {
    this.groupBy = columnIds.slice()
    // Les chemins d'ouverture d'un groupage précédent n'ont plus de sens.
    this.expanded.clear()
    this.built = false
  }

  getExpanded(): string[] {
    return Array.from(this.expanded)
  }

  setExpanded(paths: string[]): void {
    this.expanded = new Set(paths)
    if (this.built) this.flatten()
  }

  isExpanded(path: string): boolean {
    return this.expanded.has(path)
  }

  toggle(path: string): void {
    if (this.expanded.has(path)) this.expanded.delete(path)
    else this.expanded.add(path)
    this.flatten()
  }

  expandAll(): void {
    const walk = (nodes: GroupNode<TRow>[]) => {
      for (const n of nodes) { this.expanded.add(n.path); walk(n.children) }
    }
    walk(this.roots)
    this.flatten()
  }

  collapseAll(): void {
    this.expanded.clear()
    this.flatten()
  }

  /* -------------------------------------------------------------------- */
  /* Construction                                                          */
  /* -------------------------------------------------------------------- */

  /**
   * (Re)construit l'arbre à partir des lignes déjà filtrées et triées.
   *
   * `columns` sert à lire les champs et à connaître les `aggFunc`.
   */
  build(rows: TRow[], columns: ColumnDef<TRow>[]): void {
    if (!this.isActive()) {
      this.roots = []
      this.flat = rows.map(row => ({ kind: 'leaf' as const, row, level: 0 }))
      this.built = true
      return
    }

    const byId = new Map(columns.map(c => [c.id, c]))
    const aggColumns = columns.filter(c => c.aggFunc != null)

    const buildLevel = (subset: TRow[], level: number, parentPath: string): GroupNode<TRow>[] => {
      const columnId = this.groupBy[level]
      const col = byId.get(columnId)
      const field = col?.field ?? columnId

      // `Map` conserve l'ordre d'insertion : les groupes suivent donc l'ordre
      // de tri des lignes, sans tri supplémentaire.
      const buckets = new Map<string, { key: unknown; rows: TRow[] }>()
      for (const row of subset) {
        const value = getPath(row, field)
        const k = String(value ?? '')
        const bucket = buckets.get(k)
        if (bucket) bucket.rows.push(row)
        else buckets.set(k, { key: value ?? null, rows: [row] })
      }

      const isLast = level === this.groupBy.length - 1

      return Array.from(buckets.entries()).map(([k, bucket]) => {
        const path = parentPath ? `${parentPath}${PATH_SEPARATOR}${k}` : k
        const children = isLast ? [] : buildLevel(bucket.rows, level + 1, path)

        const aggregates: Record<string, unknown> = {}
        for (const agg of aggColumns) {
          const aggField = agg.field ?? agg.id
          aggregates[agg.id] = aggregate(
            bucket.rows.map(r => getPath(r, aggField)),
            agg.aggFunc!,
          )
        }

        return {
          path,
          key: bucket.key,
          columnId,
          level,
          count: bucket.rows.length,
          aggregates,
          children,
          leaves: isLast ? bucket.rows : [],
        }
      })
    }

    this.roots = buildLevel(rows, 0, '')

    // Ouverture par défaut, seulement au premier montage : sinon un simple
    // rafraîchissement de données rouvrirait ce que l'utilisateur a replié.
    if (!this.built) {
      const depth = this.options.defaultExpanded ?? 0
      if (depth !== 0) {
        const walk = (nodes: GroupNode<TRow>[]) => {
          for (const n of nodes) {
            if (depth === -1 || n.level < depth) {
              this.expanded.add(n.path)
              walk(n.children)
            }
          }
        }
        walk(this.roots)
      }
    }

    this.built = true
    this.flatten()
  }

  /** Ré-aplatit l'arbre selon l'état d'ouverture courant. */
  private flatten(): void {
    if (!this.isActive()) return
    const out: DisplayRow<TRow>[] = []

    const walk = (nodes: GroupNode<TRow>[]) => {
      for (const node of nodes) {
        const expanded = this.expanded.has(node.path)
        out.push({ kind: 'group', node, expanded })
        if (!expanded) continue
        if (node.children.length > 0) walk(node.children)
        else for (const row of node.leaves) {
          out.push({ kind: 'leaf', row, level: node.level + 1 })
        }
      }
    }

    walk(this.roots)
    this.flat = out
  }

  /* -------------------------------------------------------------------- */
  /* Lecture pour le rendu                                                 */
  /* -------------------------------------------------------------------- */

  getDisplayRowCount(): number {
    return this.flat.length
  }

  getDisplayRow(index: number): DisplayRow<TRow> | undefined {
    return this.flat[index]
  }

  /** Feuilles visibles, dans l'ordre d'affichage — pour l'export et la copie. */
  getVisibleLeaves(): TRow[] {
    return this.flat
      .filter((d): d is { kind: 'leaf'; row: TRow; level: number } => d.kind === 'leaf')
      .map(d => d.row)
  }

  /** Totaux tous groupes confondus, pour une éventuelle ligne de synthèse. */
  getGrandTotals(rows: TRow[], columns: ColumnDef<TRow>[]): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const col of columns) {
      if (col.aggFunc == null) continue
      const field = col.field ?? col.id
      out[col.id] = aggregate(rows.map(r => getPath(r, field)), col.aggFunc)
    }
    return out
  }
}
