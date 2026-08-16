import type {
  AnyRow, DataRequest, DataResponse, Datasource, SetFilterOption,
} from '../core/types'

/**
 * Source de données adossée à un composant Livewire.
 *
 * Au lieu d'exposer une route HTTP dédiée — qu'il faudrait déclarer, protéger
 * et maintenir en parallèle de la page — la grille appelle directement des
 * méthodes du composant Livewire qui la porte. On hérite ainsi de son
 * contexte : session, utilisateur authentifié, policies Filament, tenant
 * courant. Rien à sécuriser en plus.
 *
 * Côté PHP, le composant utilise le trait `InteractsWithIsoGrid`, qui fournit
 * `isoGridRows()` et `isoGridSetValues()`.
 */

/** Surface minimale de l'objet `$wire` de Livewire 3 que nous utilisons. */
export interface WireProxy {
  call(method: string, ...params: unknown[]): Promise<unknown>
}

export interface LivewireDatasourceOptions {
  /**
   * Le `$wire` du composant. Accepter une fonction permet de résoudre le
   * proxy au premier appel : au moment où l'on construit la grille, Livewire
   * n'a pas toujours fini d'initialiser le composant.
   */
  wire: WireProxy | (() => WireProxy | undefined)
  /** Méthode PHP servant les lignes. Défaut : `isoGridRows`. */
  rowsMethod?: string
  /** Méthode PHP servant les valeurs distinctes. Défaut : `isoGridSetValues`. */
  setValuesMethod?: string
}

/** Retire `signal` : un AbortSignal n'est pas sérialisable vers PHP. */
function serialize(request: DataRequest): Record<string, unknown> {
  return {
    startRow: request.startRow,
    endRow: request.endRow,
    sort: request.sort,
    filters: request.filters,
    quickFilter: request.quickFilter,
    columns: request.columns,
  }
}

export function createLivewireDatasource<TRow = AnyRow>(
  options: LivewireDatasourceOptions,
): Datasource<TRow> {
  const resolveWire = (): WireProxy => {
    const wire = typeof options.wire === 'function' ? options.wire() : options.wire
    if (!wire) {
      throw new Error('IsoGrid: le composant Livewire n\'est pas encore initialisé ($wire indisponible).')
    }
    return wire
  }

  const rowsMethod = options.rowsMethod ?? 'isoGridRows'
  const setValuesMethod = options.setValuesMethod ?? 'isoGridSetValues'

  /**
   * Livewire sérialise les appels d'un même composant et n'expose aucun
   * mécanisme d'annulation. Une requête devenue obsolète ne peut donc pas
   * être coupée en vol : on la laisse revenir et on jette son résultat, ce
   * qui reproduit côté client la garantie qu'apporte `AbortSignal` en HTTP.
   */
  const callAbortable = async (method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (signal?.aborted) throw abortError()
    const result = await resolveWire().call(method, payload)
    if (signal?.aborted) throw abortError()
    return result
  }

  return {
    async getRows(request: DataRequest): Promise<DataResponse<TRow>> {
      const raw = await callAbortable(rowsMethod, serialize(request), request.signal) as Record<string, unknown>
      return {
        rows: (raw?.rows ?? []) as TRow[],
        rowCount: (raw?.rowCount ?? null) as number | null,
      }
    },

    async getSetValues(columnId, request): Promise<SetFilterOption[]> {
      const raw = await callAbortable(setValuesMethod, {
        column: columnId,
        filters: request.filters,
        quickFilter: request.quickFilter,
      }, request.signal) as unknown

      const values = (raw as Record<string, unknown>)?.values ?? raw
      return ((values ?? []) as unknown[]).map((v): SetFilterOption => (
        v !== null && typeof v === 'object'
          ? (v as SetFilterOption)
          : { value: v as SetFilterOption['value'] }
      ))
    },
  }
}

/** Erreur reconnue par le cache de blocs, qui l'ignore silencieusement. */
function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}
