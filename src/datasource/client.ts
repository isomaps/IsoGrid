import type {
  AnyRow, ColumnDef, DataRequest, DataResponse, Datasource, SetFilterOption,
} from '../core/types'
import { applyFilters, applySort } from '../filters/model'
import { getPath } from '../ui/dom'

/**
 * Source de données en mémoire.
 *
 * Elle implémente le même contrat `Datasource` que le mode serveur : la
 * grille n'a donc qu'un seul chemin de données, et passer de `client` à
 * `server` ne change rien à son code. Le résultat filtré/trié est mémoïsé
 * pour ne pas re-parcourir le jeu à chaque bloc demandé.
 */
export class ClientDatasource<TRow = AnyRow> implements Datasource<TRow> {
  private rows: TRow[]
  private columns: ColumnDef<TRow>[]
  private cacheKey = ''
  private cached: TRow[] = []

  constructor(rows: TRow[], columns: ColumnDef<TRow>[]) {
    this.rows = rows
    this.columns = columns
  }

  setRows(rows: TRow[]): void {
    this.rows = rows
    this.cacheKey = ''
  }

  setColumns(columns: ColumnDef<TRow>[]): void {
    this.columns = columns
    this.cacheKey = ''
  }

  getAllRows(): TRow[] {
    return this.rows
  }

  private resolve(request: Pick<DataRequest, 'sort' | 'filters' | 'quickFilter'>): TRow[] {
    const key = JSON.stringify([request.filters, request.sort, request.quickFilter])
    if (key === this.cacheKey) return this.cached
    const filtered = applyFilters(this.rows, request.filters, this.columns, request.quickFilter)
    this.cached = applySort(filtered, request.sort, this.columns)
    this.cacheKey = key
    return this.cached
  }

  /**
   * Jeu complet filtré et trié.
   *
   * Le groupage en a besoin d'un seul tenant : construire un arbre à partir
   * des seuls blocs chargés produirait des groupes faux. C'est légitime ici —
   * en mode client, tout est déjà en mémoire.
   */
  getResolvedRows(request: Pick<DataRequest, 'sort' | 'filters' | 'quickFilter'>): TRow[] {
    return this.resolve(request)
  }

  async getRows(request: DataRequest): Promise<DataResponse<TRow>> {
    const resolved = this.resolve(request)
    return {
      rows: resolved.slice(request.startRow, request.endRow),
      rowCount: resolved.length,
    }
  }

  async getSetValues(
    columnId: string,
    request: Omit<DataRequest, 'startRow' | 'endRow'>,
  ): Promise<SetFilterOption[]> {
    const column = this.columns.find(c => c.id === columnId)
    const field = column?.field ?? columnId

    // Les valeurs proposées tiennent compte des AUTRES filtres actifs, pas du
    // sien : sinon cocher une valeur ferait disparaître toutes les autres.
    const others = { ...request.filters }
    delete others[columnId]
    const base = applyFilters(this.rows, others, this.columns, request.quickFilter)

    const counts = new Map<string, { value: unknown; count: number }>()
    for (const row of base) {
      const value = getPath(row, field)
      const key = String(value ?? '')
      const entry = counts.get(key)
      if (entry) entry.count++
      else counts.set(key, { value: value ?? null, count: 1 })
    }

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    return Array.from(counts.values())
      .sort((a, b) => collator.compare(String(a.value ?? ''), String(b.value ?? '')))
      .map(e => ({ value: e.value as SetFilterOption['value'], count: e.count }))
  }
}
