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

  /**
   * Racine où monter les éléments flottants — menus, popovers, bulles.
   *
   * Ils vivent hors du conteneur de la grille pour ne pas être rognés par son
   * `overflow`. Mais quand la grille est dans un shadow DOM, `document.body`
   * les place hors de portée de la feuille de styles : ils s'affichent alors
   * sans aucune mise en forme. On monte donc dans la racine de la grille, qui
   * est le shadow root le cas échéant, et `document.body` sinon.
   */
  portal(): HTMLElement | ShadowRoot

  /** Redessine l'en-tête et le corps sans refaire de requête. */
  requestRender(): void
  /** Le tri ou les filtres ont changé : le cache est invalidé et on repart du haut. */
  reload(): void
  /** Notifie l'hôte d'un changement d'état persistable. */
  emitState(): void

  /**
   * Encadre un redimensionnement à la souris.
   *
   * Entre les deux, un changement de largeur ne redessine plus : il ne fait
   * que réappliquer la géométrie aux cellules existantes. Sans cela, chaque
   * pixel parcouru reconstruisait l'en-tête — donc la poignée qu'on tient —
   * et repeuplait tout le corps.
   */
  beginColumnResize(): void
  endColumnResize(): void

  /** Valeurs distinctes d'une colonne, pour un filtre `set`. */
  fetchSetValues(columnId: string): Promise<SetFilterOption[]>

  /**
   * Fabrique la case « tout sélectionner » de l'en-tête. Absent quand la
   * sélection multiple n'est pas active.
   */
  selectAllCheckbox?: () => HTMLElement
}
