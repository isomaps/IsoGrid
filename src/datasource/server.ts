import type {
  AnyRow, DataRequest, DataResponse, Datasource, SetFilterOption,
} from '../core/types'

/* ------------------------------------------------------------------------ */
/* Source HTTP par défaut                                                    */
/* ------------------------------------------------------------------------ */

export interface HttpDatasourceOptions {
  url: string
  /** Défaut : POST. Un GET encode l'état en `?q=<json>` — attention à la taille d'URL. */
  method?: 'GET' | 'POST'
  headers?: Record<string, string> | (() => Record<string, string>)
  /** URL des valeurs distinctes pour les filtres `set`. Défaut : `${url}/set-values`. */
  setValuesUrl?: string
  /** Transforme la requête avant envoi (renommage de champs, contexte métier…). */
  transformRequest?: (req: DataRequest) => unknown
  /** Transforme la réponse brute au format attendu. */
  transformResponse?: (raw: unknown) => DataResponse
  credentials?: RequestCredentials
}

/** Sérialise une requête sans le `signal`, qui n'est pas transmissible. */
function serializeRequest(req: DataRequest): Record<string, unknown> {
  return {
    startRow: req.startRow,
    endRow: req.endRow,
    sort: req.sort,
    filters: req.filters,
    quickFilter: req.quickFilter,
    columns: req.columns,
  }
}

/**
 * Récupère le jeton CSRF de Laravel. Les trois repos web posent la balise
 * `<meta name="csrf-token">` dans leur layout : sans ça, tout POST prend un 419.
 */
function csrfToken(): string | undefined {
  const meta = document.querySelector('meta[name="csrf-token"]')
  return meta?.getAttribute('content') ?? undefined
}

export function createHttpDatasource<TRow = AnyRow>(
  options: HttpDatasourceOptions | string,
): Datasource<TRow> {
  const opts: HttpDatasourceOptions = typeof options === 'string' ? { url: options } : options
  const method = opts.method ?? 'POST'

  const buildHeaders = (): Record<string, string> => {
    const base: Record<string, string> = {
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    }
    if (method === 'POST') {
      base['Content-Type'] = 'application/json'
      const token = csrfToken()
      if (token) base['X-CSRF-TOKEN'] = token
    }
    const extra = typeof opts.headers === 'function' ? opts.headers() : opts.headers
    return { ...base, ...extra }
  }

  const call = async (url: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    const init: RequestInit = {
      method,
      headers: buildHeaders(),
      signal,
      credentials: opts.credentials ?? 'same-origin',
    }
    let target = url
    if (method === 'POST') {
      init.body = JSON.stringify(payload)
    } else {
      const sep = url.includes('?') ? '&' : '?'
      target = `${url}${sep}q=${encodeURIComponent(JSON.stringify(payload))}`
    }
    const res = await fetch(target, init)
    if (!res.ok) {
      throw new Error(`IsoGrid: la source a répondu ${res.status} ${res.statusText}`)
    }
    return res.json()
  }

  return {
    async getRows(request: DataRequest): Promise<DataResponse<TRow>> {
      const payload = opts.transformRequest
        ? opts.transformRequest(request)
        : serializeRequest(request)
      const raw = await call(opts.url, payload, request.signal)
      if (opts.transformResponse) return opts.transformResponse(raw) as DataResponse<TRow>

      const body = raw as Record<string, unknown>
      // Tolère les enveloppes Laravel les plus courantes.
      const rows = (body.rows ?? body.data ?? []) as TRow[]
      const rowCount = (body.rowCount ?? body.total ?? body.recordsFiltered ?? null) as number | null
      return { rows, rowCount }
    },

    async getSetValues(columnId, request): Promise<SetFilterOption[]> {
      const url = opts.setValuesUrl ?? `${opts.url.replace(/\/$/, '')}/set-values`
      const raw = await call(url, {
        column: columnId,
        filters: request.filters,
        quickFilter: request.quickFilter,
      }, request.signal)
      const body = raw as Record<string, unknown>
      const values = (body.values ?? body.data ?? raw) as unknown[]
      return values.map((v): SetFilterOption => (
        v !== null && typeof v === 'object'
          ? (v as SetFilterOption)
          : { value: v as string | number | boolean | null }
      ))
    },
  }
}

/* ------------------------------------------------------------------------ */
/* Cache par blocs                                                           */
/* ------------------------------------------------------------------------ */

type BlockStatus = 'loading' | 'loaded' | 'failed'

interface Block<TRow> {
  index: number
  status: BlockStatus
  rows: TRow[]
  /** Sert à évincer le bloc le moins récemment consulté. */
  touchedAt: number
  controller?: AbortController
  error?: unknown
}

export interface BlockCacheOptions<TRow> {
  datasource: Datasource<TRow>
  blockSize: number
  maxBlocks: number
  /** Appelé quand des lignes deviennent disponibles ou que le total change. */
  onChange: () => void
  onError: (error: unknown) => void
}

/**
 * Cache de lignes par blocs contigus, façon « infinite row model ».
 *
 * La grille demande des index absolus ; le cache traduit en blocs, déclenche
 * les chargements manquants et laisse des trous (`undefined`) que le rendu
 * affiche en squelette. Les requêtes obsolètes sont annulées : c'est ce qui
 * évite qu'un vieux bloc écrase l'affichage après un changement de tri.
 */
export class BlockCache<TRow = AnyRow> {
  private blocks = new Map<number, Block<TRow>>()
  private rowCount: number | null = null
  /** Incrémenté à chaque invalidation : toute réponse d'une génération périmée est jetée. */
  private generation = 0
  private clock = 0

  constructor(private opts: BlockCacheOptions<TRow>) {}

  /** Contexte de requête courant, injecté par la grille avant chaque chargement. */
  requestContext: Omit<DataRequest, 'startRow' | 'endRow' | 'signal'> = {
    sort: [], filters: {}, quickFilter: '', columns: [],
  }

  getRowCount(): number | null {
    return this.rowCount
  }

  /**
   * Nombre de lignes à représenter dans le corps. Tant que le total est
   * inconnu, on annonce une page de plus que ce qui est chargé pour que le
   * défilement puisse continuer.
   */
  getVirtualRowCount(): number {
    if (this.rowCount != null) return this.rowCount
    const lastLoaded = Math.max(-1, ...Array.from(this.blocks.keys()))
    return (lastLoaded + 2) * this.opts.blockSize
  }

  getRow(index: number): TRow | undefined {
    const blockIndex = Math.floor(index / this.opts.blockSize)
    const block = this.blocks.get(blockIndex)
    if (!block) return undefined
    block.touchedAt = ++this.clock
    if (block.status !== 'loaded') return undefined
    return block.rows[index - blockIndex * this.opts.blockSize]
  }

  isRowLoading(index: number): boolean {
    const blockIndex = Math.floor(index / this.opts.blockSize)
    const block = this.blocks.get(blockIndex)
    return !block || block.status === 'loading'
  }

  /** Lignes chargées, dans l'ordre d'affichage, trous exclus. */
  getLoadedRows(): TRow[] {
    const out: TRow[] = []
    const indexes = Array.from(this.blocks.keys()).sort((a, b) => a - b)
    for (const i of indexes) {
      const block = this.blocks.get(i)!
      if (block.status === 'loaded') out.push(...block.rows)
    }
    return out
  }

  /** Garantit le chargement des blocs couvrant `[start, end)`. */
  ensureRange(start: number, end: number): void {
    const { blockSize } = this.opts
    const first = Math.max(0, Math.floor(start / blockSize))
    const last = Math.floor(Math.max(start, end - 1) / blockSize)
    for (let i = first; i <= last; i++) {
      if (this.rowCount != null && i * blockSize >= this.rowCount) break
      this.loadBlock(i)
    }
    this.evict()
  }

  private loadBlock(blockIndex: number): void {
    const existing = this.blocks.get(blockIndex)
    if (existing && existing.status !== 'failed') {
      existing.touchedAt = ++this.clock
      return
    }

    const { blockSize, datasource } = this.opts
    const controller = new AbortController()
    const block: Block<TRow> = {
      index: blockIndex,
      status: 'loading',
      rows: [],
      touchedAt: ++this.clock,
      controller,
    }
    this.blocks.set(blockIndex, block)

    const generation = this.generation
    const request: DataRequest = {
      ...this.requestContext,
      startRow: blockIndex * blockSize,
      endRow: (blockIndex + 1) * blockSize,
      signal: controller.signal,
    }

    datasource.getRows(request).then(
      (response) => {
        if (generation !== this.generation) return
        block.status = 'loaded'
        block.rows = response.rows ?? []
        block.controller = undefined

        if (response.rowCount != null) {
          this.rowCount = response.rowCount
        } else if (block.rows.length < blockSize) {
          // Dernier bloc partiel : on en déduit le total sans que le serveur le donne.
          this.rowCount = request.startRow + block.rows.length
        }
        this.opts.onChange()
      },
      (error) => {
        if (generation !== this.generation) return
        if ((error as Error)?.name === 'AbortError') return
        block.status = 'failed'
        block.error = error
        block.controller = undefined
        this.opts.onError(error)
        this.opts.onChange()
      },
    )
  }

  /** Évince les blocs les moins récemment consultés au-delà du plafond. */
  private evict(): void {
    const { maxBlocks } = this.opts
    if (this.blocks.size <= maxBlocks) return
    const sorted = Array.from(this.blocks.values())
      .filter(b => b.status === 'loaded')
      .sort((a, b) => a.touchedAt - b.touchedAt)
    let toDrop = this.blocks.size - maxBlocks
    for (const block of sorted) {
      if (toDrop-- <= 0) break
      this.blocks.delete(block.index)
    }
  }

  /**
   * Jette tout et annule les requêtes en vol. À appeler dès que le tri, les
   * filtres ou la recherche changent : les index absolus ne veulent plus rien
   * dire.
   */
  invalidate(): void {
    this.generation++
    for (const block of this.blocks.values()) block.controller?.abort()
    this.blocks.clear()
    this.rowCount = null
  }

  /** Recharge sans perdre le total connu (rafraîchissement en place). */
  refresh(): void {
    const previousCount = this.rowCount
    this.invalidate()
    this.rowCount = previousCount
  }

  destroy(): void {
    this.generation++
    for (const block of this.blocks.values()) block.controller?.abort()
    this.blocks.clear()
  }

  /**
   * Parcourt tout le jeu filtré, page par page — utilisé par l'export.
   * Court-circuite le cache : les pages sont plus grosses et non conservées.
   */
  async *iterateAll(pageSize: number, maxRows: number): AsyncGenerator<TRow[], void, void> {
    let offset = 0
    for (;;) {
      const end = Math.min(offset + pageSize, maxRows)
      if (end <= offset) return
      const response = await this.opts.datasource.getRows({
        ...this.requestContext,
        startRow: offset,
        endRow: end,
      })
      const rows = response.rows ?? []
      if (rows.length === 0) return
      yield rows
      offset += rows.length
      // Page incomplète = fin du jeu, même si le serveur n'annonce aucun total.
      if (rows.length < end - (offset - rows.length)) return
      if (response.rowCount != null && offset >= response.rowCount) return
      if (offset >= maxRows) return
    }
  }
}
