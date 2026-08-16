/**
 * Contrat public d'IsoGrid.
 *
 * Tout ce que l'extérieur (Blade, Alpine, Livewire, un bundle JS, un backend
 * Laravel) manipule passe par ces types. Ils sont volontairement indépendants
 * de @tanstack/table-core : le moteur headless est un détail d'implémentation
 * remplaçable, pas une partie de l'API.
 */

import type { SelectionSnapshot, SelectionState } from './selection'
import type { AggFunc } from './grouping'
import type { MasterDetailOptions } from './detail'
import type { ContextMenuItem } from '../ui/context-menu'

export type { HeaderCheckboxState, SelectionMode, SelectionSnapshot, SelectionState } from './selection'
export type { AggFunc, BuiltInAggFunc, DisplayRow, GroupNode } from './grouping'
export type { DetailContext, MasterDetailOptions } from './detail'

/* ------------------------------------------------------------------------ */
/* Colonnes                                                                  */
/* ------------------------------------------------------------------------ */

/** Nature de la donnée d'une colonne. Détermine le filtre et l'alignement par défaut. */
export type ColumnType = 'text' | 'number' | 'date' | 'datetime' | 'boolean' | 'set'

/** Côté logique d'épinglage. `start` = gauche en LTR, droite en RTL. */
export type PinPosition = 'start' | 'end' | false

export type Align = 'left' | 'center' | 'right'

/** Contexte transmis aux formateurs et rendus de cellule. */
export interface CellContext<TRow = AnyRow> {
  value: unknown
  row: TRow
  /** Index absolu dans le jeu de données complet (pas dans la page chargée). */
  rowIndex: number
  column: ColumnDef<TRow>
  grid: IsoGridApi<TRow>
}

export interface ColumnDef<TRow = AnyRow> {
  /** Identifiant stable. Sert de clé d'état, de clé de tri/filtre côté serveur. */
  id: string

  /** Chemin de lecture dans la ligne. Défaut : `id`. Supporte `a.b.c`. */
  field?: string

  /** Libellé d'en-tête. Une clé i18n est résolue si elle existe dans le catalogue. */
  header?: string

  /** Info-bulle d'en-tête. */
  headerTooltip?: string

  /** Groupe d'en-tête (bandeau au-dessus). Les colonnes de même `group` sont réunies. */
  group?: string

  type?: ColumnType

  width?: number
  minWidth?: number
  maxWidth?: number

  /** Répartit l'espace restant proportionnellement (à la CSS `flex-grow`). */
  flex?: number

  pinned?: PinPosition
  hide?: boolean

  sortable?: boolean
  resizable?: boolean

  /**
   * Filtre de colonne.
   * - `false` : aucun filtre
   * - `true` / omis : filtre déduit de `type`
   * - objet : configuration fine
   */
  filter?: boolean | FilterType | ColumnFilterConfig

  align?: Align

  /** Empêche l'utilisateur de masquer la colonne depuis la sidebar. */
  lockVisible?: boolean
  /** Empêche le déplacement de la colonne. */
  lockPosition?: boolean

  /** Formatage d'affichage. Retourne du texte brut (échappé). */
  valueFormatter?: (ctx: CellContext<TRow>) => string

  /**
   * Rendu riche. Retourne un Node ou une chaîne HTML *de confiance*.
   * Utiliser `valueFormatter` pour tout ce qui vient de l'utilisateur.
   */
  cellRenderer?: (ctx: CellContext<TRow>) => Node | string

  /** Classes CSS additionnelles sur la cellule. */
  cellClass?: string | ((ctx: CellContext<TRow>) => string | undefined)

  /** Valeur utilisée à l'export (défaut : `valueFormatter`, sinon la valeur brute). */
  exportValue?: (ctx: CellContext<TRow>) => string | number | Date | boolean | null

  /** Format de nombre/date Excel (ex. `'#,##0.00'`, `'dd/mm/yyyy'`). */
  exportFormat?: string

  /** Exclut la colonne de l'export sans la masquer à l'écran. */
  excludeFromExport?: boolean

  /**
   * Valeurs proposées par un filtre `set`. Si absent en mode serveur, elles
   * sont demandées au serveur à l'ouverture du filtre.
   */
  filterValues?: SetFilterOption[] | (() => Promise<SetFilterOption[]>)

  /**
   * Agrégat calculé pour cette colonne sur chaque groupe : `'sum'`, `'avg'`,
   * `'min'`, `'max'`, `'count'`, `'first'`, `'last'`, ou une fonction.
   * Sans effet tant qu'aucun groupage n'est actif.
   */
  aggFunc?: AggFunc

  /** Autorise le groupage par cette colonne. Défaut : true. */
  enableRowGroup?: boolean

  /** Métadonnées libres, transmises telles quelles au serveur. */
  meta?: Record<string, unknown>
}

export interface SetFilterOption {
  value: string | number | boolean | null
  label?: string
  /** Effectif, affiché en gris à droite de l'option quand le serveur le fournit. */
  count?: number
}

/* ------------------------------------------------------------------------ */
/* Filtres                                                                   */
/* ------------------------------------------------------------------------ */

export type FilterType = 'text' | 'number' | 'date' | 'boolean' | 'set'

export type TextOperator =
  | 'contains' | 'notContains' | 'equals' | 'notEquals'
  | 'startsWith' | 'endsWith' | 'blank' | 'notBlank'

export type NumberOperator =
  | 'equals' | 'notEquals' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'between' | 'blank' | 'notBlank'

export type DateOperator =
  | 'equals' | 'notEquals' | 'before' | 'after'
  | 'between' | 'blank' | 'notBlank'

export type SetOperator = 'in' | 'notIn'
export type BooleanOperator = 'is'

export type FilterOperator =
  | TextOperator | NumberOperator | DateOperator | SetOperator | BooleanOperator

/** Une condition élémentaire. `value2` ne sert qu'aux opérateurs `between`. */
export interface FilterCondition {
  op: FilterOperator
  value?: unknown
  value2?: unknown
}

/**
 * Filtre appliqué à une colonne. Jusqu'à deux conditions jointes par
 * `and`/`or` — la convention AG Grid, reprise parce qu'elle couvre 95 % des
 * besoins réels sans ouvrir un constructeur de requêtes.
 */
export interface ColumnFilterModel {
  type: FilterType
  conditions: FilterCondition[]
  join?: 'and' | 'or'
}

export interface ColumnFilterConfig {
  type: FilterType
  /** Restreint les opérateurs proposés dans le menu. */
  operators?: FilterOperator[]
  /** Opérateur présélectionné à l'ouverture. */
  defaultOperator?: FilterOperator
  /** Délai avant émission pendant la saisie, en ms. Défaut : 300. */
  debounce?: number
  /** Filtre `set` : masque le champ de recherche interne. */
  hideSearch?: boolean
}

/* ------------------------------------------------------------------------ */
/* État                                                                      */
/* ------------------------------------------------------------------------ */

export interface SortModel {
  id: string
  desc: boolean
}

/**
 * État complet et sérialisable de la grille. C'est exactement ce qu'on
 * persiste (préférences utilisateur) et ce qu'on envoie au serveur.
 */
export interface GridState {
  /** Ordre des colonnes, par id. Vide = ordre de déclaration. */
  columnOrder: string[]
  /** `false` = masquée. Les colonnes absentes sont visibles. */
  columnVisibility: Record<string, boolean>
  columnPinning: { start: string[]; end: string[] }
  columnSizing: Record<string, number>
  sort: SortModel[]
  filters: Record<string, ColumnFilterModel>
  /** Recherche globale libre (barre d'outils). */
  quickFilter: string
  /** Colonnes de groupage, dans l'ordre des niveaux. */
  rowGroup: string[]
  /** Chemins des groupes dépliés. */
  expandedGroups: string[]
  /** Identifiants des lignes dont le détail est ouvert. */
  openDetails: string[]
}

/* ------------------------------------------------------------------------ */
/* Source de données                                                         */
/* ------------------------------------------------------------------------ */

export type AnyRow = Record<string, unknown>

/** Requête envoyée au serveur. C'est le contrat que le backend doit honorer. */
export interface DataRequest {
  /** Index absolu de la première ligne demandée, incluse. */
  startRow: number
  /** Index absolu de la ligne suivant la dernière demandée, exclue. */
  endRow: number
  sort: SortModel[]
  filters: Record<string, ColumnFilterModel>
  quickFilter: string
  /** Colonnes actuellement visibles — permet au serveur de restreindre son SELECT. */
  columns: string[]
  signal?: AbortSignal
}

export interface DataResponse<TRow = AnyRow> {
  rows: TRow[]
  /**
   * Nombre total de lignes après filtrage.
   * `null`/absent = inconnu : la grille passe en défilement infini.
   */
  rowCount?: number | null
}

export interface Datasource<TRow = AnyRow> {
  getRows(request: DataRequest): Promise<DataResponse<TRow>>
  /** Valeurs distinctes d'une colonne, pour les filtres `set`. */
  getSetValues?(columnId: string, request: Omit<DataRequest, 'startRow' | 'endRow'>): Promise<SetFilterOption[]>
}

/* ------------------------------------------------------------------------ */
/* Options                                                                   */
/* ------------------------------------------------------------------------ */

/** Langues fournies avec la bibliothèque, catalogues complets. */
export type LocaleCode = 'fr' | 'en' | 'de' | 'es' | 'it' | 'nl' | 'pl' | 'ru'

export type ThemeMode = 'light' | 'dark' | 'auto'

export interface SidebarOptions {
  /**
   * Bande d'onglets verticale sur le bord du panneau.
   *
   * Défaut : `false`. Les panneaux s'ouvrent depuis la barre d'outils, comme
   * dans les tables Filament — une seule zone de commandes vaut mieux que
   * deux points d'entrée pour la même chose.
   */
  tabs?: boolean
  /** Panneaux disponibles. */
  panels?: Array<'columns' | 'filters'>
  /** Ouvre la sidebar au démarrage sur ce panneau. */
  defaultOpen?: false | 'columns' | 'filters'
  width?: number
  /** Côté d'ancrage. Défaut : `end`. */
  position?: 'start' | 'end'
}

export interface ToolbarOptions {
  quickFilter?: boolean
  quickFilterPlaceholder?: string
  exportButton?: boolean
  /** Bouton ouvrant le panneau « Filtres », avec le compteur de filtres actifs. */
  filtersButton?: boolean
  /** Bouton ouvrant le panneau « Colonnes ». */
  columnsButton?: boolean
  /** @deprecated remplacé par `filtersButton` / `columnsButton`. */
  sidebarButton?: boolean
  /** Nœuds libres injectés à gauche de la barre d'outils. */
  slot?: () => Node | null
}

export interface ExportOptions {
  /** Sans extension. */
  filename?: string
  /** Nom de l'onglet Excel. */
  sheetName?: string
  /**
   * `all` rapatrie tout le jeu filtré depuis le serveur, page par page.
   * `loaded` n'exporte que les lignes déjà en cache.
   */
  source?: 'all' | 'loaded'
  /** Garde-fou : au-delà, l'export s'arrête et prévient. Défaut : 100 000. */
  maxRows?: number
  /** Taille des pages de rapatriement. Défaut : 1000. */
  pageSize?: number
  /** Fige la ligne d'en-tête et les colonnes épinglées à `start`. Défaut : true. */
  freezeHeader?: boolean

  /**
   * Fournit ExcelJS explicitement, au lieu de laisser la lib faire
   * `import('exceljs')`.
   *
   * Indispensable dès que l'hôte ne peut pas résoudre un identifiant nu :
   * bundle embarqué servi depuis `public/`, page sans étape de build, import
   * map absente. Retourner le module ou son export par défaut.
   *
   * @example excelJs: () => import('/vendor/isogrid/exceljs.js')
   */
  excelJs?: () => unknown | Promise<unknown>
  /** Ajoute les auto-filtres Excel sur la ligne d'en-tête. Défaut : true. */
  autoFilter?: boolean
}

export interface IsoGridOptions<TRow = AnyRow> {
  columns: ColumnDef<TRow>[]

  /**
   * `client` : tout le jeu est en mémoire, tri et filtres instantanés.
   * `server` : tri, filtres et pagination délégués à `datasource`.
   */
  rowModel?: 'client' | 'server'

  /** Mode client : les lignes. */
  rows?: TRow[]

  /** Mode serveur : la source. Une URL est convertie en source HTTP JSON. */
  datasource?: Datasource<TRow> | string

  /** Identité stable d'une ligne. Défaut : champ `id`, sinon l'index. */
  getRowId?: (row: TRow, index: number) => string

  locale?: LocaleCode
  theme?: ThemeMode

  rowHeight?: number
  headerHeight?: number

  /** Nombre de lignes par bloc chargé en mode serveur. Défaut : 100. */
  blockSize?: number
  /** Blocs conservés en cache. Au-delà, les plus anciens sont évincés. Défaut : 20. */
  maxBlocksInCache?: number

  /** Largeur par défaut d'une colonne sans `width`. Défaut : 160. */
  defaultColumnWidth?: number
  /** Réglages appliqués à toutes les colonnes, écrasés par la colonne elle-même. */
  defaultColumn?: Partial<ColumnDef<TRow>>

  /**
   * Sélection de lignes par cases à cocher.
   *
   * `multiple` ajoute une colonne de cases épinglée à gauche, avec une case
   * d'en-tête « tout sélectionner ». `single` sélectionne une seule ligne à la
   * fois. Défaut : `false`.
   *
   * ⚠️ En mode serveur, fournir un `getRowId` STABLE (une clé métier, pas
   * l'index) : l'index d'une ligne change dès qu'on retrie, ce qui ferait
   * porter la sélection sur d'autres lignes.
   */
  rowSelection?: false | 'single' | 'multiple'

  /** Largeur de la colonne de cases à cocher. Défaut : 44. */
  selectionColumnWidth?: number

  /**
   * Sélectionner la ligne au clic n'importe où, pas seulement sur la case.
   * Défaut : false — sinon un clic destiné à ouvrir la fiche sélectionne.
   */
  selectOnRowClick?: boolean

  /** Appelé à chaque changement de sélection. */
  onSelectionChanged?: (selection: SelectionSnapshot, grid: IsoGridApi<TRow>) => void

  /**
   * Colonnes de groupage initiales, dans l'ordre des niveaux.
   *
   * ⚠️ Le groupage n'existe qu'en mode client : il exige l'ensemble des
   * lignes en mémoire. En mode serveur, l'option est ignorée et un
   * avertissement est émis.
   */
  rowGroup?: string[]

  /** Niveaux ouverts au départ. `0` = tout replié (défaut), `-1` = tout déplié. */
  groupDefaultExpanded?: number

  /**
   * Zone où déposer des colonnes pour les grouper. `true` l'affiche en
   * permanence, `'whenGrouping'` seulement quand un groupage est actif.
   */
  groupPanel?: boolean | 'whenGrouping'

  /** Largeur de la colonne de groupe. Défaut : 240. */
  groupColumnWidth?: number

  /** Appelé quand les colonnes de groupage changent. */
  onRowGroupChanged?: (columnIds: string[], grid: IsoGridApi<TRow>) => void

  /**
   * Lignes dépliables sur un panneau de détail : sous-grille, fiche, contenu
   * chargé en réseau. Une colonne de chevron apparaît en tête.
   */
  masterDetail?: MasterDetailOptions<TRow>

  /**
   * Actions de ligne, regroupées derrière un bouton « ⋮ » dans une colonne
   * épinglée à droite.
   *
   * Une grille sans actions n'est qu'une consultation : c'est ce qui manque
   * pour remplacer une table d'administration, où chaque ligne se modifie,
   * s'ouvre ou déclenche un traitement.
   */
  rowActions?: {
    /** Largeur de la colonne. Défaut : 48. */
    width?: number
    /** Construit le menu pour une ligne. Retourner `[]` masque le bouton. */
    items: (row: TRow, rowIndex: number) => ContextMenuItem[]
  }

  sidebar?: false | SidebarOptions
  toolbar?: false | ToolbarOptions
  /**
   * Menu contextuel du corps (clic droit) : copier la cellule, copier la
   * ligne, exporter. `false` rend le menu natif du navigateur.
   */
  contextMenu?: false | import('../ui/context-menu').ContextMenuOptions<TRow>
  statusBar?: boolean
  export?: ExportOptions

  /** Bandes alternées sur les lignes. Défaut : true. */
  stripedRows?: boolean

  /** État initial (préférences restaurées). */
  initialState?: Partial<GridState>

  /** Appelé à chaque changement d'état : à persister côté hôte. */
  onStateChange?: (state: GridState) => void

  onRowClick?: (row: TRow, index: number, event: MouseEvent) => void
  onRowDoubleClick?: (row: TRow, index: number, event: MouseEvent) => void
  onCellClick?: (ctx: CellContext<TRow>, event: MouseEvent) => void

  /** Remontée d'erreur de chargement. Défaut : log console + bandeau. */
  onError?: (error: unknown) => void

  /**
   * Rendu des icônes. Par défaut Font Awesome (`<i class="fa-solid fa-x">`),
   * la convention maison. Fournir cette fonction pour des SVG inline.
   */
  renderIcon?: (name: IconName) => Node | string

  /** Surcharges de libellés, par-dessus le catalogue de la locale. */
  messages?: Partial<Record<string, string>>
}

export type IconName =
  | 'sort-asc' | 'sort-desc' | 'sort-none'
  | 'filter' | 'filter-active' | 'filter-column' | 'menu'
  | 'columns' | 'sidebar' | 'close' | 'search'
  | 'pin-start' | 'pin-end' | 'unpin'
  | 'export' | 'excel' | 'csv'
  | 'copy' | 'copy-row' | 'copy-table'
  | 'check' | 'chevron-down' | 'chevron-right'
  | 'eye' | 'eye-off' | 'grip' | 'spinner' | 'warning'

/* ------------------------------------------------------------------------ */
/* API publique de l'instance                                                */
/* ------------------------------------------------------------------------ */

export interface ExportProgress {
  loaded: number
  total: number | null
  phase: 'fetching' | 'building' | 'done'
}

export interface IsoGridApi<TRow = AnyRow> {
  /* --- état --- */
  getState(): GridState
  setState(state: Partial<GridState>): void
  resetState(): void

  /* --- colonnes --- */
  getColumns(): ColumnDef<TRow>[]
  /** Ajoute une colonne. `atIndex` omis = à la fin. */
  addColumn(def: ColumnDef<TRow>, atIndex?: number): void
  removeColumn(columnId: string): void
  /** Remplace tout le jeu de colonnes en préservant l'état des colonnes conservées. */
  setColumns(defs: ColumnDef<TRow>[]): void
  setColumnVisible(columnId: string, visible: boolean): void
  moveColumn(columnId: string, toIndex: number): void
  pinColumn(columnId: string, position: PinPosition): void
  autoSizeColumn(columnId: string): void

  /* --- tri / filtres --- */
  setSort(sort: SortModel[]): void
  setFilter(columnId: string, model: ColumnFilterModel | null): void
  clearFilters(): void
  setQuickFilter(value: string): void

  /* --- données --- */
  refresh(): void
  /** Recharge en repartant du haut (après un changement de tri/filtre). */
  reload(): void
  setRows(rows: TRow[]): void
  /**
   * Nombre de lignes de DONNÉES après filtrage — les lignes de groupe n'y
   * comptent pas. C'est le chiffre affiché dans la barre d'état et celui
   * qu'attend un hôte qui demande « combien d'enregistrements ». `null` tant
   * que le serveur n'a pas répondu.
   */
  getDisplayedRowCount(): number | null
  /** Lignes actuellement en cache, dans l'ordre d'affichage. */
  getLoadedRows(): TRow[]

  /* --- export --- */
  exportExcel(options?: ExportOptions & { onProgress?: (p: ExportProgress) => void }): Promise<void>
  exportCsv(options?: ExportOptions & { onProgress?: (p: ExportProgress) => void }): Promise<void>

  /* --- sélection --- */
  /** Lignes sélectionnées ET actuellement chargées. Voir `getSelection()`. */
  getSelectedRows(): TRow[]
  /**
   * État complet et sérialisable de la sélection — c'est ce qu'une action de
   * masse doit envoyer au serveur. En mode `exclude`, il désigne des lignes
   * que le navigateur n'a jamais chargées.
   */
  getSelection(): SelectionSnapshot
  setSelection(state: SelectionState | null): void
  setRowSelected(rowId: string, selected: boolean): void
  isRowSelected(rowId: string): boolean
  /** Sélectionne tout le jeu filtré, lignes non chargées comprises. */
  selectAll(): void
  deselectAll(): void

  /* --- groupage --- */
  getRowGroup(): string[]
  setRowGroup(columnIds: string[]): void
  addRowGroup(columnId: string): void
  removeRowGroup(columnId: string): void
  expandAllGroups(): void
  collapseAllGroups(): void

  /* --- détail --- */
  toggleDetail(rowId: string): void
  isDetailOpen(rowId: string): boolean
  closeAllDetails(): void

  /* --- divers --- */
  setLocale(locale: LocaleCode): void
  setTheme(theme: ThemeMode): void
  sizeColumnsToFit(): void
  destroy(): void
}
