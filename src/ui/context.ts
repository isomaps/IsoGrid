import type { ColumnModel } from '../core/table'
import type { Translator } from '../core/i18n'
import type { AnyRow, IconName, IsoGridApi, IsoGridOptions, SetFilterOption } from '../core/types'

/**
 * Contexte interne partagé par les modules d'interface.
 *
 * Il existe pour éviter que header, sidebar et filtres dépendent directement
 * de la classe `IsoGrid` — sans quoi tout devient circulaire.
 *
 * Volontairement non générique : l'interface ne lit jamais une ligne de façon
 * typée, elle passe par les `ColumnDef`. Rendre le contexte générique
 * propagerait `TRow` dans chaque module pour ne rien apporter, et la variance
 * des rappels (`valueFormatter`, `cellRenderer`) ferait échouer le typage.
 */
export interface GridContext {
  columns: ColumnModel
  t: Translator
  options: IsoGridOptions<AnyRow>
  api: IsoGridApi<AnyRow>

  icon(name: IconName): Node

  /** Redessine l'en-tête et le corps sans refaire de requête. */
  requestRender(): void
  /** Le tri ou les filtres ont changé : le cache est invalidé et on repart du haut. */
  reload(): void
  /** Notifie l'hôte d'un changement d'état persistable. */
  emitState(): void

  /** Valeurs distinctes d'une colonne, pour un filtre `set`. */
  fetchSetValues(columnId: string): Promise<SetFilterOption[]>

  /**
   * Fabrique la case « tout sélectionner » de l'en-tête. Absent quand la
   * sélection multiple n'est pas active.
   */
  selectAllCheckbox?: () => HTMLElement
}
