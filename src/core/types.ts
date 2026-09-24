/**
 * Contrat public d'IsoGrid.
 *
 * Tout ce que l'extérieur (Blade, Alpine, Livewire, un bundle JS, un backend
 * Laravel) manipule passe par ces types. Ils sont volontairement indépendants
 * de @tanstack/table-core : le moteur headless est un détail d'implémentation
 * remplaçable, pas une partie de l'API.
 */

import type { SelectionSnapshot, SelectionState } from './selection'
import type { MasterDetailOptions } from './detail'
import type { ContextMenuItem } from '../ui/context-menu'

export type { HeaderCheckboxState, SelectionMode, SelectionSnapshot, SelectionState } from './selection'
export type { AggFunc, BuiltInAggFunc, ColumnAgg, DisplayRow, GroupNode } from './grouping'
export type { DetailContext, MasterDetailOptions } from './detail'
export type { CellEditEvent, CellEditor, CellEditorFactory, EditingOptions } from './editing'
export type { ToastKind, ToastOptions } from '../ui/toast'

/* ------------------------------------------------------------------------ */
/* Colonnes                                                                  */
/* ------------------------------------------------------------------------ */

/** Nature de la donnée d'une colonne. Détermine le filtre et l'alignement par défaut. */
export type ColumnType = 'text' | 'number' | 'date' | 'datetime' | 'boolean' | 'set'

/** Côté logique d'épinglage. `start` = gauche en LTR, droite en RTL. */
export type PinPosition = 'start' | 'end' | false

export type Align = 'left' | 'center' | 'right'

/** Contexte transmis aux formateurs et rendus de cellule. */
export interface FooterContext {
  /** Lignes servant au calcul : la sélection si elle porte, sinon les lignes chargées. */
  rows: AnyRow[]
  /** Vrai si `rows` est une sélection de l'utilisateur. */
  onSelection: boolean
  /** Total du jeu filtré, quand il est connu. */
  rowCount: number | null
}

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

  /**
   * Nombre de décimales imposé pour une colonne `number`.
   *
   * Sans lui, `Intl` décide : un entier sort sans décimale et une somme
   * d'argent se lit « 1 712 » à côté de « 104,32 », ce qui rend une colonne
   * de montants illisible en diagonale. `decimals: 2` aligne tout.
   */
  decimals?: number

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

  /**
   * Cellule modifiable.
   * `true` pour toute la colonne, ou une fonction pour décider ligne par ligne
   * (une commande validée ne se modifie plus, par exemple).
   */
  editable?: boolean | ((ctx: CellContext<TRow>) => boolean)

  /** Éditeur sur mesure. Par défaut, un champ déduit de `type`. */
  cellEditor?: import('./editing').CellEditorFactory<TRow>

  /**
   * Convertit la saisie en valeur métier — l'inverse de `valueFormatter`.
   * Par défaut : nombre pour `type: 'number'`, chaîne sinon, `null` si vide.
   */
  valueParser?: (saisie: unknown, ctx: CellContext<TRow>) => unknown

  /**
   * Mise en forme d'une valeur au pied de colonne. Défaut : nombre localisé.
   * Reçoit le nom de l'agrégat quand la colonne en porte plusieurs.
   */
  footerFormatter?: (value: unknown, agg?: string) => string

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
  aggFunc?: import('./grouping').ColumnAgg

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
  /**
   * Totaux du pied, calculés par la SOURCE sur tout le jeu filtré.
   *
   * En modèle serveur la grille ne voit qu'une fenêtre de lignes : un total
   * calculé sur les lignes chargées serait faux dès que le jeu dépasse un bloc,
   * sans que rien ne le signale. La source, elle, sait totaliser l'ensemble.
   *
   * Une valeur peut être un nombre, ou un objet `{ CHF: …, EUR: … }` quand la
   * colonne mêle des devises : additionner des francs et des euros donnerait un
   * nombre qui n'existe pas.
   */
  footer?: Record<string, unknown> | null
}

/**
 * Une section : un intertitre qui coiffe des lignes consécutives.
 *
 * Les frontières viennent de la SOURCE et non des lignes chargées : en
 * défilement par blocs, une section chevauche souvent deux blocs, et son
 * total calculé sur le seul bloc visible serait faux. La source répond donc
 * pour l'ensemble du jeu filtré, en une requête par changement de tri ou de
 * filtre.
 */
export interface SectionInfo {
  /** Valeur brute de la colonne de regroupement (sert de clé). */
  value: unknown
  /** Intitulé affiché. À défaut, la valeur formatée. */
  label?: string
  /** Nombre de lignes de la section — c'est lui qui donne les frontières. */
  count: number
  /**
   * Totaux par colonne, déjà agrégés par la source. Un total peut être un
   * nombre, ou `{ CHF: …, EUR: … }` quand la colonne mêle des devises.
   */
  totals?: Record<string, number | Record<string, number>>
}

export interface Datasource<TRow = AnyRow> {
  getRows(request: DataRequest): Promise<DataResponse<TRow>>
  /** Valeurs distinctes d'une colonne, pour les filtres `set`. */
  getSetValues?(columnId: string, request: Omit<DataRequest, 'startRow' | 'endRow'>): Promise<SetFilterOption[]>
  /**
   * Sections du jeu filtré, dans l'ordre d'affichage.
   *
   * Sans cette méthode, l'option `sections` reste sans effet : mieux vaut
   * aucun intertitre qu'un intertitre au mauvais endroit.
   */
  getSections?(request: Omit<DataRequest, 'startRow' | 'endRow'>): Promise<SectionInfo[]>
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

/**
 * Un filtre d'usage courant, offert en un clic dans la barre d'outils.
 *
 * Une grille d'administration a presque toujours trois ou quatre questions
 * qu'on lui pose dix fois par jour — « ce qui reste à traiter », « ce mois »,
 * « les sorties ». Les poser par le panneau de filtres demande quatre clics à
 * chaque fois ; un tag en demande un, et se relit d'un coup d'œil puisqu'il
 * reste allumé tant qu'il s'applique.
 */
export interface ToolbarTag {
  /** Identifiant stable, pour retrouver le tag dans l'état. */
  id: string
  label: string
  /** État de filtre posé par le tag, par colonne. */
  filters: Record<string, ColumnFilterModel>
  /** Teinte du tag une fois actif. Défaut : l'accent de la grille. */
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info'
  /** Infobulle. */
  title?: string
  /**
   * Pastille affichée à droite du libellé — un ordre de grandeur, calculé par
   * l'hôte et fourni tel quel.
   *
   * La grille ne le calcule pas elle-même : en modèle serveur, elle ne connaît
   * que le bloc de lignes qu'elle affiche, et un compteur déduit de ce bloc
   * mentirait dès la deuxième page. L'hôte, lui, sait interroger l'ensemble du
   * jeu (`select count(distinct …)`) et décider ce qui mérite d'être compté :
   * des lignes, des fournisseurs, un montant.
   */
  badge?: string | number
  /** Infobulle de la pastille — dire CE QUE le nombre compte. */
  badgeTitle?: string
}

export interface ToolbarOptions {
  /**
   * Tags de filtres rapides, rendus à GAUCHE de la recherche.
   *
   * Un clic applique le filtre du tag, un second le retire. Deux tags qui
   * portent sur des colonnes différentes se cumulent ; deux tags qui portent
   * sur la même colonne se remplacent — sinon le second n'aurait aucun effet
   * visible et le tableau paraîtrait bloqué.
   */
  tags?: ToolbarTag[]

  quickFilter?: boolean
  quickFilterPlaceholder?: string
  /**
   * Bouton « Exporter » dans la barre d'outils. Défaut : `false`.
   *
   * L'export est toujours accessible au clic droit sur une ligne, à côté des
   * copies. Ce bouton n'est qu'un second point d'entrée : le passer à `true`
   * quand l'export est une fonction attendue et qu'il faut la rendre visible.
   */
  exportButton?: boolean
  /** Bouton ouvrant le panneau « Filtres », avec le compteur de filtres actifs. */
  filtersButton?: boolean
  /** Bouton ouvrant le panneau « Colonnes ». */
  columnsButton?: boolean
  /** @deprecated remplacé par `filtersButton` / `columnsButton`. */
  sidebarButton?: boolean
  /**
   * Bouton « plein écran » (icône seule, dernier de la barre). Défaut : `false`.
   *
   * Opt-in comme `exportButton` : la plupart des grilles vivent dans une mise
   * en page déjà dimensionnée pour elles (panneau Filament, page dédiée), où
   * agrandir n'apporte rien. À activer quand la grille est à l'étroit dans
   * son conteneur habituel (beaucoup de colonnes, lignes de détail) et qu'un
   * agrandissement ponctuel aide vraiment à travailler dedans.
   *
   * Bascule en CSS (`position: fixed` sur la racine, pas l'API Fullscreen du
   * navigateur) : marche dans un iframe ou un contexte qui refuse
   * `requestFullscreen()`, et laisse `Échap` fermer sans dépendre du
   * navigateur. Le `ResizeObserver` déjà posé sur le viewport recalcule seul
   * les lignes visibles et la largeur des colonnes.
   */
  fullscreenButton?: boolean
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

  /**
   * La grille s'étire jusqu'au bas de la fenêtre et suit les
   * redimensionnements. Défaut : `false` — la grille remplit son conteneur,
   * dont l'hôte fixe la hauteur.
   *
   * Pourquoi une option et pas une simple hauteur en CSS : une hauteur fixe
   * du genre `calc(100vh - 18rem)` suppose connue la hauteur de tout ce qui
   * précède la grille (fil d'Ariane, titre, boutons, filtres). Elle laisse du
   * vide sur un grand écran et coupe la grille sur un petit. Ici la distance
   * est MESURÉE à chaque fois.
   *
   * À laisser à `false` quand la page place la grille dans un bloc déjà
   * dimensionné, ou qu'elle en affiche plusieurs l'une sous l'autre : chacune
   * réclamerait alors toute la hauteur restante.
   */
  autoHeight?: boolean

  /** Hauteur minimale en mode `autoHeight`, quand la page est déjà longue. Défaut : 320. */
  autoHeightMin?: number

  /** Marge laissée sous la grille en mode `autoHeight`. Défaut : 24. */
  autoHeightGap?: number

  rowHeight?: number
  headerHeight?: number

  /** Nombre de lignes par bloc chargé en mode serveur. Défaut : 100. */
  blockSize?: number
  /** Blocs conservés en cache. Au-delà, les plus anciens sont évincés. Défaut : 20. */
  maxBlocksInCache?: number

  /** Largeur par défaut d'une colonne sans `width`. Défaut : 160. */
  defaultColumnWidth?: number
  /**
   * Étire les colonnes pour occuper toute la largeur de la grille quand leur
   * somme est plus petite. Défaut : `true`.
   *
   * L'espace restant est réparti au RENDU seulement : rien n'est écrit dans
   * l'état (`columnSizing`), donc rien n'est persisté, et la même grille se
   * recalcule d'elle-même quand la fenêtre change de taille. S'étirent les
   * colonnes non épinglées, redimensionnables et que l'utilisateur n'a pas
   * redimensionnées — au prorata de `flex` si au moins une colonne le déclare,
   * sinon au prorata de leur largeur. `maxWidth` est respecté.
   */
  fillWidth?: boolean
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

  /**
   * Retire le contour extérieur et les coins arrondis. Défaut : `false`.
   *
   * Pour une grille posée dans un conteneur qui porte déjà son propre cadre —
   * une carte, un panneau — deux contours imbriqués font sale.
   */
  borderless?: boolean

  /**
   * Afficher la ligne d'en-tête. Défaut : `true`.
   *
   * La masquer donne une liste de fiches plutôt qu'un tableau. ⚠️ L'en-tête
   * porte le tri, les filtres de colonne, le menu de colonne et la poignée de
   * redimensionnement : sans lui, tout cela devient inatteignable à la souris.
   * À réserver aux vues en lecture seule.
   *
   * On masque la LIGNE et non sa hauteur : un `headerHeight: 0` laisserait les
   * filets haut et bas de `.isg-header-row`, soit un double trait gris.
   */
  showHeader?: boolean

  /** Largeur de la colonne de cases à cocher. Défaut : 44. */
  selectionColumnWidth?: number

  /**
   * Afficher la colonne de cases à cocher. Défaut : `true`.
   *
   * La passer à `false` retire la colonne SANS retirer la sélection : celle-ci
   * se fait alors au clic sur la ligne, et `selectOnRowClick` s'active de
   * lui-même. Sans cette bascule automatique, supprimer la colonne rendrait la
   * sélection inatteignable — donc les actions de masse inertes, et sans rien
   * pour le signaler.
   *
   * Contrepartie assumée : on perd la case « tout sélectionner » de l'en-tête,
   * donc le mode « tout sauf » ne s'obtient plus qu'en appelant `selectAll()`.
   */
  selectionColumn?: boolean

  /**
   * Sélectionner la ligne au clic n'importe où, pas seulement sur la case.
   *
   * Non renseigné, il suit la présence de la colonne de cases : `false` quand
   * elle est là — sinon un clic destiné à ouvrir la fiche sélectionnerait —
   * et `true` quand elle n'y est pas, c'est-à-dire en mode `single` ou après
   * `selectionColumn: false`. Le renseigner tranche dans les deux sens.
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
   * Intertitres de section : une ligne plus haute, en gras, qui coiffe les
   * lignes partageant une même valeur — « Décembre 2026 », par exemple — avec
   * les totaux de la section à droite et un filet épais dessous.
   *
   * La colonne de regroupement est FIXE, déclarée ici : elle ne suit pas le
   * tri courant. Trier par fournisseur ne réorganise donc pas les sections,
   * il réorganise les lignes à l'intérieur — c'est ce qu'on veut d'un
   * découpage par mois, qui doit rester le même quel que soit le tri.
   *
   * En mode source, les frontières et les totaux viennent de
   * `Datasource.getSections()` : une section chevauche souvent deux blocs, et
   * un total calculé sur les seules lignes chargées serait faux.
   */
  sections?: {
    /** Identifiant de la colonne dont la valeur découpe les sections. */
    column: string
    /** Hauteur de l'intertitre. Défaut : 1,6 × la hauteur de ligne. */
    height?: number
    /** Colonnes à totaliser, affichées à la suite de l'intitulé. */
    totals?: string[]
    /**
     * Libellé de chaque total, par colonne. À défaut, l'en-tête de la colonne.
     * Utile quand l'en-tête prête à confusion dans un intertitre : une colonne
     * « CHF » donnait « CHF 811,84 », qu'on lisait comme une devise de plus
     * à côté des totaux par devise.
     */
    totalLabels?: Record<string, string>
    /** Intitulé sur mesure ; à défaut, le libellé fourni par la source. */
    label?: (section: SectionInfo) => string
  }

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

  /**
   * Appelé à chaque bascule du plein écran (bouton, `Échap`, appel
   * programmatique).
   *
   * Le plein écran ne fait pas partie de `GridState` : c'est une commodité
   * d'affichage, pas une question posée aux données. Un hôte qui veut tout de
   * même le retenir — dans l'URL, par exemple, pour qu'un lien rouvre la
   * grille en grand — s'abonne ici.
   */
  onFullscreenChange?: (actif: boolean) => void

  /**
   * Où ranger les préférences d'affichage — colonnes, tri, filtres.
   *
   * L'hôte fournit `load` et `save`, éventuellement asynchrones : la grille
   * relit l'état au montage et le réenregistre après chaque changement, sans
   * rien savoir du transport. C'est ce qui permet de garder les réglages sur
   * un serveur, donc de les retrouver d'un poste à l'autre, là où le
   * `localStorage` reste prisonnier d'un navigateur.
   *
   * Ce qui vient du dépôt l'emporte sur `initialState`. Un échec de lecture ou
   * d'écriture est absorbé : la grille travaille quand même.
   *
   * Voir `createHttpStateStore` et `createLocalStateStore`.
   */
  stateStore?: import('./state-store').GridStateStore

  /**
   * Classes CSS supplémentaires à poser sur une ligne, d'après son contenu.
   *
   * Une grille montre des données ; l'hôte, lui, sait ce qu'elles signifient —
   * une commande en retard, un lot non conforme, un enregistrement verrouillé.
   * Sans ce point d'accroche, cette information ne peut vivre que dans une
   * cellule, alors qu'elle qualifie la ligne entière et doit se voir d'un coup
   * d'œil sur toute sa largeur.
   *
   * Les classes viennent en plus de celles de la grille, jamais à leur place :
   * la sélection et l'alternance continuent de s'afficher.
   */
  getRowClass?: (row: TRow, index: number) => string | string[] | null | undefined

  onRowClick?: (row: TRow, index: number, event: MouseEvent) => void
  onRowDoubleClick?: (row: TRow, index: number, event: MouseEvent) => void
  onCellClick?: (ctx: CellContext<TRow>, event: MouseEvent) => void

  /**
   * Ligne de totaux en pied, pour les colonnes qui portent un `aggFunc`.
   *
   * En modèle client la grille calcule elle-même. En modèle serveur elle n'a
   * qu'une fenêtre sur le jeu filtré : c'est alors `values` qui fait foi,
   * l'hôte étant seul à pouvoir totaliser l'ensemble.
   */
  footer?: boolean | {
    /** Valeurs par identifiant de colonne. Priment sur tout calcul local. */
    values?: (ctx: FooterContext) => Record<string, unknown> | null
    /** Basculer les totaux sur la sélection quand il y en a une. Défaut : true. */
    useSelection?: boolean
  }

  /** Active l'édition en cellule. Voir `ColumnDef.editable` pour le périmètre. */
  editing?: false | import('./editing').EditingOptions

  /**
   * Une cellule vient d'être validée.
   *
   * Retourner une promesse fait attendre la grille : la cellule reste en état
   * d'enregistrement, et un rejet annule la saisie sans rien écrire dans la
   * ligne. C'est ce qui permet de refuser une valeur côté serveur.
   */
  onCellValueChanged?: (event: import('./editing').CellEditEvent<TRow>) => void | Promise<void>

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
  | 'fullscreen' | 'fullscreen-exit'

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
  /** Affiche une confirmation brève en bas de la grille. */
  toast(message: string, options?: import('../ui/toast').ToastOptions): void
  startEditingCell(rowId: string, columnId: string): void
  stopEditing(cancel?: boolean): void
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

  /* --- plein écran --- */
  isFullscreen(): boolean
  /** Bascule ; sans effet si `toolbar.fullscreenButton` n'a jamais été activé côté options — l'icône n'existerait pas, mais l'appel programmatique reste possible. */
  toggleFullscreen(): void

  destroy(): void
}
