import type {
  AnyRow, CellContext, ColumnDef, Datasource, ExportOptions, ExportProgress,
  GridState, IconName, IsoGridApi, IsoGridOptions, LocaleCode, PinPosition,
  SectionInfo, SetFilterOption, SortModel, ThemeMode,
} from '../core/types'
import { ColumnModel, type RenderColumn } from '../core/table'
import {
  SELECTION_COLUMN_ID, SelectionModel,
  type SelectionSnapshot, type SelectionState,
} from '../core/selection'
import { GROUP_COLUMN_ID, GroupingModel, type DisplayRow } from '../core/grouping'
import { DETAIL_COLUMN_ID, ROW_ACTIONS_COLUMN_ID, DetailLayout, DetailModel } from '../core/detail'
import { Translator, resolveLocale } from '../core/i18n'
import { BlockCache, createHttpDatasource } from '../datasource/server'
import { ClientDatasource } from '../datasource/client'
import { normalizeFilter } from '../filters/model'
import { collectExportData, rawCellValue } from '../export/collect'
import { exportToCsv } from '../export/csv'
import { exportToExcel } from '../export/excel'
import type { GridContext } from './context'
import { HeaderRenderer } from './header'
import { FooterRenderer } from './footer'
import { ToastHost, type ToastOptions } from './toast'
import { Sidebar } from './sidebar'
import { Toolbar } from './toolbar'
import { GroupPanel } from './group-panel'
import { ContextMenu, type ContextMenuOptions } from './context-menu'
import { NS, debounce, el, getPath, renderIcon, setPath } from './dom'
import { isPromiseLike } from '../core/state-store'
import {
  type CellEditor, createDefaultEditor, isCellEditable, parseEditedValue,
} from '../core/editing'
import { DEFAULTS } from '../core/defaults'


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
  /** Cellule en cours d'édition. Une seule à la fois. */
  private edition: {
    cell: HTMLElement
    editor: CellEditor
    ctx: CellContext<TRow>
    rowId: string
    /** Évite qu'une validation par Entrée et le flou consécutif s'appliquent deux fois. */
    close: boolean
  } | null = null
  private ctx: GridContext

  /* --- DOM --- */
  private root: HTMLElement
  private viewport!: HTMLElement
  private bodyEl!: HTMLElement
  private overlay!: HTMLElement
  private statusEl?: HTMLElement
  private headerRenderer: HeaderRenderer
  private footerRenderer?: FooterRenderer
  private toastHost!: ToastHost
  private toolbar?: Toolbar
  private sidebar?: Sidebar
  private groupPanel?: GroupPanel
  private contextMenu?: ContextMenu
  /** Menu des actions de ligne — instance dédiée, pour ne pas fermer le menu contextuel. */
  private rowActionsMenu!: ContextMenu

  /* --- état de rendu --- */
  private renderedRows = new Map<number, HTMLElement>()
  private scrollFrame = 0
  private destroyed = false
  /** Vrai entre le clic et le relâchement d'une poignée de redimensionnement. */
  private resizingColumns = false
  private lastDataSignature = ''
  private lastFilterSignature = ''
  private warnedRowIds = false
  private lastError: unknown = null
  private themeMediaQuery?: MediaQueryList
  private resizeObserver?: ResizeObserver
  /** Plein écran (bascule CSS, cf. `toggleFullscreen`) — jamais persisté dans `GridState`. */
  private isFs = false
  /** Rappel d'etirement, garde pour pouvoir le retirer au demontage. */
  private surRedimensionnementFenetre?: () => void

  /* --- sections (intertitres) --- */
  /** Frontieres et totaux fournis par la source, pour tout le jeu filtre. */
  private sections: SectionInfo[] = []
  /** Index de premiere ligne de chaque section => la section. */
  private sectionStarts = new Map<number, SectionInfo>()
  /** Bandeaux materialises, recycles comme les lignes. */
  private sectionNodes = new Map<number, HTMLElement>()
  /** Signature des filtres pour lesquels `sections` a ete obtenu. */
  private sectionsSignature: string | null = null

  /* --- persistance de l'état côté hôte --- */
  /** Vrai tant que l'état persisté n'est pas arrivé : rien n'est encore chargé. */
  private stateLoading = false
  /** Vrai pendant l'application de l'état relu : on ne le renvoie pas à l'hôte. */
  private restoringState = false
  private saveStateSoon?: (() => void) & { cancel(): void }
  /** Un enregistrement est demandé mais pas encore parti. */
  private savePending = false
  /** Un enregistrement est en cours : le suivant attend son tour. */
  private saveInFlight = false
  private saveAgain = false
  private stateStoreWarned = false

  constructor(container: HTMLElement, options: IsoGridOptions<TRow>) {
    this.options = options
    this.t = new Translator(resolveLocale(options.locale), options.messages)

    this.selection = new SelectionModel(() => this.onSelectionChange())
    this.grouping = new GroupingModel<TRow>({ defaultExpanded: options.groupDefaultExpanded })
    this.detailLayout = new DetailLayout(options.rowHeight ?? DEFAULTS.rowHeight)

    // L'état persisté est relu AVANT toute construction. S'il arrive tout de
    // suite (localStorage, cache mémoire), il se fond dans `initialState` et
    // la grille se monte d'emblée dans les réglages de l'utilisateur. S'il est
    // asynchrone, `attente` porte la promesse et le premier chargement de
    // données est repoussé jusqu'à son arrivée — la grille ne se dessine
    // qu'une fois, au lieu de s'afficher puis de se réafficher autrement.
    const attente = this.loadPersistedState()

    const initialGroups = options.initialState?.rowGroup ?? options.rowGroup ?? []
    if (initialGroups.length > 0) this.grouping.setGroupBy(initialGroups)

    this.columnModel = new ColumnModel({
      columns: options.columns as ColumnDef[],
      selectionColumn: options.rowSelection === 'multiple' && options.selectionColumn !== false
        ? { width: options.selectionColumnWidth ?? DEFAULTS.selectionColumnWidth }
        : false,
      groupColumn: this.grouping.isActive()
        ? { width: options.groupColumnWidth ?? DEFAULTS.groupColumnWidth }
        : false,
      groupedColumnIds: this.grouping.getGroupBy(),
      detailColumn: options.masterDetail
        ? { width: options.masterDetail.columnWidth ?? DEFAULTS.detailColumnWidth }
        : false,
      actionsColumn: options.rowActions
        ? { width: options.rowActions.width ?? DEFAULTS.rowActionsWidth }
        : false,
      defaultColumn: options.defaultColumn as Partial<ColumnDef>,
      defaultColumnWidth: options.defaultColumnWidth ?? DEFAULTS.defaultColumnWidth,
      fillWidth: options.fillWidth !== false,
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
      toast: (message: string, options?: ToastOptions) => this.toastHost.show(message, options),
      portal: () => {
        const racine = this.root.getRootNode()
        return racine instanceof ShadowRoot ? racine : document.body
      },
      requestRender: () => this.render(),
      reload: () => this.reload(),
      emitState: () => this.emitState(),
      beginColumnResize: () => { this.resizingColumns = true },
      endColumnResize: () => {
        this.resizingColumns = false
        this.render()
        this.emitState()
      },
      fetchSetValues: (columnId) => this.fetchSetValues(columnId),
      selectAllCheckbox: options.rowSelection === 'multiple'
        ? () => this.buildSelectAllCheckbox()
        : undefined,
    }

    this.toastHost = new ToastHost(
      () => this.ctx.portal(),
      (name) => this.ctx.icon(name),
    )
    this.headerRenderer = new HeaderRenderer(this.ctx)
    this.rowActionsMenu = new ContextMenu(this.ctx, {})
    if (options.contextMenu !== false) {
      this.contextMenu = new ContextMenu(this.ctx, (options.contextMenu ?? {}) as ContextMenuOptions)
    }
    this.root = this.buildLayout(container)

    this.lastDataSignature = this.dataSignature()
    this.lastFilterSignature = this.filterSignature()
    this.applyTheme(options.theme ?? 'auto')
    this.columnModel.setAvailableWidth(this.usableWidth())
    this.render()
    if (attente) void this.awaitPersistedState(attente)
    else this.refreshVisibleRange()

    // Un seul écouteur global, posé une fois — pas seulement quand le bouton
    // est actif : `toggleFullscreen()` reste appelable par programme même sans
    // `toolbar.fullscreenButton`, et Échap doit alors marcher aussi.
    document.addEventListener('keydown', this.onKeyDown)

    this.installerAutoHeight(container)

    // Les intertitres dépendent des filtres : s'ils sont encore attendus du
    // dépôt d'état, on les demandera une fois l'état appliqué.
    if (this.options.sections && !this.stateLoading) void this.fetchSections()
  }

  /**
   * Étire le conteneur jusqu'au bas de la fenêtre (option `autoHeight`).
   *
   * C'est le CONTENEUR qu'on dimensionne, pas la racine de la grille : celle-ci
   * remplit son parent, et l'hôte garde la main sur les marges autour.
   *
   * Le `ResizeObserver` déjà posé sur le viewport recalcule seul les lignes
   * visibles ; il n'y a donc rien à rafraîchir ici. Un second appel au cadre
   * suivant rattrape les pages dont la hauteur bouge après le montage (barre
   * d'actions, bandeau de filtres, polices).
   */
  private installerAutoHeight(container: HTMLElement): void {
    if (!this.options.autoHeight) return

    const plancher = this.options.autoHeightMin ?? 320
    const marge = this.options.autoHeightGap ?? 24

    const etirer = (): void => {
      if (this.destroyed || this.isFs) return
      const haut = container.getBoundingClientRect().top + window.scrollY
      const dispo = window.innerHeight - haut + window.scrollY - marge
      container.style.height = `${Math.max(plancher, Math.round(dispo))}px`
    }

    etirer()
    requestAnimationFrame(etirer)
    this.surRedimensionnementFenetre = etirer
    window.addEventListener('resize', etirer)
  }

  /* -------------------------------------------------------------------- */
  /* Persistance de l'état côté hôte                                       */
  /* -------------------------------------------------------------------- */

  /**
   * Demande l'état au dépôt de l'hôte.
   *
   * Réponse immédiate : elle est fusionnée dans `initialState` et rien d'autre
   * ne se passe. Promesse : elle est rendue à l'appelant, qui l'attendra une
   * fois le DOM monté. Un dépôt qui lève n'arrête pas le montage.
   */
  private loadPersistedState(): Promise<Partial<GridState> | null | undefined> | null {
    const store = this.options.stateStore
    if (!store?.load) return null

    let out: ReturnType<NonNullable<typeof store.load>>
    try {
      out = store.load()
    } catch (error) {
      this.onStateStoreError(error, 'load')
      return null
    }

    if (isPromiseLike<Partial<GridState> | null | undefined>(out)) {
      this.stateLoading = true
      return Promise.resolve(out)
    }
    if (out) this.options.initialState = { ...this.options.initialState, ...out }
    return null
  }

  /**
   * Applique l'état qui arrive après coup, sans faire clignoter la grille.
   *
   * Tant qu'il n'est pas là, aucune ligne n'est demandée : les charger avec le
   * mauvais tri pour les recharger aussitôt ferait un aller-retour visible, et
   * deux requêtes au serveur. Un délai de garde évite qu'un dépôt muet laisse
   * la grille en attente pour toujours ; si l'état finit par arriver, il est
   * appliqué quand même.
   */
  private async awaitPersistedState(
    attente: Promise<Partial<GridState> | null | undefined>,
  ): Promise<void> {
    let demarre = false
    const demarrer = (): void => {
      if (demarre || this.destroyed) return
      demarre = true
      this.stateLoading = false
      this.render()
      this.refreshVisibleRange()
      if (this.options.sections) void this.fetchSections()
    }

    const delai = this.options.stateStore?.loadTimeout ?? DEFAULTS.stateLoadTimeout
    const garde = setTimeout(demarrer, delai)

    let state: Partial<GridState> | null | undefined
    try {
      state = await attente
    } catch (error) {
      this.onStateStoreError(error, 'load')
    }
    clearTimeout(garde)
    if (this.destroyed) return

    if (state) this.applyRestoredState(state)
    demarrer()
  }

  /** Pose l'état relu sans le réenregistrer aussitôt : l'hôte nous l'a donné. */
  private applyRestoredState(state: Partial<GridState>): void {
    this.restoringState = true
    try {
      this.setState(state)
    } finally {
      this.restoringState = false
    }
  }

  /**
   * Enregistre l'état, une fois les changements rapprochés regroupés.
   *
   * Redimensionner une colonne ou taper dans un filtre produit des dizaines de
   * changements par seconde : sans regroupement, autant d'écritures. Et deux
   * enregistrements ne se croisent jamais — le second attend la fin du premier
   * pour partir, sans quoi une réponse en retard écraserait l'état le plus
   * récent.
   */
  private persistState(): void {
    const store = this.options.stateStore
    if (!store?.save) return
    // L'état enregistré n'a pas encore été relu : l'écraser maintenant avec
    // celui par défaut effacerait les préférences qu'on est en train d'attendre.
    if (this.stateLoading) return
    this.saveStateSoon ??= debounce(
      () => this.pushState(),
      store.debounce ?? DEFAULTS.stateSaveDebounce,
    )
    this.savePending = true
    this.saveStateSoon()
  }

  private pushState(): void {
    const store = this.options.stateStore
    if (!store?.save) return
    if (this.saveInFlight) { this.saveAgain = true; return }
    this.savePending = false

    let out: void | Promise<void>
    try {
      out = store.save(this.getState())
    } catch (error) {
      this.onStateStoreError(error, 'save')
      return
    }
    if (!isPromiseLike<void>(out)) return

    this.saveInFlight = true
    Promise.resolve(out)
      .catch((error: unknown) => this.onStateStoreError(error, 'save'))
      .then(() => {
        this.saveInFlight = false
        if (!this.saveAgain) return
        this.saveAgain = false
        this.pushState()
      })
  }

  /**
   * Une préférence d'affichage qui ne s'enregistre pas ne doit jamais empêcher
   * de travailler : on prévient l'hôte, ou on se contente d'un avertissement —
   * une seule fois, pour ne pas noyer la console quand le réseau est coupé.
   */
  private onStateStoreError(error: unknown, phase: 'load' | 'save'): void {
    const store = this.options.stateStore
    if (store?.onError) { store.onError(error, phase); return }
    if (this.stateStoreWarned) return
    this.stateStoreWarned = true
    const quoi = phase === 'load' ? 'relues' : 'enregistrées'
    console.warn(`[IsoGrid] les préférences d'affichage n'ont pas pu être ${quoi}.`, error)
  }

  /** Largeur utile pour les colonnes — même marge que `sizeColumnsToFit()`. */
  private usableWidth(): number {
    return this.viewport ? Math.max(0, this.viewport.clientWidth - 2) : 0
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
    if (this.options.borderless) root.classList.add(`${NS}-borderless`)
    if (this.options.showHeader === false) root.classList.add(`${NS}-headerless`)

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

    const enfantsViewport: HTMLElement[] = [this.headerRenderer.element, this.bodyEl]
    if (this.options.footer) {
      this.footerRenderer = new FooterRenderer(this.t)
      /* Dans le viewport, donc solidaire du défilement horizontal, et collé en
         bas par le CSS : les totaux restent sous leur colonne. */
      enfantsViewport.push(this.footerRenderer.element)
    }

    this.viewport = el('div', {
      class: `${NS}-viewport`,
      attrs: { tabindex: 0 },
      children: enfantsViewport,
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
    // La LARGEUR aussi compte désormais : les colonnes s'étirent sur l'espace
    // disponible (option `fillWidth`) — y compris quand la grille était masquée
    // à la construction et devient visible.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.columnModel.setAvailableWidth(this.usableWidth())) {
          this.headerRenderer.render()
          this.applyColumnGeometry()
        }
        this.refreshVisibleRange()
      })
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
    this.applySectionLayout()
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
    const hauteurSection = this.sectionHeight()
    for (const [index, bandeau] of this.sectionNodes) {
      bandeau.style.transform = `translateY(${this.detailLayout.offsetOf(index) - hauteurSection}px)`
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

  /**
   * Le clic sur la ligne sélectionne-t-il ?
   *
   * Oui si l'hôte l'a demandé, et TOUJOURS quand la colonne de cases est
   * retirée : c'est alors le seul moyen de sélectionner.
   */
  private selectionParLigne(): boolean {
    if (this.options.selectOnRowClick != null) return this.options.selectOnRowClick
    /*
     * Pas de colonne de cases à cocher — soit qu'on l'ait retirée, soit que le
     * mode `single` n'en ait jamais : le clic sur la ligne est alors le SEUL
     * geste qui reste pour choisir. Sans cette bascule, la sélection serait
     * déclarée et inatteignable, et les actions de masse inertes sans que rien
     * ne le signale.
     */
    return this.options.selectionColumn === false || this.options.rowSelection === 'single'
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
    this.renderFooter()
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

    // Redimensionnement en cours : seule la géométrie bouge. On la réapplique
    // aux cellules déjà là plutôt que de tout reconstruire — reconstruire
    // détruirait la poignée que l'utilisateur tient, et le geste s'arrêterait
    // au premier pixel. L'état n'est émis qu'au relâchement, pas à chaque
    // pixel parcouru.
    if (this.resizingColumns) {
      this.applyColumnGeometry()
      return
    }

    // Changer un filtre change l'ensemble des lignes : en mode `exclude`,
    // « tout sauf ces trois-là » désignerait alors silencieusement d'autres
    // lignes. Un tri, lui, ne fait que réordonner — la sélection reste juste.
    const filterSignature = this.filterSignature()
    const filtresChanges = filterSignature !== this.lastFilterSignature
    if (filtresChanges) {
      this.lastFilterSignature = filterSignature
      this.selection.clear()
      this.lastSelectedIndex = null
    }

    const signature = this.dataSignature()
    if (signature !== this.lastDataSignature) {
      this.lastDataSignature = signature
      // Un TRI seul ne touche pas aux intertitres : la colonne de decoupage
      // est fixe et la source ordonne par elle en premier, donc les
      // effectifs et l'ordre des sections restent identiques. Les redemander
      // coutait une requete a chaque clic sur un en-tete.
      this.reload({ gardeSections: !filtresChanges })
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
    this.renderFooter()
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
    this.sectionNodes.clear()
    this.bodyEl.replaceChildren()
    this.renderBody()
    this.groupPanel?.render()
    this.sidebar?.render()
    this.toolbar?.syncQuickFilter()
    this.toolbar?.syncFilterCount()
    this.renderStatus()
    this.renderFooter()
    this.renderOverlay()
  }

  /**
   * Réapplique largeurs et décalages collants aux cellules DÉJÀ rendues.
   *
   * Le modèle de colonnes reste la source de vérité : il a déjà recalculé les
   * `stickyOffset`, on ne fait que les recopier dans le DOM. C'est ce qui
   * permet de redimensionner une colonne épinglée sans que les suivantes se
   * décalent de travers.
   *
   * L'en-tête de la colonne de sélection ne porte pas de `data-col-id` et
   * n'est donc pas visité — sans conséquence : elle est en première position,
   * son décalage vaut toujours zéro, et elle n'est pas redimensionnable.
   */
  private applyColumnGeometry(): void {
    for (const column of this.columnModel.getRenderColumns()) {
      const selector = `[data-col-id="${CSS.escape(column.id)}"]`
      for (const cell of Array.from(this.root.querySelectorAll<HTMLElement>(selector))) {
        cell.style.width = `${column.width}px`
        if (!column.pinned) continue
        if (column.pinned === 'start') cell.style.left = `${column.stickyOffset}px`
        else cell.style.right = `${column.stickyOffset}px`
      }
    }
    this.syncWidths()
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

  /* -------------------------------------------------------------------- */
  /* Sections                                                              */
  /* -------------------------------------------------------------------- */

  /**
   * Demande les frontieres de sections a la source.
   *
   * Les frontieres viennent de la source et non des lignes chargees : une
   * section chevauche souvent deux blocs, et son total calcule sur le seul
   * bloc visible serait faux. Une requete par changement de filtre suffit —
   * le tri ne deplace pas les frontieres, puisque la colonne de decoupage est
   * fixe et que la source ordonne par elle en premier.
   */
  private async fetchSections(): Promise<void> {
    if (!this.options.sections) return
    const source = this.resolveDatasource()
    if (!source.getSections) return

    const signature = this.filterSignature()
    if (this.sectionsSignature === signature && this.sections.length > 0) return

    const context = this.buildRequestContext()
    try {
      const sections = await source.getSections({
        sort: context.sort,
        filters: context.filters,
        quickFilter: context.quickFilter,
        columns: context.columns,
      })
      if (this.destroyed) return
      this.sectionsSignature = signature
      this.sections = Array.isArray(sections) ? sections : []
    } catch (error) {
      // Mieux vaut aucun intertitre qu'un intertitre au mauvais endroit : on
      // n'invente pas de frontieres, et la grille reste utilisable.
      this.sections = []
      this.sectionsSignature = null
      if (this.options.onError) this.options.onError(error)
      else console.error('[IsoGrid] sections', error)
    }
    this.renderBody()
    // Les lignes deja materialisees portent un decalage calcule SANS les
    // intertitres — elles resteraient a leur place et le bandeau leur
    // passerait dessus. `relayoutDetails` les repositionne toutes, panneaux
    // et bandeaux compris, sans les reconstruire.
    this.relayoutDetails()
  }

  /**
   * Traduit les effectifs de sections en frontieres d'index, et reserve la
   * hauteur des bandeaux dans la couche de decalages.
   */
  private applySectionLayout(): void {
    this.sectionStarts.clear()
    const cfg = this.options.sections
    if (!cfg || this.sections.length === 0) return
    // Groupage et sections decoupent tous deux le corps : les cumuler
    // donnerait deux hierarchies concurrentes, illisibles.
    if (this.grouping.isActive()) return

    const height = cfg.height ?? Math.round(this.rowHeight() * 1.6)
    const total = this.totalRowCount()
    let index = 0
    for (const section of this.sections) {
      if (index >= total) break
      this.sectionStarts.set(index, section)
      this.detailLayout.setBefore(index, height)
      index += Math.max(0, Math.round(section.count))
    }
  }

  private sectionHeight(): number {
    const cfg = this.options.sections
    return cfg?.height ?? Math.round(this.rowHeight() * 1.6)
  }

  /**
   * Bandeau d'une section : intitule a gauche, totaux a droite, filet epais
   * dessous.
   *
   * Le bandeau occupe toute la largeur de defilement, mais son contenu est
   * cale sur la fenetre (`position: sticky`) : un intitule qui part hors de
   * l'ecran des qu'on fait defiler horizontalement ne sert a rien, et c'est
   * precisement quand on parcourt les colonnes de droite qu'on a besoin de
   * savoir dans quel mois on se trouve.
   */
  private buildSectionHeader(index: number, section: SectionInfo): HTMLElement {
    const cfg = this.options.sections!
    const hauteur = this.sectionHeight()

    const intitule = cfg.label
      ? cfg.label(section)
      : (section.label ?? this.formatGroupKey(cfg.column, section.value))

    const gauche = el('div', {
      class: `${NS}-section-title`,
      children: [
        el('span', { text: intitule }),
        el('span', { class: `${NS}-section-count`, text: `(${this.t.number(section.count)})` }),
      ],
    })

    const droite = el('div', { class: `${NS}-section-totals` })
    for (const columnId of cfg.totals ?? []) {
      const valeur = section.totals?.[columnId]
      if (valeur == null) continue
      const def = this.columnModel.getDef(columnId) as ColumnDef<TRow> | undefined
      droite.append(el('span', {
        class: `${NS}-section-total`,
        children: [
          el('span', { class: `${NS}-section-total-label`, text: def?.header ?? columnId }),
          el('span', {
            class: `${NS}-section-total-value`,
            // Un total par devise s'écrit « CHF 1 234,56 · EUR 5 678,90 » :
            // chaque montant avec son unité, jamais additionnés entre eux.
            text: typeof valeur === 'object'
              ? Object.entries(valeur)
                .map(([cle, v]) => `${cle} ${def ? this.formatAggregate(def, v) : String(v)}`)
                .join(' · ')
              : (def ? this.formatAggregate(def, valeur) : String(valeur)),
          }),
        ],
      }))
    }

    const interieur = el('div', {
      class: `${NS}-section-inner`,
      children: [gauche, droite],
      style: { width: `${this.viewport.clientWidth}px` },
    })

    return el('div', {
      class: `${NS}-section`,
      attrs: { role: 'row', 'data-section-for': String(index) },
      style: {
        height: `${hauteur}px`,
        transform: `translateY(${this.detailLayout.offsetOf(index) - hauteur}px)`,
      },
      children: [interieur],
    })
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

    for (const [index, bandeau] of this.sectionNodes) {
      if (index < start || index >= end || !this.sectionStarts.has(index)) {
        bandeau.remove()
        this.sectionNodes.delete(index)
      } else {
        // La largeur de la fenetre a pu changer depuis la construction.
        const interieur = bandeau.firstElementChild as HTMLElement | null
        if (interieur) interieur.style.width = `${this.viewport.clientWidth}px`
      }
    }

    const columns = this.columnModel.getRenderColumns()
    for (let i = start; i < end; i++) {
      const existing = this.renderedRows.get(i)
      const display = this.displayRow(i)

      // AVANT le `continue` ci-dessous : les intertitres arrivent après les
      // lignes (une requête de plus), donc au moment où ils sont posés les
      // lignes sont déjà rendues. Placé plus bas, ce bloc n'était jamais
      // atteint et aucun bandeau n'apparaissait.
      const section = this.sectionStarts.get(i)
      if (section && !this.sectionNodes.has(i)) {
        const bandeau = this.buildSectionHeader(i, section)
        this.sectionNodes.set(i, bandeau)
        this.bodyEl.append(bandeau)
      }

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

  /**
   * Redessine la ligne de totaux.
   *
   * Volontairement PAS appelée depuis `renderBody` : celui-ci s'exécute à
   * chaque frame de défilement, alors que les totaux ne dépendent que du jeu
   * de données, du filtre et de la sélection. Les recalculer au scroll faisait
   * tourner la page en boucle.
   */
  private renderFooter(): void {
    if (!this.footerRenderer) return
    const columns = this.columnModel.getRenderColumns()
    const opts = this.options.footer === true ? {} : (this.options.footer || {})

    const selection = this.isSelectionEnabled() ? this.getSelectedRows() : []
    const surSelection = (opts.useSelection ?? true) && selection.length > 0
    const lignes = surSelection ? selection : this.getLoadedRows()

    // Priorité : la fonction de l'hôte, puis les totaux renvoyés par la source
    // (tout le jeu filtré), et seulement en dernier recours le calcul local.
    // Sur une sélection, le calcul local est juste : les lignes sont chargées.
    const fournies = opts.values
      ? opts.values({ rows: lignes, onSelection: surSelection, rowCount: this.getDisplayedRowCount() })
      : (surSelection ? null : this.cache.getFooter())

    this.footerRenderer.render(columns, lignes, fournies, surSelection)
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
        /* Ce que l'hôte veut marquer : un statut, une alerte, une couleur
           métier. Ajouté après les classes de la grille, jamais à leur place. */
        ...(row ? this.classesHote(row, index) : []),
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
    /* L'édition retrouve sa cellule par ces deux repères : c'est ce qui permet
       de rouvrir un éditeur après un re-rendu, ou depuis l'API. */
    node.dataset.rowIndex = String(index)
    if (row) node.dataset.rowId = this.rowId(row, index)

    for (const column of columns) {
      node.append(this.buildCell(column, row, index, level))
    }

    if (row) {
      if (this.isSelectionEnabled() && this.selectionParLigne()) {
        node.addEventListener('click', (e) => this.applySelectionClick(row, index, e.shiftKey))
      }
      if (this.options.onRowClick) {
        node.style.cursor = 'pointer'
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

    if (column.id === ROW_ACTIONS_COLUMN_ID) {
      if (row) {
        const items = this.options.rowActions!.items(row, rowIndex)
        // Aucune action possible sur cette ligne : pas de bouton mort.
        if (items.length > 0) cell.append(this.buildRowActionsButton(items))
      }
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

    /* L'édition se monte sur la cellule et non sur la ligne : c'est le seul
       niveau qui sait de quelle colonne il s'agit. */
    if (this.options.editing && isCellEditable(def, ctx)) {
      cell.classList.add(`${NS}-cell-editable`)
      const geste = this.options.editing.startOn ?? 'dblclick'
      if (geste !== 'none') {
        cell.addEventListener(geste === 'click' ? 'click' : 'dblclick', () => {
          this.startEditingCell(this.rowId(row, rowIndex), def.id)
        })
      }
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
      // on n'en impose pas à une somme d'entiers — sauf si la colonne a fixé
      // son propre nombre de décimales, auquel cas le total doit s'aligner
      // sur ses cellules.
      const decimals = def.decimals ?? (Number.isInteger(value) ? 0 : 2)
      return this.t.number(value, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    }
    return String(value ?? '')
  }

  /** Bouton « ⋮ » ouvrant le menu d'actions de la ligne. */
  private buildRowActionsButton(items: import('./context-menu').ContextMenuItem[]): HTMLElement {
    return el('button', {
      class: `${NS}-icon-btn ${NS}-row-actions-btn`,
      attrs: {
        type: 'button',
        'aria-haspopup': 'menu',
        'aria-label': this.t.t('rowActions'),
        title: this.t.t('rowActions'),
      },
      children: [renderIcon('menu', this.options.renderIcon)],
      on: {
        click: (e: MouseEvent) => {
          e.stopPropagation()
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
          // Ancré sous le bouton plutôt qu'au curseur : le menu doit s'ouvrir
          // au même endroit qu'on clique à la souris ou au clavier.
          this.rowActionsMenu.openItems(items, rect.left, rect.bottom + 2)
        },
      },
    })
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
  /** Classes posées par l'hôte sur une ligne — voir `getRowClass`. */
  private classesHote(row: TRow, index: number): string[] {
    const f = this.options.getRowClass
    if (!f) return []
    try {
      const c = f(row, index)
      if (!c) return []
      return (Array.isArray(c) ? c : [c]).filter(Boolean)
    } catch {
      /* Une classe est de l'ornement : si l'hôte se trompe, la ligne s'affiche
         quand même. */
      return []
    }
  }

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
      if (Number.isNaN(n)) return String(value)
      return def.decimals === undefined
        ? this.t.number(n)
        : this.t.number(n, { minimumFractionDigits: def.decimals, maximumFractionDigits: def.decimals })
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

    // Les préférences arrivent encore : rien n'a été demandé au serveur, donc
    // « Aucune ligne » serait faux. On annonce un chargement.
    if (this.stateLoading) {
      this.overlay.className = `${NS}-overlay ${NS}-visible`
      this.overlay.append(el('div', {
        class: `${NS}-overlay-box`,
        children: [this.ctx.icon('spinner'), el('span', { text: this.t.t('loading') })],
      }))
      return
    }

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

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.isFs && e.key === 'Escape') {
      e.preventDefault()
      this.toggleFullscreen()
    }
  }

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
    // Pendant la restauration, l'état vient de l'hôte : le lui renvoyer ferait
    // un aller-retour inutile, et un enregistrement pour rien.
    if (this.restoringState) return
    this.options.onStateChange?.(this.getState())
    this.persistState()
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
    const available = this.usableWidth()
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

  /* ------------------------------------------------------------------ */
  /* Édition de cellule                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Ouvre l'édition d'une cellule.
   *
   * Sans effet si l'édition est désactivée, si la colonne refuse cette ligne,
   * ou si la ligne n'est pas chargée — en mode serveur, on n'édite que ce qui
   * est à l'écran.
   */
  /** Affiche une confirmation brève en bas de la grille. */
  toast(message: string, options?: ToastOptions): void {
    this.toastHost.show(message, options)
  }

  startEditingCell(rowId: string, columnId: string): void {
    if (!this.options.editing) return
    this.stopEditing()

    const cell = this.bodyEl.querySelector<HTMLElement>(
      `[data-row-id="${CSS.escape(rowId)}"] [data-col-id="${CSS.escape(columnId)}"]`,
    )
    if (!cell) return

    const def = this.columnModel.getDef(columnId)
    if (!def) return

    const rowIndex = Number(cell.closest(`.${NS}-row`)?.getAttribute('data-row-index') ?? -1)
    const row = this.cache.getRow(rowIndex) ?? this.getLoadedRows()[rowIndex]
    if (!row) return

    const value = getPath(row, def.field ?? def.id)
    const ctx: CellContext<TRow> = { value, row, rowIndex, column: def as ColumnDef<TRow>, grid: this }
    if (!isCellEditable(def as ColumnDef<TRow>, ctx)) return

    const fabrique = (def as ColumnDef<TRow>).cellEditor ?? createDefaultEditor
    const editor = fabrique(ctx)

    cell.classList.add(`${NS}-cell-editing`)
    cell.textContent = ''
    cell.append(editor.element)
    this.edition = { cell, editor, ctx, rowId, close: false }

    editor.element.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.stopEditing(true) }
      else if (e.key === 'Enter') { e.preventDefault(); void this.commitEdit(true) }
      else if (e.key === 'Tab') { e.preventDefault(); void this.commitEdit(false, e.shiftKey ? -1 : 1) }
    })
    /* Un clic ailleurs vaut validation : c'est ce que fait un tableur, et
       c'est moins déroutant que de perdre la saisie. */
    editor.element.addEventListener('blur', () => { if (!this.edition?.close) void this.commitEdit(false) })

    editor.focus()
  }

  /** Ferme l'édition en cours. `annuler` jette la saisie. */
  stopEditing(annuler = false): void {
    const e = this.edition
    if (!e) return
    e.close = true
    this.edition = null
    e.editor.destroy?.()
    e.cell.classList.remove(`${NS}-cell-editing`, `${NS}-cell-saving`)
    /* Remettre l'affichage : la valeur n'a pas bougé si l'on annule, et si
       elle a bougé, la ligne porte déjà la nouvelle. */
    e.cell.textContent = this.formatValue(e.ctx.column as ColumnDef<TRow>, {
      ...e.ctx,
      value: getPath(e.ctx.row, (e.ctx.column.field ?? e.ctx.column.id)),
    })
    void annuler
  }

  /**
   * Valide la saisie.
   *
   * L'écriture dans la ligne n'a lieu qu'une fois `onCellValueChanged` résolu :
   * un hôte qui refuse la valeur (contrôle serveur, conflit) laisse la cellule
   * telle qu'elle était, sans que la grille ait à savoir pourquoi.
   */
  private async commitEdit(parEntree: boolean, deplacement = 0): Promise<void> {
    const e = this.edition
    if (!e) return
    const def = e.ctx.column as ColumnDef<TRow>
    const chemin = def.field ?? def.id
    const ancienne = getPath(e.ctx.row, chemin)
    const nouvelle = parseEditedValue(def, e.editor.getValue(), e.ctx)

    if (nouvelle === ancienne) { this.stopEditing(); this.apresEdition(e, parEntree, deplacement); return }

    const evenement = {
      row: e.ctx.row, rowId: e.rowId, rowIndex: e.ctx.rowIndex,
      column: def, oldValue: ancienne, newValue: nouvelle,
    }

    try {
      const retour = this.options.onCellValueChanged?.(evenement)
      if (retour instanceof Promise) {
        e.cell.classList.add(`${NS}-cell-saving`)
        ;(e.editor.element as HTMLInputElement).disabled = true
        await retour
      }
      setPath(e.ctx.row, chemin, nouvelle)
      this.stopEditing()
      this.apresEdition(e, parEntree, deplacement)
    } catch (err) {
      e.cell.classList.remove(`${NS}-cell-saving`)
      this.stopEditing(true)
      e.cell.classList.add(`${NS}-cell-error`)
      setTimeout(() => e.cell.classList.remove(`${NS}-cell-error`), 2000)
      /* La valeur est déjà revenue à ce qu'elle était ; sans un mot,
         l'utilisateur croit avoir mal cliqué et recommence. */
      const message = err instanceof Error ? err.message : String(err)
      this.toastHost.show(message, { kind: 'error' })
      this.options.onError?.(err)
    }
  }

  /** Enchaînement après validation : cellule suivante, ou ligne du dessous. */
  private apresEdition(
    e: NonNullable<IsoGrid<TRow>['edition']>,
    parEntree: boolean,
    deplacement: number,
  ): void {
    const editing = this.options.editing
    if (!editing) return

    if (deplacement !== 0) {
      const cols = this.columnModel.getRenderColumns()
        .filter(c => isCellEditable(c.def as ColumnDef<TRow>, e.ctx))
      const i = cols.findIndex(c => c.id === e.ctx.column.id)
      const suivante = cols[i + deplacement]
      if (suivante) this.startEditingCell(e.rowId, suivante.id)
      return
    }
    if (parEntree && editing.enterMovesDown) {
      const ligne = this.cache.getRow(e.ctx.rowIndex + 1) ?? this.getLoadedRows()[e.ctx.rowIndex + 1]
      if (ligne) this.startEditingCell(this.rowId(ligne, e.ctx.rowIndex + 1), e.ctx.column.id)
    }
  }

  refresh(): void {
    this.cache.refresh()
    this.refreshVisibleRange()
  }

  reload(options: { gardeSections?: boolean } = {}): void {
    // Vider les intertitres AVANT de reconstruire le corps. Sinon, le temps
    // que la nouvelle requete de sections revienne, les bandeaux du jeu
    // PRECEDENT se posaient sur les lignes du nouveau — « Aout 2026 » coiffant
    // des lignes de mars, apres un changement de filtre. Mieux vaut un corps
    // sans intertitre pendant une fraction de seconde qu'un intertitre faux.
    if (!options.gardeSections) {
      this.sections = []
      this.sectionStarts.clear()
      this.sectionsSignature = null
    }
    this.lastError = null
    this.cache.invalidate()
    this.cache.requestContext = this.buildRequestContext()
    this.viewport.scrollTop = 0
    this.renderedRows.clear()
    this.sectionNodes.clear()
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
    this.renderFooter()
    this.renderOverlay()
    // Les frontieres dependent des filtres et des donnees : un rechargement
    // explicite (apres une modification, par exemple) les invalide.
    if (!options.gardeSections) void this.fetchSections()
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
    /* En mode `single`, choisir une ligne retire la précédente — sinon l'appel
     * par programme produirait une sélection multiple que le clic, lui, ne
     * peut pas produire. */
    if (selected && this.options.rowSelection === 'single') {
      this.selection.selectOnly(rowId)
      return
    }
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

  /* --- plein écran --- */

  isFullscreen(): boolean {
    return this.isFs
  }

  /**
   * Bascule en CSS (`position: fixed` sur la racine), pas l'API Fullscreen du
   * navigateur : celle-ci exige un geste utilisateur ET l'autorisation de
   * l'hôte (`allow="fullscreen"` en iframe, refusée par défaut dans nombre de
   * panneaux d'admin) — une bascule CSS marche partout, sans permission à
   * négocier. Le `ResizeObserver` posé sur le viewport (cf. `buildLayout`)
   * recalcule seul les lignes visibles et la largeur des colonnes : aucun
   * recalcul manuel n'est nécessaire ici.
   */
  toggleFullscreen(): void {
    this.isFs = !this.isFs
    this.root.classList.toggle(`${NS}-fullscreen`, this.isFs)
    this.toolbar?.syncFullscreenButton()
    this.options.onFullscreenChange?.(this.isFs)
  }

  destroy(): void {
    // Le dernier geste de l'utilisateur — une colonne déplacée juste avant de
    // quitter la page — serait perdu dans le délai de regroupement.
    this.saveStateSoon?.cancel()
    if (this.savePending) this.pushState()

    this.destroyed = true
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame)
    this.contextMenu?.close()
    this.rowActionsMenu?.close()
    this.toastHost?.destroy()
    this.detailObserver?.disconnect()
    this.resizeObserver?.disconnect()
    this.themeMediaQuery?.removeEventListener('change', this.onSystemTheme)
    document.removeEventListener('keydown', this.onKeyDown)
    if (this.surRedimensionnementFenetre) {
      window.removeEventListener('resize', this.surRedimensionnementFenetre)
    }
    this.cache.destroy()
    this.columnModel.destroy()
    this.root.remove()
  }
}
