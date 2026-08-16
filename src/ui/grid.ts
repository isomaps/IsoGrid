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
import { GROUP_COLUMN_ID, GroupingModel, type DisplayRow } from '../core/grouping'
import { DETAIL_COLUMN_ID, DetailLayout, DetailModel } from '../core/detail'
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
import { GroupPanel } from './group-panel'
import { ContextMenu, type ContextMenuOptions } from './context-menu'
import { NS, el, getPath, renderIcon } from './dom'

const DEFAULTS = {
  rowHeight: 36,
  headerHeight: 40,
  blockSize: 100,
  maxBlocksInCache: 20,
  defaultColumnWidth: 160,
  selectionColumnWidth: 44,
  groupColumnWidth: 240,
  detailColumnWidth: 40,
  detailProvisionalHeight: 120,
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
  private grouping: GroupingModel<TRow>
  private details = new DetailModel()
  private detailLayout: DetailLayout
  /** Panneaux de détail montés, par index d'affichage. */
  private detailNodes = new Map<number, HTMLElement>()
  /** Hauteurs mesurées des panneaux, par identifiant de ligne. */
  private measuredHeights = new Map<string, number>()
  private detailObserver?: ResizeObserver
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
  private groupPanel?: GroupPanel
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
    this.grouping = new GroupingModel<TRow>({ defaultExpanded: options.groupDefaultExpanded })
    this.detailLayout = new DetailLayout(options.rowHeight ?? DEFAULTS.rowHeight)

    const initialGroups = options.initialState?.rowGroup ?? options.rowGroup ?? []
    if (initialGroups.length > 0) this.grouping.setGroupBy(initialGroups)

    this.columnModel = new ColumnModel({
      columns: options.columns as ColumnDef[],
      selectionColumn: options.rowSelection === 'multiple'
        ? { width: options.selectionColumnWidth ?? DEFAULTS.selectionColumnWidth }
        : false,
      groupColumn: this.grouping.isActive()
        ? { width: options.groupColumnWidth ?? DEFAULTS.groupColumnWidth }
        : false,
      groupedColumnIds: this.grouping.getGroupBy(),
      detailColumn: options.masterDetail
        ? { width: options.masterDetail.columnWidth ?? DEFAULTS.detailColumnWidth }
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

    if (this.options.groupPanel) {
      this.groupPanel = new GroupPanel(this.ctx, this.options.groupPanel === true ? true : 'whenGrouping')
      root.append(this.groupPanel.element)
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
  /* Lignes de détail                                                      */
  /* -------------------------------------------------------------------- */

  private isMasterRow(row: TRow, index: number): boolean {
    const md = this.options.masterDetail
    if (!md) return false
    return md.isRowMaster ? md.isRowMaster(row, index) : true
  }

  private isDetailOpenAt(index: number, row: TRow | undefined): boolean {
    if (!this.options.masterDetail || !row) return false
    return this.details.isOpen(this.rowId(row, index))
  }

  /**
   * Répercute l'état d'ouverture sur la couche de décalages.
   *
   * Les index d'affichage changent à chaque tri, filtre ou dépliage de groupe,
   * alors que l'ouverture est mémorisée par identifiant de ligne : il faut
   * donc les recalculer à chaque rendu, et non les mémoriser.
   */
  private syncDetailLayout(): void {
    this.detailLayout.reset()
    if (!this.options.masterDetail) return
    if (this.details.getOpen().length === 0) return

    const total = this.totalRowCount()
    const provisional = this.options.masterDetail.provisionalHeight
      ?? DEFAULTS.detailProvisionalHeight

    for (let i = 0; i < total; i++) {
      const display = this.displayRow(i)
      if (display?.kind !== 'leaf') continue
      if (!this.details.isOpen(this.rowId(display.row, i))) continue
      const measured = this.measuredHeights.get(this.rowId(display.row, i))
      this.detailLayout.set(i, measured ?? provisional)
    }
  }

  private mountDetailPanel(index: number, row: TRow, rowHeight: number): HTMLElement {
    const md = this.options.masterDetail!
    const rowId = this.rowId(row, index)

    const panel = el('div', {
      class: `${NS}-detail`,
      attrs: { role: 'row', 'data-detail-for': rowId },
      style: {
        // Le panneau démarre juste sous sa ligne maître.
        transform: `translateY(${this.detailLayout.offsetOf(index) + rowHeight}px)`,
      },
    })

    const inner = el('div', { class: `${NS}-detail-inner` })
    const content = md.renderer({
      row,
      rowIndex: index,
      invalidateHeight: () => this.remeasureDetail(rowId, inner),
    })
    if (typeof content === 'string') inner.innerHTML = content
    else inner.append(content)
    panel.append(inner)

    if ((md.height ?? 'auto') === 'auto') {
      // Deux mesures, pour deux moments distincts.
      //
      // 1. Tout de suite après l'insertion : un contenu déjà complet est
      //    mesuré au bon format dès le premier rendu, sans passer par une
      //    hauteur provisoire fausse pendant une frame.
      // 2. Ensuite, en continu : le contenu arrive souvent du réseau et
      //    change de taille après coup, ce que seule l'observation détecte.
      queueMicrotask(() => {
        if (this.destroyed || !inner.isConnected) return
        this.remeasureDetail(rowId, inner)
      })
      this.ensureDetailObserver()
      this.detailObserver?.observe(inner)
    } else {
      panel.style.height = `${md.height as number}px`
      this.measuredHeights.set(rowId, md.height as number)
    }

    this.detailNodes.set(index, panel)
    return panel
  }

  private ensureDetailObserver(): void {
    if (this.detailObserver || typeof ResizeObserver === 'undefined') return
    this.detailObserver = new ResizeObserver((entries) => {
      if (this.destroyed) return
      let changed = false
      for (const entry of entries) {
        const panel = (entry.target as HTMLElement).closest(`.${NS}-detail`) as HTMLElement | null
        const rowId = panel?.dataset.detailFor
        if (!rowId) continue
        const height = Math.ceil(entry.contentRect.height)
        if (height <= 0 || this.measuredHeights.get(rowId) === height) continue
        this.measuredHeights.set(rowId, height)
        changed = true
      }
      // Une seule relance de mise en page pour tout le lot : relancer par
      // panneau provoquerait autant de reflows.
      if (changed) this.relayoutDetails()
    })
  }

  private remeasureDetail(rowId: string, inner: HTMLElement): void {
    const height = Math.ceil(inner.getBoundingClientRect().height)
    if (height <= 0 || this.measuredHeights.get(rowId) === height) return
    this.measuredHeights.set(rowId, height)
    this.relayoutDetails()
  }

  /** Repositionne tout sans reconstruire : seules les hauteurs ont bougé. */
  private relayoutDetails(): void {
    const rowHeight = this.rowHeight()
    this.syncDetailLayout()
    this.bodyEl.style.height = `${this.detailLayout.totalHeight(this.totalRowCount())}px`
    for (const [index, node] of this.renderedRows) {
      node.style.transform = `translateY(${this.detailLayout.offsetOf(index)}px)`
    }
    for (const [index, panel] of this.detailNodes) {
      panel.style.transform = `translateY(${this.detailLayout.offsetOf(index) + rowHeight}px)`
    }
  }

  private buildDetailToggle(row: TRow, index: number): HTMLElement {
    const rowId = this.rowId(row, index)
    const open = this.details.isOpen(rowId)
    return el('button', {
      class: `${NS}-detail-toggle${open ? ` ${NS}-open` : ''}`,
      attrs: {
        type: 'button',
        'aria-expanded': String(open),
        'aria-label': this.t.t(open ? 'collapseGroup' : 'expandGroup'),
      },
      children: [renderIcon('chevron-right', this.options.renderIcon)],
      on: {
        click: (e: MouseEvent) => { e.stopPropagation(); this.toggleDetail(rowId) },
      },
    })
  }

  /* -------------------------------------------------------------------- */
  /* Groupage                                                              */
  /* -------------------------------------------------------------------- */

  /**
   * Reconstruit l'arbre de groupes.
   *
   * Le groupage exige l'ensemble des lignes : on les prend directement à la
   * source client, sans passer par le cache par blocs qui n'en détient qu'une
   * fenêtre.
   */
  private rebuildGroups(): void {
    if (!this.grouping.isActive()) return
    if (!this.clientSource) return
    const state = this.columnModel.getState()
    const rows = this.clientSource.getResolvedRows({
      sort: state.sort, filters: state.filters, quickFilter: state.quickFilter,
    })
    this.grouping.build(rows, this.columnModel.getAllDefs() as ColumnDef<TRow>[])
  }

  /** Nombre de lignes à représenter : groupes compris quand le groupage est actif. */
  private displayRowCount(): number {
    return this.grouping.isActive()
      ? this.grouping.getDisplayRowCount()
      : this.cache.getVirtualRowCount()
  }

  private displayRow(index: number): DisplayRow<TRow> | undefined {
    if (this.grouping.isActive()) return this.grouping.getDisplayRow(index)
    const row = this.cache.getRow(index)
    return row ? { kind: 'leaf', row, level: 0 } : undefined
  }

  /**
   * Applique un nouveau groupage.
   *
   * Le modèle de colonnes est reconstruit : la colonne d'arborescence doit
   * apparaître ou disparaître, et les colonnes groupées être masquées.
   */
  private applyRowGroup(columnIds: string[]): void {
    if (columnIds.length > 0 && !this.clientSource) {
      console.warn(
        '[IsoGrid] rowGroup est ignoré en mode serveur : le groupage exige '
        + "l'ensemble des lignes en mémoire.",
      )
      return
    }

    this.grouping.setGroupBy(columnIds)
    this.columnModel.setGroupingColumns(
      columnIds,
      columnIds.length > 0
        ? { width: this.options.groupColumnWidth ?? DEFAULTS.groupColumnWidth }
        : false,
    )
    this.rebuildGroups()
    this.selection.clear()
    this.render()
    this.emitState()
    this.options.onRowGroupChanged?.(columnIds, this)
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
    this.rebuildGroups()
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
    this.groupPanel?.render()
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

  /**
   * Fenêtre de lignes à matérialiser, marge comprise.
   *
   * Le passage par `DetailLayout` est ce qui permet aux panneaux de détail
   * d'avoir leur propre hauteur : sans lui, `scrollTop / rowHeight` désignerait
   * la mauvaise ligne dès qu'un panneau est ouvert au-dessus.
   */
  private visibleRange(): { start: number; end: number } {
    const rowHeight = this.rowHeight()
    const scrollTop = this.viewport.scrollTop
    const height = this.viewport.clientHeight || 400
    const total = this.totalRowCount()

    const at = this.detailLayout.indexAt(scrollTop, total)
    const first = Math.max(0, at - DEFAULTS.overscan)
    const visibleCount = Math.ceil(height / rowHeight) + DEFAULTS.overscan * 2
    return { start: first, end: Math.min(total, first + visibleCount) }
  }

  private totalRowCount(): number {
    return this.displayRowCount()
  }

  private refreshVisibleRange(): void {
    if (this.destroyed) return
    const { start, end } = this.visibleRange()
    this.cache.requestContext = this.buildRequestContext()
    // En groupage, les lignes viennent de l'arbre en mémoire : demander des
    // blocs au cache n'aurait aucun effet sur ce qui est affiché.
    if (!this.grouping.isActive()) this.cache.ensureRange(start, end)
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
    this.detailLayout.setRowHeight(rowHeight)
    this.syncDetailLayout()
    this.bodyEl.style.height = `${this.detailLayout.totalHeight(total)}px`

    const { start, end } = this.visibleRange()

    // Recyclage : on ne touche qu'aux lignes entrées ou sorties de la fenêtre.
    for (const [index, node] of this.renderedRows) {
      if (index < start || index >= end) {
        node.remove()
        this.renderedRows.delete(index)
        const panel = this.detailNodes.get(index)
        if (panel) { this.detailObserver?.unobserve(panel); panel.remove(); this.detailNodes.delete(index) }
      }
    }

    const columns = this.columnModel.getRenderColumns()
    for (let i = start; i < end; i++) {
      const existing = this.renderedRows.get(i)
      const display = this.displayRow(i)

      // Une ligne squelette est remplacée dès que sa donnée arrive.
      if (existing) {
        const wasSkeleton = existing.dataset.skeleton === '1'
        if (!wasSkeleton || !display) continue
        existing.remove()
        this.renderedRows.delete(i)
      }

      const node = display?.kind === 'group'
        ? this.buildGroupRow(i, display, columns, rowHeight)
        : this.buildRow(i, display?.row, columns, rowHeight, display?.level ?? 0)
      this.renderedRows.set(i, node)
      this.bodyEl.append(node)

      // Le panneau de détail est un nœud frère, positionné juste sous sa
      // ligne : l'inclure DANS la ligne obligerait celle-ci à changer de
      // hauteur, ce que le recyclage ne saurait pas défaire proprement.
      if (display?.kind === 'leaf' && this.isDetailOpenAt(i, display.row)) {
        this.bodyEl.append(this.mountDetailPanel(i, display.row, rowHeight))
      }
    }
  }

  private buildRow(
    index: number,
    row: TRow | undefined,
    columns: RenderColumn[],
    rowHeight: number,
    level = 0,
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
      style: {
        height: `${rowHeight}px`,
        transform: `translateY(${this.detailLayout.offsetOf(index)}px)`,
      },
    })
    if (!row) node.dataset.skeleton = '1'

    for (const column of columns) {
      node.append(this.buildCell(column, row, index, level))
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

  private buildCell(
    column: RenderColumn,
    row: TRow | undefined,
    rowIndex: number,
    level = 0,
  ): HTMLElement {
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

    if (column.id === DETAIL_COLUMN_ID) {
      if (row && this.isMasterRow(row, rowIndex)) {
        cell.append(this.buildDetailToggle(row, rowIndex))
      }
      return cell
    }

    // Sur une feuille, la colonne d'arborescence ne porte rien d'autre que le
    // décalage qui la rattache visuellement à son groupe.
    if (column.id === GROUP_COLUMN_ID) {
      cell.style.paddingLeft = `${12 + level * 18}px`
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

  /**
   * Ligne d'en-tête de groupe : chevron, libellé, effectif, puis les agrégats
   * dans leurs colonnes respectives.
   */
  private buildGroupRow(
    index: number,
    display: Extract<DisplayRow<TRow>, { kind: 'group' }>,
    columns: RenderColumn[],
    rowHeight: number,
  ): HTMLElement {
    const { node: group, expanded } = display

    const row = el('div', {
      class: `${NS}-row ${NS}-row-group ${NS}-row-group-l${Math.min(group.level, 4)}`,
      attrs: {
        role: 'row',
        'aria-rowindex': index + 1,
        'aria-expanded': String(expanded),
        'data-group-path': group.path,
      },
      style: {
        height: `${rowHeight}px`,
        transform: `translateY(${this.detailLayout.offsetOf(index)}px)`,
      },
    })

    for (const column of columns) {
      const cell = el('div', {
        class: [
          `${NS}-cell`,
          column.pinned ? `${NS}-pinned-${column.pinned}` : '',
          column.isLastPinnedStart ? `${NS}-pin-edge-start` : '',
          column.isFirstPinnedEnd ? `${NS}-pin-edge-end` : '',
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

      if (column.id === GROUP_COLUMN_ID) {
        cell.style.paddingLeft = `${8 + group.level * 18}px`
        cell.append(this.buildGroupToggle(group.path, expanded))
        cell.append(el('span', {
          class: `${NS}-group-label`,
          text: this.formatGroupKey(group.columnId, group.key),
        }))
        cell.append(el('span', { class: `${NS}-group-count`, text: `(${this.t.number(group.count)})` }))
      } else if (column.id === SELECTION_COLUMN_ID) {
        cell.append(this.buildGroupCheckbox(group))
      } else {
        const agg = group.aggregates[column.id]
        if (agg != null) {
          const def = column.def as ColumnDef<TRow>
          cell.classList.add(`${NS}-cell-agg`)
          if (!def.align && def.type === 'number') cell.classList.add(`${NS}-align-right`)
          cell.textContent = this.formatAggregate(def, agg)
        }
      }
      row.append(cell)
    }

    // Toute la ligne est cliquable : viser un chevron de 12 px est pénible.
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('input')) return
      this.toggleGroup(group.path)
    })

    return row
  }

  private buildGroupToggle(path: string, expanded: boolean): HTMLElement {
    return el('button', {
      class: `${NS}-group-toggle${expanded ? ` ${NS}-open` : ''}`,
      attrs: {
        type: 'button',
        'aria-label': this.t.t(expanded ? 'collapseGroup' : 'expandGroup'),
        'aria-expanded': String(expanded),
      },
      children: [renderIcon('chevron-right', this.options.renderIcon)],
      on: {
        click: (e: MouseEvent) => { e.stopPropagation(); this.toggleGroup(path) },
      },
    })
  }

  /** Case d'un groupe : coche ou décoche toutes ses feuilles d'un coup. */
  private buildGroupCheckbox(group: import('../core/grouping').GroupNode<TRow>): HTMLElement {
    const leaves = this.collectLeaves(group)
    const ids = leaves.map((r, i) => this.rowId(r, i))
    const selectedCount = ids.filter(id => this.selection.isSelected(id)).length
    const all = ids.length > 0 && selectedCount === ids.length

    const box = el('input', {
      class: `${NS}-select-box`,
      attrs: { type: 'checkbox', checked: all, 'aria-label': this.t.t('selectRow') },
      on: {
        click: (e: MouseEvent) => {
          e.stopPropagation()
          this.selection.selectRange(ids, !all)
        },
      },
    })
    box.indeterminate = selectedCount > 0 && !all
    return box
  }

  private collectLeaves(group: import('../core/grouping').GroupNode<TRow>): TRow[] {
    if (group.children.length === 0) return group.leaves
    return group.children.flatMap(c => this.collectLeaves(c))
  }

  private toggleGroup(path: string): void {
    this.grouping.toggle(path)
    this.renderedRows.clear()
    this.bodyEl.replaceChildren()
    this.renderBody()
    this.renderStatus()
    this.emitState()
  }

  /** Libellé d'un groupe : le formateur de la colonne s'applique. */
  private formatGroupKey(columnId: string, key: unknown): string {
    const def = this.columnModel.getDef(columnId) as ColumnDef<TRow> | undefined
    if (!def) return String(key ?? '')
    if (key == null || key === '') return this.t.t('blankValue')
    return this.formatValue(def, {
      value: key, row: {} as TRow, rowIndex: -1, column: def, grid: this,
    })
  }

  private formatAggregate(def: ColumnDef<TRow>, value: unknown): string {
    if (typeof value === 'number' && def.type === 'number') {
      // Les moyennes tombent rarement juste : deux décimales suffisent, mais
      // on n'en impose pas à une somme d'entiers.
      const decimals = Number.isInteger(value) ? 0 : 2
      return this.t.number(value, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    }
    return String(value ?? '')
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
    return {
      ...this.columnModel.getState(),
      rowGroup: this.grouping.getGroupBy(),
      expandedGroups: this.grouping.getExpanded(),
      openDetails: this.details.getOpen(),
    }
  }

  setState(state: Partial<GridState>): void {
    this.columnModel.setState(state)
    if (state.rowGroup) this.applyRowGroup(state.rowGroup)
    if (state.expandedGroups) {
      this.grouping.setExpanded(state.expandedGroups)
      this.render()
    }
    if (state.openDetails) {
      this.details.restore(state.openDetails)
      this.render()
    }
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
    this.rebuildGroups()
    this.groupPanel?.render()
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
    // En groupage, seules les feuilles des groupes dépliés sont à l'écran :
    // c'est ce que « copier » et « exporter ce qui est chargé » doivent voir.
    return this.grouping.isActive()
      ? this.grouping.getVisibleLeaves()
      : this.cache.getLoadedRows()
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

  /* --- groupage --- */

  getRowGroup(): string[] {
    return this.grouping.getGroupBy()
  }

  setRowGroup(columnIds: string[]): void {
    this.applyRowGroup(columnIds)
  }

  addRowGroup(columnId: string): void {
    const current = this.grouping.getGroupBy()
    if (current.includes(columnId)) return
    this.applyRowGroup([...current, columnId])
  }

  removeRowGroup(columnId: string): void {
    this.applyRowGroup(this.grouping.getGroupBy().filter(id => id !== columnId))
  }

  expandAllGroups(): void {
    this.grouping.expandAll()
    this.render()
  }

  collapseAllGroups(): void {
    this.grouping.collapseAll()
    this.render()
  }

  /* --- détail --- */

  toggleDetail(rowId: string): void {
    if (!this.options.masterDetail) return
    this.details.toggle(rowId)
    this.renderedRows.clear()
    this.detailNodes.clear()
    this.bodyEl.replaceChildren()
    this.renderBody()
    this.emitState()
  }

  isDetailOpen(rowId: string): boolean {
    return this.details.isOpen(rowId)
  }

  closeAllDetails(): void {
    this.details.closeAll()
    this.render()
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
    this.detailObserver?.disconnect()
    this.resizeObserver?.disconnect()
    this.themeMediaQuery?.removeEventListener('change', this.onSystemTheme)
    this.cache.destroy()
    this.columnModel.destroy()
    this.root.remove()
  }
}
