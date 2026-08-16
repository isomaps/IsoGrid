import type {
  AnyRow, CellContext, ColumnDef, Datasource, ExportOptions, ExportProgress,
  GridState, IconName, IsoGridApi, IsoGridOptions, LocaleCode, PinPosition,
  SetFilterOption, SortModel, ThemeMode,
} from '../core/types'
import { ColumnModel, type RenderColumn } from '../core/table'
import {
  SELECTION_COLUMN_ID, SelectionModel,
  type SelectionSnapshot, type SelectionState,
} from '../core/selection'
import { Translator, resolveLocale } from '../core/i18n'
import { BlockCache, createHttpDatasource } from '../datasource/server'
import { ClientDatasource } from '../datasource/client'
import { normalizeFilter } from '../filters/model'
import { collectExportData, rawCellValue } from '../export/collect'
import { exportToCsv } from '../export/csv'
import { exportToExcel } from '../export/excel'
import type { GridContext } from './context'
import { HeaderRenderer } from './header'
import { Sidebar } from './sidebar'
import { Toolbar } from './toolbar'
import { ContextMenu, type ContextMenuOptions } from './context-menu'
import { NS, el, getPath, renderIcon } from './dom'

const DEFAULTS = {
  rowHeight: 36,
  headerHeight: 40,
  blockSize: 100,
  maxBlocksInCache: 20,
  defaultColumnWidth: 160,
  selectionColumnWidth: 44,
  /** Lignes rendues en surplus au-dessus et au-dessous de la fenêtre visible. */
  overscan: 6,
} as const

export class IsoGrid<TRow extends AnyRow = AnyRow> implements IsoGridApi<TRow> {
  private options: IsoGridOptions<TRow>
  private t: Translator
  private columnModel: ColumnModel
  private cache: BlockCache<TRow>
  private clientSource?: ClientDatasource<TRow>
  private selection: SelectionModel
  /** Dernière ligne cochée, pour la sélection de plage au Maj-clic. */
  private lastSelectedIndex: number | null = null
  private ctx: GridContext

  /* --- DOM --- */
  private root: HTMLElement
  private viewport!: HTMLElement
  private bodyEl!: HTMLElement
  private overlay!: HTMLElement
  private statusEl?: HTMLElement
  private headerRenderer: HeaderRenderer
  private toolbar?: Toolbar
  private sidebar?: Sidebar
  private contextMenu?: ContextMenu

  /* --- état de rendu --- */
  private renderedRows = new Map<number, HTMLElement>()
  private scrollFrame = 0
  private destroyed = false
  private lastDataSignature = ''
  private lastFilterSignature = ''
  private warnedRowIds = false
  private lastError: unknown = null
  private themeMediaQuery?: MediaQueryList
  private resizeObserver?: ResizeObserver

  constructor(container: HTMLElement, options: IsoGridOptions<TRow>) {
    this.options = options
    this.t = new Translator(resolveLocale(options.locale), options.messages)

    this.selection = new SelectionModel(() => this.onSelectionChange())

    this.columnModel = new ColumnModel({
      columns: options.columns as ColumnDef[],
      selectionColumn: options.rowSelection === 'multiple'
        ? { width: options.selectionColumnWidth ?? DEFAULTS.selectionColumnWidth }
        : false,
      defaultColumn: options.defaultColumn as Partial<ColumnDef>,
      defaultColumnWidth: options.defaultColumnWidth ?? DEFAULTS.defaultColumnWidth,
      initialState: options.initialState,
      onChange: () => this.onColumnModelChange(),
    })

    const datasource = this.resolveDatasource()
    this.cache = new BlockCache<TRow>({
      datasource,
      blockSize: options.blockSize ?? DEFAULTS.blockSize,
      maxBlocks: options.maxBlocksInCache ?? DEFAULTS.maxBlocksInCache,
      onChange: () => this.onDataChange(),
      onError: (error) => this.onLoadError(error),
    })

    this.ctx = {
      columns: this.columnModel,
      t: this.t,
      options: this.options as IsoGridOptions<AnyRow>,
      api: this as unknown as IsoGridApi<AnyRow>,
      icon: (name: IconName) => renderIcon(name, this.options.renderIcon),
      requestRender: () => this.render(),
      reload: () => this.reload(),
      emitState: () => this.emitState(),
      fetchSetValues: (columnId) => this.fetchSetValues(columnId),
      selectAllCheckbox: options.rowSelection === 'multiple'
        ? () => this.buildSelectAllCheckbox()
        : undefined,
    }

    this.headerRenderer = new HeaderRenderer(this.ctx)
    if (options.contextMenu !== false) {
      this.contextMenu = new ContextMenu(this.ctx, (options.contextMenu ?? {}) as ContextMenuOptions)
    }
    this.root = this.buildLayout(container)

    this.lastDataSignature = this.dataSignature()
    this.lastFilterSignature = this.filterSignature()
    this.applyTheme(options.theme ?? 'auto')
    this.render()
    this.refreshVisibleRange()
  }

  /* -------------------------------------------------------------------- */
  /* Construction du DOM                                                   */
  /* -------------------------------------------------------------------- */

  private resolveDatasource(): Datasource<TRow> {
    const { rowModel, datasource, rows } = this.options
    if (rowModel === 'server' || (datasource && rowModel !== 'client')) {
      if (!datasource) {
        throw new Error('IsoGrid: le mode serveur exige une option `datasource`.')
      }
      return typeof datasource === 'string'
        ? createHttpDatasource<TRow>(datasource)
        : datasource
    }
    this.clientSource = new ClientDatasource<TRow>(rows ?? [], this.options.columns)
    return this.clientSource
  }

  private buildLayout(container: HTMLElement): HTMLElement {
    const root = el('div', {
      class: `${NS}-root`,
      attrs: { role: 'grid', 'aria-busy': 'false' },
    })
    if (this.options.stripedRows !== false) root.classList.add(`${NS}-striped`)

    if (this.options.toolbar !== false) {
      this.toolbar = new Toolbar(
        this.ctx,
        this.options.toolbar ?? {},
        (panel) => this.togglePanel(panel),
      )
      root.append(this.toolbar.element)
    }

    this.bodyEl = el('div', { class: `${NS}-body`, attrs: { role: 'rowgroup' } })
    this.overlay = el('div', { class: `${NS}-overlay` })

    this.viewport = el('div', {
      class: `${NS}-viewport`,
      attrs: { tabindex: 0 },
      children: [this.headerRenderer.element, this.bodyEl],
    })
    this.viewport.addEventListener('scroll', () => this.onScroll(), { passive: true })

    const main = el('div', {
      class: `${NS}-main`,
      children: [el('div', { class: `${NS}-viewport-wrap`, children: [this.viewport, this.overlay] })],
    })

    if (this.options.sidebar !== false) {
      this.sidebar = new Sidebar(this.ctx, this.options.sidebar ?? {})
      main.append(this.sidebar.element)
    }
    root.append(main)

    if (this.options.statusBar !== false) {
      this.statusEl = el('div', { class: `${NS}-status`, attrs: { role: 'status', 'aria-live': 'polite' } })
      root.append(this.statusEl)
    }

    container.append(root)

    // Le nombre de lignes visibles dépend de la hauteur du conteneur : sans
    // observation, un panneau qui s'ouvre laisse des trous dans le corps.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.refreshVisibleRange())
      this.resizeObserver.observe(this.viewport)
    }
    return root
  }

  /* -------------------------------------------------------------------- */
  /* Sélection                                                             */
  /* -------------------------------------------------------------------- */

  /**
   * Identifiant stable d'une ligne.
   *
   * L'index n'est un repli acceptable qu'en mode client : côté serveur il
   * change dès qu'on retrie, et la sélection porterait alors sur d'autres
   * lignes. D'où l'avertissement au montage.
   */
  private rowId(row: TRow, index: number): string {
    if (this.options.getRowId) return this.options.getRowId(row, index)
    const id = (row as AnyRow).id
    return id != null ? String(id) : String(index)
  }

  private isSelectionEnabled(): boolean {
    return this.options.rowSelection === 'single' || this.options.rowSelection === 'multiple'
  }

  /** Prévient si la sélection repose sur des index en mode serveur. */
  private warnUnstableRowIds(): void {
    if (!this.isSelectionEnabled() || this.clientSource) return
    if (this.options.getRowId) return
    const sample = this.cache.getLoadedRows()[0]
    if (sample && (sample as AnyRow).id != null) return
    console.warn(
      '[IsoGrid] rowSelection est actif en mode serveur sans `getRowId` ni champ `id` : '
      + "la sélection retombe sur l'index de ligne, qui change à chaque tri. "
      + 'Fournir un identifiant métier stable.',
    )
  }

  private onSelectionChange(): void {
    if (this.destroyed) return
    this.repaintSelection()
    this.renderStatus()
    this.options.onSelectionChanged?.(this.getSelection(), this)
  }

  /**
   * Met à jour les cases et les classes des lignes visibles, sans reconstruire
   * le corps : redessiner ferait perdre le focus et la position de défilement.
   */
  private repaintSelection(): void {
    for (const [index, node] of this.renderedRows) {
      const row = this.cache.getRow(index)
      if (!row) continue
      const selected = this.selection.isSelected(this.rowId(row, index))
      node.classList.toggle(`${NS}-row-selected`, selected)
      node.setAttribute('aria-selected', String(selected))
      const box = node.querySelector<HTMLInputElement>(`.${NS}-select-box`)
      if (box) box.checked = selected
    }
    this.syncHeaderCheckbox()
  }

  private syncHeaderCheckbox(): void {
    const box = this.headerRenderer.element.querySelector<HTMLInputElement>(`.${NS}-select-all-box`)
    if (!box) return
    const state = this.selection.headerState(this.cache.getRowCount())
    box.checked = state === 'all'
    box.indeterminate = state === 'some'
  }

  /** Case d'en-tête « tout sélectionner ». Consommée par le rendu d'en-tête. */
  buildSelectAllCheckbox(): HTMLElement {
    const state = this.selection.headerState(this.cache.getRowCount())
    const box = el('input', {
      class: `${NS}-select-all-box`,
      attrs: {
        type: 'checkbox',
        checked: state === 'all',
        'aria-label': this.t.t('selectAllRows'),
        title: this.t.t('selectAllRows'),
      },
      on: {
        click: (e: MouseEvent) => e.stopPropagation(),
        change: (e: Event) => {
          const on = (e.target as HTMLInputElement).checked
          on ? this.selection.selectAll() : this.selection.clear()
        },
      },
    })
    box.indeterminate = state === 'some'
    return box
  }

  /* -------------------------------------------------------------------- */
  /* Cycle de rendu                                                        */
  /* -------------------------------------------------------------------- */

  /** Signature des réglages qui invalident les données chargées. */
  private dataSignature(): string {
    const state = this.columnModel.getState()
    return JSON.stringify([state.sort, state.filters, state.quickFilter])
  }

  /** Filtres et recherche seuls : le TRI ne change pas l'ensemble des lignes. */
  private filterSignature(): string {
    const state = this.columnModel.getState()
    return JSON.stringify([state.filters, state.quickFilter])
  }

  private onColumnModelChange(): void {
    if (this.destroyed) return

    // Changer un filtre change l'ensemble des lignes : en mode `exclude`,
    // « tout sauf ces trois-là » désignerait alors silencieusement d'autres
    // lignes. Un tri, lui, ne fait que réordonner — la sélection reste juste.
    const filterSignature = this.filterSignature()
    if (filterSignature !== this.lastFilterSignature) {
      this.lastFilterSignature = filterSignature
      this.selection.clear()
      this.lastSelectedIndex = null
    }

    const signature = this.dataSignature()
    if (signature !== this.lastDataSignature) {
      this.lastDataSignature = signature
      this.reload()
    } else {
      this.render()
    }
    this.emitState()
  }

  private onDataChange(): void {
    if (this.destroyed) return
    if (!this.warnedRowIds) { this.warnedRowIds = true; this.warnUnstableRowIds() }
    this.renderBody()
    this.renderStatus()
    this.renderOverlay()
  }

  private onLoadError(error: unknown): void {
    this.lastError = error
    if (this.options.onError) this.options.onError(error)
    else console.error('[IsoGrid]', error)
    this.renderOverlay()
  }

  /** Redessine tout : en-tête, corps, panneau, barres. */
  render(): void {
    if (this.destroyed) return
    this.headerRenderer.render()
    this.syncWidths()
    this.renderedRows.clear()
    this.bodyEl.replaceChildren()
    this.renderBody()
    this.sidebar?.render()
    this.toolbar?.syncQuickFilter()
    this.toolbar?.syncFilterCount()
    this.renderStatus()
    this.renderOverlay()
  }

  /** Aligne les largeurs du corps et de l'en-tête sur le total des colonnes. */
  private syncWidths(): void {
    const total = this.columnModel.getTotalWidth()
    this.bodyEl.style.width = `${total}px`
    for (const row of Array.from(this.headerRenderer.element.children) as HTMLElement[]) {
      row.style.width = `${total}px`
    }
  }

  private onScroll(): void {
    if (this.scrollFrame) return
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0
      this.refreshVisibleRange()
    })
  }

  private rowHeight(): number {
    return this.options.rowHeight ?? DEFAULTS.rowHeight
  }

  /** Fenêtre de lignes à matérialiser, marge comprise. */
  private visibleRange(): { start: number; end: number } {
    const rowHeight = this.rowHeight()
    const scrollTop = this.viewport.scrollTop
    const height = this.viewport.clientHeight || 400
    const total = this.totalRowCount()

    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - DEFAULTS.overscan)
    const visibleCount = Math.ceil(height / rowHeight) + DEFAULTS.overscan * 2
    return { start: first, end: Math.min(total, first + visibleCount) }
  }

  private totalRowCount(): number {
    return this.cache.getVirtualRowCount()
  }

  private refreshVisibleRange(): void {
    if (this.destroyed) return
    const { start, end } = this.visibleRange()
    this.cache.requestContext = this.buildRequestContext()
    this.cache.ensureRange(start, end)
    this.renderBody()
  }

  private buildRequestContext() {
    const state = this.columnModel.getState()
    const filters: GridState['filters'] = {}
    for (const [id, model] of Object.entries(state.filters)) {
      // Les conditions à moitié saisies ne partent jamais au serveur.
      const normalized = normalizeFilter(model)
      if (normalized) filters[id] = normalized
    }
    return {
      sort: state.sort,
      filters,
      quickFilter: state.quickFilter,
      columns: this.columnModel.getRenderColumns().map(c => c.id),
    }
  }

  /* -------------------------------------------------------------------- */
  /* Corps                                                                 */
  /* -------------------------------------------------------------------- */

  private renderBody(): void {
    const rowHeight = this.rowHeight()
    const total = this.totalRowCount()
    this.bodyEl.style.height = `${total * rowHeight}px`

    const { start, end } = this.visibleRange()

    // Recyclage : on ne touche qu'aux lignes entrées ou sorties de la fenêtre.
    for (const [index, node] of this.renderedRows) {
      if (index < start || index >= end) {
        node.remove()
        this.renderedRows.delete(index)
      }
    }

    const columns = this.columnModel.getRenderColumns()
    for (let i = start; i < end; i++) {
      const existing = this.renderedRows.get(i)
      const row = this.cache.getRow(i)

      // Une ligne squelette est remplacée dès que sa donnée arrive.
      if (existing) {
        const wasSkeleton = existing.dataset.skeleton === '1'
        if (!wasSkeleton || !row) continue
        existing.remove()
        this.renderedRows.delete(i)
      }

      const node = this.buildRow(i, row, columns, rowHeight)
      this.renderedRows.set(i, node)
      this.bodyEl.append(node)
    }
  }

  private buildRow(
    index: number,
    row: TRow | undefined,
    columns: RenderColumn[],
    rowHeight: number,
  ): HTMLElement {
    const selected = row != null && this.isSelectionEnabled()
      && this.selection.isSelected(this.rowId(row, index))

    const node = el('div', {
      class: [
        `${NS}-row`,
        index % 2 === 1 ? `${NS}-row-odd` : '',
        row ? '' : `${NS}-row-loading`,
        selected ? `${NS}-row-selected` : '',
      ].filter(Boolean).join(' '),
      attrs: {
        role: 'row',
        'aria-rowindex': index + 1,
        'aria-selected': this.isSelectionEnabled() ? String(selected) : undefined,
      },
      style: { height: `${rowHeight}px`, transform: `translateY(${index * rowHeight}px)` },
    })
    if (!row) node.dataset.skeleton = '1'

    for (const column of columns) {
      node.append(this.buildCell(column, row, index))
    }

    if (row) {
      if (this.isSelectionEnabled() && this.options.selectOnRowClick) {
        node.addEventListener('click', (e) => this.applySelectionClick(row, index, e.shiftKey))
      }
      if (this.options.onRowClick) {
        node.addEventListener('click', e => this.options.onRowClick!(row, index, e))
      }
      if (this.options.onRowDoubleClick) {
        node.addEventListener('dblclick', e => this.options.onRowDoubleClick!(row, index, e))
      }
    }
    return node
  }

  private buildCell(column: RenderColumn, row: TRow | undefined, rowIndex: number): HTMLElement {
    const def = column.def as ColumnDef<TRow>
    const cell = el('div', {
      class: [
        `${NS}-cell`,
        column.pinned ? `${NS}-pinned-${column.pinned}` : '',
        column.isLastPinnedStart ? `${NS}-pin-edge-start` : '',
        column.isFirstPinnedEnd ? `${NS}-pin-edge-end` : '',
        def.align ? `${NS}-align-${def.align}` : (def.type === 'number' ? `${NS}-align-right` : ''),
      ].filter(Boolean).join(' '),
      attrs: { role: 'gridcell', 'data-col-id': column.id },
      style: { width: `${column.width}px` },
    })

    if (column.pinned) {
      cell.style.position = 'sticky'
      cell.style.zIndex = '2'
      if (column.pinned === 'start') cell.style.left = `${column.stickyOffset}px`
      else cell.style.right = `${column.stickyOffset}px`
    }

    if (column.id === SELECTION_COLUMN_ID) {
      if (row) cell.append(this.buildRowCheckbox(row, rowIndex))
      return cell
    }

    if (!row) {
      cell.append(el('span', { class: `${NS}-skeleton` }))
      return cell
    }

    const value = getPath(row, def.field ?? def.id)
    const ctx: CellContext<TRow> = { value, row, rowIndex, column: def, grid: this }

    if (def.cellRenderer) {
      const out = def.cellRenderer(ctx)
      if (typeof out === 'string') cell.innerHTML = out
      else cell.append(out)
    } else {
      cell.textContent = this.formatValue(def, ctx)
    }

    const extraClass = typeof def.cellClass === 'function' ? def.cellClass(ctx) : def.cellClass
    if (extraClass) cell.classList.add(...extraClass.split(/\s+/).filter(Boolean))

    if (this.options.onCellClick) {
      cell.addEventListener('click', e => this.options.onCellClick!(ctx, e))
    }

    // Le clic droit est écouté sur la cellule et non sur la ligne : c'est le
    // seul niveau où l'on sait quelle colonne est visée, donc quelle valeur
    // « copier la cellule » doit prendre.
    if (this.contextMenu) {
      cell.addEventListener('contextmenu', (e: MouseEvent) => {
        this.contextMenu!.open(e, {
          row, rowIndex, column: def as ColumnDef,
          value,
          formattedValue: def.cellRenderer ? (cell.textContent ?? '') : this.formatValue(def, ctx),
        })
      })
    }
    return cell
  }

  private buildRowCheckbox(row: TRow, rowIndex: number): HTMLElement {
    const id = this.rowId(row, rowIndex)
    return el('input', {
      class: `${NS}-select-box`,
      attrs: {
        type: 'checkbox',
        checked: this.selection.isSelected(id),
        'aria-label': this.t.t('selectRow'),
      },
      on: {
        // Sans cela, le clic remonterait à la ligne et déclencherait
        // `onRowClick` — donc souvent une navigation.
        click: (e: MouseEvent) => {
          e.stopPropagation()
          this.applySelectionClick(row, rowIndex, e.shiftKey)
        },
      },
    })
  }

  /**
   * Applique un clic de sélection. Le Maj-clic étend depuis la dernière ligne
   * cochée, mais seulement sur les lignes chargées : on ne peut pas cocher ce
   * qu'on n'a pas.
   */
  private applySelectionClick(row: TRow, rowIndex: number, extend: boolean): void {
    const id = this.rowId(row, rowIndex)

    if (this.options.rowSelection === 'single') {
      this.selection.isSelected(id) ? this.selection.clear() : this.selection.selectOnly(id)
      this.lastSelectedIndex = rowIndex
      return
    }

    if (extend && this.lastSelectedIndex != null) {
      const from = Math.min(this.lastSelectedIndex, rowIndex)
      const to = Math.max(this.lastSelectedIndex, rowIndex)
      const target = !this.selection.isSelected(id)
      const ids: string[] = []
      for (let i = from; i <= to; i++) {
        const r = this.cache.getRow(i)
        if (r) ids.push(this.rowId(r, i))
      }
      this.selection.selectRange(ids, target)
      this.lastSelectedIndex = rowIndex
      return
    }

    this.selection.toggle(id)
    this.lastSelectedIndex = rowIndex
  }

  /** Formatage par défaut : nombres et dates suivent la locale de la grille. */
  private formatValue(def: ColumnDef<TRow>, ctx: CellContext<TRow>): string {
    if (def.valueFormatter) return def.valueFormatter(ctx)
    const value = ctx.value
    if (value == null || value === '') return ''

    if (def.type === 'number') {
      const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'))
      return Number.isNaN(n) ? String(value) : this.t.number(n)
    }
    if (def.type === 'date' || def.type === 'datetime') {
      const d = value instanceof Date ? value : new Date(String(value))
      if (Number.isNaN(d.getTime())) return String(value)
      return def.type === 'datetime'
        ? this.t.date(d, { dateStyle: 'short', timeStyle: 'short' })
        : this.t.date(d)
    }
    if (def.type === 'boolean' || typeof value === 'boolean') {
      return value ? this.t.t('true') : this.t.t('false')
    }
    return String(value)
  }

  /* -------------------------------------------------------------------- */
  /* Bandeaux d'état                                                       */
  /* -------------------------------------------------------------------- */

  private renderOverlay(): void {
    this.overlay.replaceChildren()
    const count = this.cache.getRowCount()

    if (this.lastError) {
      this.overlay.className = `${NS}-overlay ${NS}-visible`
      this.overlay.append(el('div', {
        class: `${NS}-overlay-box ${NS}-overlay-error`,
        children: [
          this.ctx.icon('warning'),
          el('span', { text: this.t.t('loadingError') }),
          el('button', {
            class: `${NS}-btn`,
            attrs: { type: 'button' },
            text: this.t.t('retry'),
            on: { click: () => { this.lastError = null; this.reload() } },
          }),
        ],
      }))
      return
    }

    if (count === 0) {
      this.overlay.className = `${NS}-overlay ${NS}-visible`
      this.overlay.append(el('div', {
        class: `${NS}-overlay-box`,
        children: [el('span', { text: this.t.t('noRows') })],
      }))
      return
    }

    this.overlay.className = `${NS}-overlay`
  }

  private renderStatus(): void {
    if (!this.statusEl) return
    const count = this.cache.getRowCount()
    const filterCount = this.columnModel.getActiveFilterCount()
    const hasQuick = this.columnModel.getQuickFilter().trim() !== ''
    const isFiltered = filterCount > 0 || hasQuick

    this.statusEl.replaceChildren(
      el('span', {
        class: `${NS}-status-count`,
        text: count == null
          ? this.t.t('loading')
          : `${this.t.number(count)} ${isFiltered ? this.t.t('rowsFiltered') : this.t.t('rows')}`,
      }),
    )

    if (isFiltered) {
      this.statusEl.append(el('button', {
        class: `${NS}-btn ${NS}-btn-ghost ${NS}-btn-sm`,
        attrs: { type: 'button' },
        text: this.t.t('clearAllFilters'),
        on: {
          click: () => {
            this.columnModel.clearFilters()
            this.columnModel.setQuickFilter('')
          },
        },
      }))
    }

    if (this.isSelectionEnabled()) {
      const sel = this.getSelection()
      if (!sel.isEmpty) {
        this.statusEl.append(el('span', { class: `${NS}-status-sep` }))
        this.statusEl.append(el('span', {
          class: `${NS}-status-selection`,
          text: sel.isAll && sel.count == null
            ? this.t.t('allRowsSelected')
            : `${this.t.number(sel.count ?? 0)} ${this.t.t('selected')}`,
        }))
        this.statusEl.append(el('button', {
          class: `${NS}-btn ${NS}-btn-ghost ${NS}-btn-sm`,
          attrs: { type: 'button' },
          text: this.t.t('clearSelection'),
          on: { click: () => this.deselectAll() },
        }))
      }
    }
  }

  /** Bascule un panneau depuis la barre d'outils : re-cliquer referme. */
  private togglePanel(panel: 'columns' | 'filters'): void {
    this.sidebar?.toggle(panel)
  }

  private async fetchSetValues(columnId: string): Promise<SetFilterOption[]> {
    const def = this.columnModel.getDef(columnId)
    if (def?.filterValues) {
      return typeof def.filterValues === 'function' ? def.filterValues() : def.filterValues
    }
    const source = this.clientSource ?? (this.options.datasource as Datasource<TRow> | undefined)
    const resolved = typeof source === 'object' && source?.getSetValues ? source : null
    if (!resolved?.getSetValues) return []

    const request = this.buildRequestContext()
    return resolved.getSetValues(columnId, request)
  }

  /* -------------------------------------------------------------------- */
  /* Thème                                                                 */
  /* -------------------------------------------------------------------- */

  private applyTheme(theme: ThemeMode): void {
    this.themeMediaQuery?.removeEventListener('change', this.onSystemTheme)
    if (theme === 'auto') {
      this.root.removeAttribute('data-isg-theme')
      this.themeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      this.themeMediaQuery.addEventListener('change', this.onSystemTheme)
    } else {
      this.root.setAttribute('data-isg-theme', theme)
    }
  }

  private onSystemTheme = (): void => { /* les tokens CSS suivent la media query */ }

  /* ==================================================================== */
  /* API publique                                                          */
  /* ==================================================================== */

  getState(): GridState {
    return this.columnModel.getState()
  }

  setState(state: Partial<GridState>): void {
    this.columnModel.setState(state)
  }

  resetState(): void {
    this.columnModel.setColumns(this.options.columns as ColumnDef[])
  }

  private emitState(): void {
    this.options.onStateChange?.(this.getState())
  }

  getColumns(): ColumnDef<TRow>[] {
    return this.columnModel.getAllDefs() as ColumnDef<TRow>[]
  }

  addColumn(def: ColumnDef<TRow>, atIndex?: number): void {
    this.columnModel.addColumn(def as ColumnDef, atIndex)
    this.clientSource?.setColumns(this.getColumns())
    // Le serveur n'a pas forcément renvoyé ce champ pour les lignes déjà en
    // cache : on repart proprement.
    this.reload()
  }

  removeColumn(columnId: string): void {
    this.columnModel.removeColumn(columnId)
    this.clientSource?.setColumns(this.getColumns())
    this.render()
  }

  setColumns(defs: ColumnDef<TRow>[]): void {
    this.options.columns = defs
    this.columnModel.setColumns(defs as ColumnDef[])
    this.clientSource?.setColumns(defs)
    this.reload()
  }

  setColumnVisible(columnId: string, visible: boolean): void {
    this.columnModel.setColumnVisible(columnId, visible)
  }

  moveColumn(columnId: string, toIndex: number): void {
    this.columnModel.moveColumn(columnId, toIndex)
  }

  pinColumn(columnId: string, position: PinPosition): void {
    this.columnModel.pinColumn(columnId, position)
  }

  /**
   * Ajuste une colonne au contenu chargé. La mesure se fait au canvas avec la
   * police réelle de la cellule : c'est nettement moins coûteux que
   * d'insérer un nœud fantôme par ligne et de lire son `offsetWidth`.
   */
  autoSizeColumn(columnId: string): void {
    const def = this.columnModel.getDef(columnId)
    if (!def) return

    const probe = this.bodyEl.querySelector<HTMLElement>(`.${NS}-cell[data-col-id="${CSS.escape(columnId)}"]`)
    const style = getComputedStyle(probe ?? this.bodyEl)
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) return
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`

    const measure = (text: string) => context.measureText(text).width
    let widest = measure(this.t.header(def.header ?? def.id)) + 56 // libellé + tri + actions

    for (const row of this.cache.getLoadedRows()) {
      const ctx: CellContext<TRow> = {
        value: getPath(row, def.field ?? def.id),
        row: row as TRow,
        rowIndex: 0,
        column: def as ColumnDef<TRow>,
        grid: this,
      }
      widest = Math.max(widest, measure(this.formatValue(def as ColumnDef<TRow>, ctx)) + 24)
    }

    this.columnModel.setColumnWidth(columnId, Math.ceil(widest))
    this.emitState()
  }

  /** Répartit la largeur disponible entre les colonnes visibles. */
  sizeColumnsToFit(): void {
    const available = this.viewport.clientWidth - 2
    const columns = this.columnModel.getRenderColumns()
    if (columns.length === 0 || available <= 0) return

    const total = columns.reduce((sum, c) => sum + c.width, 0)
    if (total === 0) return
    const ratio = available / total

    for (const column of columns) {
      this.columnModel.setColumnWidth(column.id, column.width * ratio)
    }
    this.emitState()
  }

  setSort(sort: SortModel[]): void {
    this.columnModel.setSort(sort)
  }

  setFilter(columnId: string, model: GridState['filters'][string] | null): void {
    this.columnModel.setFilter(columnId, normalizeFilter(model))
  }

  clearFilters(): void {
    this.columnModel.clearFilters()
  }

  setQuickFilter(value: string): void {
    this.columnModel.setQuickFilter(value)
  }

  refresh(): void {
    this.cache.refresh()
    this.refreshVisibleRange()
  }

  reload(): void {
    this.lastError = null
    this.cache.invalidate()
    this.cache.requestContext = this.buildRequestContext()
    this.viewport.scrollTop = 0
    this.renderedRows.clear()
    this.bodyEl.replaceChildren()
    this.headerRenderer.render()
    this.syncWidths()
    this.sidebar?.render()
    // Un `setQuickFilter()` appelé par programme (restauration d'état, bouton
    // « effacer les filtres ») doit se voir dans le champ de la barre d'outils.
    this.toolbar?.syncQuickFilter()
    this.toolbar?.syncFilterCount()
    this.refreshVisibleRange()
    this.renderStatus()
    this.renderOverlay()
  }

  setRows(rows: TRow[]): void {
    if (!this.clientSource) {
      throw new Error('IsoGrid: `setRows` n\'existe qu\'en mode client. En mode serveur, utiliser `refresh()`.')
    }
    this.clientSource.setRows(rows)
    this.reload()
  }

  getDisplayedRowCount(): number | null {
    return this.cache.getRowCount()
  }

  getLoadedRows(): TRow[] {
    return this.cache.getLoadedRows()
  }

  /* --- export --- */

  private exportSettings(override?: ExportOptions) {
    const base = this.options.export ?? {}
    return {
      filename: override?.filename ?? base.filename ?? 'export',
      sheetName: override?.sheetName ?? base.sheetName ?? 'Export',
      source: override?.source ?? base.source ?? 'all',
      maxRows: override?.maxRows ?? base.maxRows ?? 100_000,
      pageSize: override?.pageSize ?? base.pageSize ?? 1000,
      freezeHeader: override?.freezeHeader ?? base.freezeHeader ?? true,
      autoFilter: override?.autoFilter ?? base.autoFilter ?? true,
      excelJs: override?.excelJs ?? base.excelJs,
    }
  }

  private async buildExportDataset(
    settings: ReturnType<IsoGrid<TRow>['exportSettings']>,
    onProgress?: (p: ExportProgress) => void,
  ) {
    this.cache.requestContext = this.buildRequestContext()
    return collectExportData({
      cache: this.cache as BlockCache,
      columns: this.columnModel.getRenderColumns().map(c => c.def),
      headerLabel: col => this.t.header(col.header ?? col.id),
      cellValue: (col, row, rowIndex) => {
        const def = col as ColumnDef<TRow>
        if (def.exportValue) {
          return def.exportValue({
            value: getPath(row, def.field ?? def.id),
            row: row as TRow,
            rowIndex,
            column: def,
            grid: this,
          })
        }
        return rawCellValue(col, row)
      },
      options: { source: settings.source, maxRows: settings.maxRows, pageSize: settings.pageSize },
      onProgress,
    })
  }

  async exportExcel(options?: ExportOptions & { onProgress?: (p: ExportProgress) => void }): Promise<void> {
    const settings = this.exportSettings(options)
    this.setBusy(true)
    try {
      const dataset = await this.buildExportDataset(settings, options?.onProgress)
      await exportToExcel(dataset, {
        filename: settings.filename,
        sheetName: settings.sheetName,
        freezeHeader: settings.freezeHeader,
        autoFilter: settings.autoFilter,
        frozenColumns: this.columnModel.getRenderColumns().filter(c => c.pinned === 'start').length,
        excelJs: settings.excelJs,
      })
      options?.onProgress?.({ loaded: dataset.rows.length, total: dataset.rows.length, phase: 'done' })
      if (dataset.truncated) console.warn('[IsoGrid]', this.t.t('exportTruncated'))
    } catch (error) {
      this.onLoadError(error)
      throw error
    } finally {
      this.setBusy(false)
    }
  }

  async exportCsv(options?: ExportOptions & { onProgress?: (p: ExportProgress) => void }): Promise<void> {
    const settings = this.exportSettings(options)
    this.setBusy(true)
    try {
      const dataset = await this.buildExportDataset(settings, options?.onProgress)
      exportToCsv(dataset, { filename: settings.filename })
      options?.onProgress?.({ loaded: dataset.rows.length, total: dataset.rows.length, phase: 'done' })
      if (dataset.truncated) console.warn('[IsoGrid]', this.t.t('exportTruncated'))
    } catch (error) {
      this.onLoadError(error)
      throw error
    } finally {
      this.setBusy(false)
    }
  }

  private setBusy(busy: boolean): void {
    this.root.setAttribute('aria-busy', String(busy))
    this.root.classList.toggle(`${NS}-busy`, busy)
  }

  /* --- sélection --- */

  getSelectedRows(): TRow[] {
    if (!this.isSelectionEnabled()) return []
    const out: TRow[] = []
    const loaded = this.cache.getLoadedRows()
    loaded.forEach((row, i) => {
      if (this.selection.isSelected(this.rowId(row, i))) out.push(row)
    })
    return out
  }

  getSelection(): SelectionSnapshot {
    return this.selection.getSnapshot(this.cache.getRowCount())
  }

  setSelection(state: SelectionState | null): void {
    this.selection.restore(state)
    this.onSelectionChange()
  }

  setRowSelected(rowId: string, selected: boolean): void {
    this.selection.setSelected(rowId, selected)
  }

  isRowSelected(rowId: string): boolean {
    return this.selection.isSelected(rowId)
  }

  selectAll(): void {
    this.selection.selectAll()
  }

  deselectAll(): void {
    this.selection.clear()
    this.lastSelectedIndex = null
  }

  /* --- divers --- */

  setLocale(locale: LocaleCode): void {
    this.t.setLocale(locale)
    this.toolbar?.render()
    this.render()
  }

  setTheme(theme: ThemeMode): void {
    this.applyTheme(theme)
  }

  destroy(): void {
    this.destroyed = true
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame)
    this.contextMenu?.close()
    this.resizeObserver?.disconnect()
    this.themeMediaQuery?.removeEventListener('change', this.onSystemTheme)
    this.cache.destroy()
    this.columnModel.destroy()
    this.root.remove()
  }
}
