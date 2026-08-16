import {
  columnFilteringFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  constructTable,
  rowSortingFeature,
  tableFeatures,
} from '@tanstack/table-core'
import { renderPhaseReactivity } from '@tanstack/table-core/reactivity'
import { batch, createAtom } from '@tanstack/store'

import type { AnyRow, ColumnDef, GridState, PinPosition, SortModel } from './types'
import { SELECTION_COLUMN_ID } from './selection'
import { GROUP_COLUMN_ID } from './grouping'
import { DETAIL_COLUMN_ID, ROW_ACTIONS_COLUMN_ID } from './detail'

/**
 * Câblage de @tanstack/table-core.
 *
 * table-core n'est utilisé QUE comme modèle de colonnes : visibilité, ordre,
 * épinglage, largeurs, redimensionnement, groupes d'en-tête, décalages O(1)
 * pour le `position: sticky`, et bascule du tri multi-colonnes. Les lignes ne
 * passent jamais par lui — elles viennent de la `Datasource`, en mémoire ou
 * du serveur. C'est pour ça que `manualSorting`/`manualFiltering` sont à
 * `true` et que `data` reste vide.
 */

/**
 * Bindings de réactivité. table-core v9 les délègue à l'adaptateur du
 * framework hôte ; en vanilla c'est à nous de les fournir, à partir du store
 * TanStack. `renderPhaseReactivity` est la variante prévue pour les hôtes
 * dont les options sont des valeurs simples — notre cas.
 */
const reactivity = renderPhaseReactivity({ createAtom, batch })

/**
 * Fonction de filtre factice.
 *
 * `manualFiltering: true` fait que table-core n'évalue JAMAIS de filtre : c'est
 * la source de données qui filtre, en mémoire ou en base. Mais dès qu'une
 * colonne porte une valeur de filtre, table-core cherche quand même à résoudre
 * une fonction et avertit en console qu'elle n'est pas enregistrée — un
 * message d'internals déversé dans la console de l'application hôte. On lui en
 * fournit donc une, qui ne sera jamais appelée.
 */
const filterFn_delegated = () => true

const features = tableFeatures({
  coreReactivityFeature: reactivity,
  filterFns: { delegated: filterFn_delegated },
  columnVisibilityFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnSizingFeature,
  columnResizingFeature,
  rowSortingFeature,
  columnFilteringFeature,
})

type TableInstance = ReturnType<typeof constructTable<typeof features, AnyRow>>
type CoreColumn = ReturnType<TableInstance['getAllLeafColumns']>[number]
type CoreHeader = ReturnType<TableInstance['getHeaderGroups']>[number]['headers'][number]

export interface ColumnModelOptions {
  columns: ColumnDef[]
  /** Ajoute la colonne de cases à cocher en tête, épinglée et verrouillée. */
  selectionColumn?: { width: number } | false
  /** Ajoute la colonne d'arborescence des groupes. */
  groupColumn?: { width: number } | false
  /** Ajoute la colonne de chevron des lignes de détail. */
  detailColumn?: { width: number } | false
  /** Ajoute la colonne d'actions de ligne, épinglée à droite. */
  actionsColumn?: { width: number } | false
  /** Colonnes servant au groupage : masquées puisque leur valeur est portée par le groupe. */
  groupedColumnIds?: string[]
  defaultColumn?: Partial<ColumnDef>
  defaultColumnWidth: number
  initialState?: Partial<GridState>
  onChange: () => void
}

/** Une colonne telle que le rendu la consomme. */
export interface RenderColumn {
  id: string
  def: ColumnDef
  core: CoreColumn
  width: number
  pinned: PinPosition
  /** Décalage cumulé depuis le bord, pour `left`/`right` en sticky. */
  stickyOffset: number
  /** Vrai pour la dernière colonne épinglée `start` (porte l'ombre de séparation). */
  isLastPinnedStart: boolean
  /** Vrai pour la première colonne épinglée `end`. */
  isFirstPinnedEnd: boolean
}

export interface RenderHeader {
  id: string
  colSpan: number
  /** Absent pour les cellules de groupe. */
  column?: RenderColumn
  /** Libellé de groupe pour les cellules de groupe. */
  groupLabel?: string
  core: CoreHeader
  isPlaceholder: boolean
  pinned: PinPosition
  stickyOffset: number
  width: number
}

export class ColumnModel {
  private table: TableInstance
  private defs = new Map<string, ColumnDef>()
  private orderedDefs: ColumnDef[]
  private quickFilterValue: string
  private opts: ColumnModelOptions

  constructor(opts: ColumnModelOptions) {
    this.opts = opts
    this.orderedDefs = opts.columns.slice()
    this.quickFilterValue = opts.initialState?.quickFilter ?? ''
    this.table = this.build()
  }

  /* -------------------------------------------------------------------- */
  /* Construction                                                          */
  /* -------------------------------------------------------------------- */

  private mergedDef(def: ColumnDef): ColumnDef {
    return { ...this.opts.defaultColumn, ...def }
  }

  /** Définition synthétique de la colonne d'actions. */
  private actionsDef(): ColumnDef | null {
    const cfg = this.opts.actionsColumn
    if (!cfg) return null
    return {
      id: ROW_ACTIONS_COLUMN_ID,
      header: '',
      width: cfg.width,
      minWidth: cfg.width,
      maxWidth: cfg.width,
      pinned: 'end',
      sortable: false,
      resizable: false,
      filter: false,
      lockVisible: true,
      lockPosition: true,
      align: 'center',
      excludeFromExport: true,
    }
  }

  /** Définition synthétique de la colonne de chevron du détail. */
  private detailDef(): ColumnDef | null {
    const cfg = this.opts.detailColumn
    if (!cfg) return null
    return {
      id: DETAIL_COLUMN_ID,
      header: '',
      width: cfg.width,
      minWidth: cfg.width,
      maxWidth: cfg.width,
      pinned: 'start',
      sortable: false,
      resizable: false,
      filter: false,
      lockVisible: true,
      lockPosition: true,
      align: 'center',
      excludeFromExport: true,
    }
  }

  /** Définition synthétique de la colonne de groupe. */
  private groupDef(): ColumnDef | null {
    const cfg = this.opts.groupColumn
    if (!cfg) return null
    return {
      id: GROUP_COLUMN_ID,
      header: '',
      width: cfg.width,
      minWidth: 120,
      pinned: 'start',
      sortable: false,
      resizable: true,
      filter: false,
      lockVisible: true,
      lockPosition: true,
    }
  }

  /** Définition synthétique de la colonne de sélection. */
  private selectionDef(): ColumnDef | null {
    const cfg = this.opts.selectionColumn
    if (!cfg) return null
    return {
      id: SELECTION_COLUMN_ID,
      header: '',
      width: cfg.width,
      minWidth: cfg.width,
      maxWidth: cfg.width,
      pinned: 'start',
      sortable: false,
      resizable: false,
      filter: false,
      lockVisible: true,
      lockPosition: true,
      align: 'center',
      excludeFromExport: true,
    }
  }

  /**
   * Convertit nos `ColumnDef` en colonnes table-core, en reconstituant les
   * groupes d'en-tête à partir de `group`. Les colonnes d'un même groupe non
   * contiguës forment des bandeaux distincts : c'est volontaire, l'ordre
   * affiché prime sur le regroupement logique.
   */
  private buildCoreColumns(): unknown[] {
    const out: unknown[] = []
    let currentGroup: string | null = null
    let bucket: unknown[] | null = null

    const actions = this.actionsDef()

    const detail = this.detailDef()
    if (detail) {
      out.push({
        id: detail.id,
        accessorKey: detail.id,
        header: '',
        size: detail.width,
        minSize: detail.minWidth,
        maxSize: detail.maxWidth,
        enableSorting: false,
        enableResizing: false,
        enableHiding: false,
        enablePinning: true,
        filterFn: 'delegated' as const,
      })
    }

    const group = this.groupDef()
    if (group) {
      out.push({
        id: group.id,
        accessorKey: group.id,
        header: '',
        size: group.width,
        minSize: group.minWidth,
        maxSize: Number.MAX_SAFE_INTEGER,
        enableSorting: false,
        enableResizing: true,
        enableHiding: false,
        enablePinning: true,
        filterFn: 'delegated' as const,
      })
    }

    const selection = this.selectionDef()
    if (selection) {
      out.push({
        id: selection.id,
        accessorKey: selection.id,
        header: '',
        size: selection.width,
        minSize: selection.minWidth,
        maxSize: selection.maxWidth,
        enableSorting: false,
        enableResizing: false,
        enableHiding: false,
        enablePinning: true,
        filterFn: 'delegated' as const,
      })
    }

    for (const raw of this.orderedDefs) {
      const def = this.mergedDef(raw)
      const leaf = {
        id: def.id,
        accessorKey: def.field ?? def.id,
        header: def.header ?? def.id,
        size: def.width ?? this.opts.defaultColumnWidth,
        minSize: def.minWidth ?? 48,
        maxSize: def.maxWidth ?? Number.MAX_SAFE_INTEGER,
        enableSorting: def.sortable !== false,
        enableResizing: def.resizable !== false,
        enableHiding: def.lockVisible !== true,
        enablePinning: true,
        filterFn: 'delegated' as const,
      }

      if (def.group) {
        if (def.group !== currentGroup) {
          bucket = []
          out.push({ id: `__group__${def.group}__${out.length}`, header: def.group, columns: bucket })
          currentGroup = def.group
        }
        bucket!.push(leaf)
      } else {
        currentGroup = null
        bucket = null
        out.push(leaf)
      }
    }

    if (actions) {
      out.push({
        id: actions.id,
        accessorKey: actions.id,
        header: '',
        size: actions.width,
        minSize: actions.minWidth,
        maxSize: actions.maxWidth,
        enableSorting: false,
        enableResizing: false,
        enableHiding: false,
        enablePinning: true,
        filterFn: 'delegated' as const,
      })
    }
    return out
  }

  private buildInitialState(): Record<string, unknown> {
    const init = this.opts.initialState ?? {}

    const visibility: Record<string, boolean> = {}
    const pinStart: string[] = []
    const pinEnd: string[] = []
    const sizing: Record<string, number> = {}

    const selection = this.selectionDef()
    if (selection) pinStart.push(selection.id)
    const group = this.groupDef()
    if (group) pinStart.push(group.id)
    const detail = this.detailDef()
    if (detail) pinStart.push(detail.id)
    const actions = this.actionsDef()
    if (actions) pinEnd.push(actions.id)

    // Les indications portées par les colonnes forment la base…
    const grouped = new Set(this.opts.groupedColumnIds ?? [])
    for (const raw of this.orderedDefs) {
      const def = this.mergedDef(raw)
      if (def.hide || grouped.has(def.id)) visibility[def.id] = false
      if (def.pinned === 'start') pinStart.push(def.id)
      if (def.pinned === 'end') pinEnd.push(def.id)
    }

    // …et l'état restauré (préférences utilisateur) les écrase entièrement.
    // Un état restauré d'une session antérieure peut ignorer la colonne de
    // sélection : on la réinjecte toujours en tête des colonnes épinglées.
    const restoredPinning = init.columnPinning
      ? {
          start: selection && !init.columnPinning.start.includes(selection.id)
            ? [selection.id, ...init.columnPinning.start]
            : init.columnPinning.start,
          end: init.columnPinning.end,
        }
      : { start: pinStart, end: pinEnd }

    // Le masquage des colonnes groupées prime sur l'état restauré : sinon une
    // colonne réapparaîtrait en double, comme colonne ET comme niveau de groupe.
    const restoredVisibility = { ...(init.columnVisibility ?? visibility) }
    for (const id of grouped) restoredVisibility[id] = false

    if (actions && !restoredPinning.end.includes(actions.id)) {
      restoredPinning.end = [...restoredPinning.end, actions.id]
    }

    if (detail && !restoredPinning.start.includes(detail.id)) {
      restoredPinning.start = [...restoredPinning.start, detail.id]
    }

    const startPins = restoredPinning.start
    if (group && !startPins.includes(group.id)) {
      restoredPinning.start = selection && startPins[0] === selection.id
        ? [selection.id, group.id, ...startPins.slice(1)]
        : [group.id, ...startPins]
    }

    return {
      columnVisibility: restoredVisibility,
      columnPinning: restoredPinning,
      columnOrder: init.columnOrder ?? [],
      columnSizing: init.columnSizing ?? sizing,
      sorting: init.sort ?? [],
      columnFilters: Object.entries(init.filters ?? {}).map(([id, value]) => ({ id, value })),
    }
  }

  private build(): TableInstance {
    const actions = this.actionsDef()
    if (actions) this.defs.set(actions.id, actions)
    const detail = this.detailDef()
    if (detail) this.defs.set(detail.id, detail)
    const group = this.groupDef()
    if (group) this.defs.set(group.id, group)
    const selection = this.selectionDef()
    if (selection) this.defs.set(selection.id, selection)
    for (const def of this.orderedDefs) this.defs.set(def.id, this.mergedDef(def))

    const table = constructTable({
      features,
      columns: this.buildCoreColumns(),
      data: [] as AnyRow[],
      initialState: this.buildInitialState(),
      manualSorting: true,
      manualFiltering: true,
      enableMultiSort: true,
      enableColumnResizing: true,
      columnResizeMode: 'onChange',
      getRowId: (_row: AnyRow, index: number) => String(index),
    } as never) as TableInstance

    table.store.subscribe(() => this.opts.onChange())
    return table
  }

  /** Reconstruit l'instance en préservant l'état des colonnes conservées. */
  private rebuild(): void {
    const preserved = this.getState()
    this.defs.clear()
    const known = new Set(this.orderedDefs.map(d => d.id))

    // Purge l'état des colonnes disparues, sinon il ressurgit au prochain
    // ajout d'une colonne de même id.
    const prune = <T>(obj: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(obj).filter(([id]) => known.has(id)))

    this.opts.initialState = {
      columnOrder: preserved.columnOrder.filter(id => known.has(id)),
      columnVisibility: prune(preserved.columnVisibility),
      columnPinning: {
        start: preserved.columnPinning.start.filter(id => known.has(id)),
        end: preserved.columnPinning.end.filter(id => known.has(id)),
      },
      columnSizing: prune(preserved.columnSizing),
      sort: preserved.sort.filter(s => known.has(s.id)),
      filters: prune(preserved.filters),
      quickFilter: preserved.quickFilter,
    }
    this.table = this.build()
    this.opts.onChange()
  }

  /* -------------------------------------------------------------------- */
  /* Lecture pour le rendu                                                 */
  /* -------------------------------------------------------------------- */

  getTable(): TableInstance {
    return this.table
  }

  getDef(id: string): ColumnDef | undefined {
    return this.defs.get(id)
  }

  /** Défs métier, colonne de sélection exclue. */
  getAllDefs(): ColumnDef[] {
    return this.orderedDefs.map(d => this.mergedDef(d))
  }

  /** Défs dans l'ordre d'affichage courant (ordre + épinglage appliqués). */
  getOrderedDefs(): ColumnDef[] {
    return this.getRenderColumns().map(c => c.def)
  }

  private toRenderColumn(core: CoreColumn, pinned: PinPosition, lastStart?: string, firstEnd?: string): RenderColumn {
    const def = this.defs.get(core.id)!
    return {
      id: core.id,
      def,
      core,
      width: core.getSize(),
      pinned,
      stickyOffset: pinned === 'start'
        ? core.getStart('start')
        : pinned === 'end'
          ? core.getAfter('end')
          : 0,
      isLastPinnedStart: core.id === lastStart,
      isFirstPinnedEnd: core.id === firstEnd,
    }
  }

  /** Colonnes visibles dans l'ordre de rendu : épinglées start, centre, épinglées end. */
  getRenderColumns(): RenderColumn[] {
    const start = this.table.getStartVisibleLeafColumns()
    const center = this.table.getCenterVisibleLeafColumns()
    const end = this.table.getEndVisibleLeafColumns()

    const lastStart = start.length ? start[start.length - 1].id : undefined
    const firstEnd = end.length ? end[0].id : undefined

    return [
      ...start.map(c => this.toRenderColumn(c, 'start', lastStart, firstEnd)),
      ...center.map(c => this.toRenderColumn(c, false, lastStart, firstEnd)),
      ...end.map(c => this.toRenderColumn(c, 'end', lastStart, firstEnd)),
    ]
  }

  /**
   * Lignes d'en-tête (la dernière porte les colonnes, les précédentes les
   * groupes).
   *
   * Les trois régions d'épinglage sont lues séparément. `getHeaderGroups()`
   * renvoie la vue non découpée : un groupe dont une seule colonne est
   * épinglée y apparaît comme un bloc unique, et son état d'épinglage devient
   * ambigu — le bandeau se retrouvait alors collé à droite au-dessus de
   * colonnes qui, elles, défilaient.
   */
  getHeaderRows(): RenderHeader[][] {
    const byId = new Map(this.getRenderColumns().map(c => [c.id, c]))

    const regions: Array<{ groups: ReturnType<TableInstance['getHeaderGroups']>; pinned: PinPosition }> = [
      { groups: this.table.getStartHeaderGroups(), pinned: 'start' },
      { groups: this.table.getCenterHeaderGroups(), pinned: false },
      { groups: this.table.getEndHeaderGroups(), pinned: 'end' },
    ]

    const depth = Math.max(0, ...regions.map(r => r.groups.length))
    const rows: RenderHeader[][] = []

    for (let level = 0; level < depth; level++) {
      const row: RenderHeader[] = []

      for (const region of regions) {
        const group = region.groups[level]
        if (!group) continue

        for (const header of group.headers) {
          const isLeaf = header.subHeaders.length === 0
          const column = isLeaf ? byId.get(header.column.id) : undefined

          // Seules les feuilles visibles de CETTE région comptent : la
          // largeur d'un bandeau doit suivre ce qu'il couvre réellement.
          // Dédoublonnage indispensable : sur une cellule « placeholder »
          // (colonne sans groupe, occupant quand même la ligne de groupes),
          // `getLeafHeaders()` renvoie l'en-tête ET sa feuille, ce qui
          // comptait la largeur deux fois.
          const seen = new Set<string>()
          const leaves = header.getLeafHeaders()
            .map(h => byId.get(h.column.id))
            .filter((c): c is RenderColumn => {
              if (c == null || c.pinned !== region.pinned || seen.has(c.id)) return false
              seen.add(c.id)
              return true
            })

          const width = column
            ? column.width
            : leaves.reduce((sum, c) => sum + c.width, 0)

          // À gauche on s'ancre sur la première feuille, à droite sur la
          // dernière : c'est le bord du bandeau qui doit coller.
          const anchor = region.pinned === 'end' ? leaves[leaves.length - 1] : leaves[0]

          row.push({
            id: header.id,
            colSpan: header.colSpan,
            column,
            groupLabel: isLeaf ? undefined : String(header.column.columnDef.header ?? ''),
            core: header,
            isPlaceholder: header.isPlaceholder,
            pinned: region.pinned,
            stickyOffset: column?.stickyOffset ?? anchor?.stickyOffset ?? 0,
            width,
          })
        }
      }
      rows.push(row)
    }
    return rows
  }

  /** Largeur totale des colonnes visibles — dimensionne le conteneur défilant. */
  getTotalWidth(): number {
    return this.getRenderColumns().reduce((sum, c) => sum + c.width, 0)
  }

  getPinnedStartWidth(): number {
    return this.table.getStartVisibleLeafColumns().reduce((s, c) => s + c.getSize(), 0)
  }

  getPinnedEndWidth(): number {
    return this.table.getEndVisibleLeafColumns().reduce((s, c) => s + c.getSize(), 0)
  }

  /* -------------------------------------------------------------------- */
  /* État                                                                  */
  /* -------------------------------------------------------------------- */

  getState(): GridState {
    const s = this.table.store.state
    const filters: GridState['filters'] = {}
    for (const f of s.columnFilters ?? []) {
      filters[f.id] = f.value as GridState['filters'][string]
    }
    return {
      columnOrder: (s.columnOrder ?? []).slice(),
      columnVisibility: { ...(s.columnVisibility ?? {}) },
      columnPinning: {
        start: (s.columnPinning?.start ?? []).slice(),
        end: (s.columnPinning?.end ?? []).slice(),
      },
      columnSizing: { ...(s.columnSizing ?? {}) },
      sort: (s.sorting ?? []).map(x => ({ id: x.id, desc: x.desc })),
      filters,
      quickFilter: this.quickFilterValue,
      // Renseignés par la grille : ni le groupage ni le détail ne font partie
      // du modèle de colonnes de table-core.
      rowGroup: [],
      expandedGroups: [],
      openDetails: [],
    }
  }

  setState(patch: Partial<GridState>): void {
    if (patch.columnOrder) this.table.setColumnOrder(patch.columnOrder)
    if (patch.columnVisibility) this.table.setColumnVisibility(patch.columnVisibility)
    if (patch.columnPinning) this.table.setColumnPinning(patch.columnPinning)
    if (patch.columnSizing) this.table.setColumnSizing(patch.columnSizing)
    if (patch.sort) this.table.setSorting(patch.sort)
    if (patch.filters) {
      this.table.setColumnFilters(
        Object.entries(patch.filters).map(([id, value]) => ({ id, value })),
      )
    }
    if (patch.quickFilter !== undefined) {
      this.quickFilterValue = patch.quickFilter
      this.opts.onChange()
    }
  }

  getQuickFilter(): string {
    return this.quickFilterValue
  }

  setQuickFilter(value: string): void {
    if (this.quickFilterValue === value) return
    this.quickFilterValue = value
    this.opts.onChange()
  }

  /* -------------------------------------------------------------------- */
  /* Mutations de colonnes                                                 */
  /* -------------------------------------------------------------------- */

  addColumn(def: ColumnDef, atIndex?: number): void {
    if (this.orderedDefs.some(d => d.id === def.id)) {
      throw new Error(`IsoGrid: la colonne « ${def.id} » existe déjà`)
    }
    const at = atIndex ?? this.orderedDefs.length
    this.orderedDefs.splice(at, 0, def)
    this.rebuild()
  }

  removeColumn(columnId: string): void {
    const at = this.orderedDefs.findIndex(d => d.id === columnId)
    if (at === -1) return
    this.orderedDefs.splice(at, 1)
    this.rebuild()
  }

  /**
   * Change les colonnes de groupage : la colonne d'arborescence apparaît ou
   * disparaît, et les colonnes groupées passent en masquées. Ces deux effets
   * touchent la structure du modèle, d'où la reconstruction complète.
   */
  setGroupingColumns(columnIds: string[], groupColumn: { width: number } | false): void {
    this.opts.groupedColumnIds = columnIds
    this.opts.groupColumn = groupColumn
    this.rebuild()
  }

  setColumns(defs: ColumnDef[]): void {
    this.orderedDefs = defs.slice()
    this.rebuild()
  }

  setColumnVisible(columnId: string, visible: boolean): void {
    this.table.getColumn(columnId)?.toggleVisibility(visible)
  }

  pinColumn(columnId: string, position: PinPosition): void {
    this.table.getColumn(columnId)?.pin(position)
  }

  /**
   * Déplace une colonne à un index d'affichage. table-core n'expose pas de
   * `move`, seulement l'ordre complet : on le matérialise puis on le
   * réordonne.
   */
  moveColumn(columnId: string, toIndex: number): void {
    const current = this.table.getAllLeafColumns().map(c => c.id)
    const from = current.indexOf(columnId)
    if (from === -1) return
    current.splice(from, 1)
    current.splice(Math.max(0, Math.min(toIndex, current.length)), 0, columnId)
    this.table.setColumnOrder(current)
  }

  setColumnWidth(columnId: string, width: number): void {
    const def = this.defs.get(columnId)
    const min = def?.minWidth ?? 48
    const max = def?.maxWidth ?? Number.MAX_SAFE_INTEGER
    this.table.setColumnSizing(prev => ({
      ...prev,
      [columnId]: Math.max(min, Math.min(max, Math.round(width))),
    }))
  }

  /* -------------------------------------------------------------------- */
  /* Tri et filtres                                                        */
  /* -------------------------------------------------------------------- */

  getSort(): SortModel[] {
    return (this.table.store.state.sorting ?? []).map(s => ({ id: s.id, desc: s.desc }))
  }

  setSort(sort: SortModel[]): void {
    this.table.setSorting(sort)
  }

  /**
   * Bascule le tri d'une colonne. `additive` (Maj-clic) empile le critère au
   * lieu de remplacer — c'est table-core qui gère la séquence
   * asc → desc → aucun et l'index du critère.
   */
  toggleSort(columnId: string, additive: boolean): void {
    const column = this.table.getColumn(columnId)
    if (!column || column.getCanSort() === false) return
    column.toggleSorting(undefined, additive)
  }

  getSortState(columnId: string): { direction: 'asc' | 'desc' | false; index: number } {
    const column = this.table.getColumn(columnId)
    if (!column) return { direction: false, index: -1 }
    return { direction: column.getIsSorted(), index: column.getSortIndex() }
  }

  getFilters(): GridState['filters'] {
    return this.getState().filters
  }

  setFilter(columnId: string, model: GridState['filters'][string] | null): void {
    const column = this.table.getColumn(columnId)
    if (!column) return
    column.setFilterValue(model ?? undefined)
  }

  clearFilters(): void {
    this.table.setColumnFilters([])
  }

  getActiveFilterCount(): number {
    return (this.table.store.state.columnFilters ?? []).length
  }

  destroy(): void {
    // table-core n'a pas de ressource externe à libérer ; les abonnements
    // sont tenus par le store, qui disparaît avec l'instance.
  }
}
