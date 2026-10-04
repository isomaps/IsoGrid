import type { AnyRow } from './types'

/**
 * Réorganisation des lignes au glisser-déposer.
 *
 * La grille ne déplace JAMAIS la donnée elle-même : elle décrit l'intention
 * (quelle ligne, entre quelles voisines, dans quel groupe) et la remet à
 * l'hôte, qui persiste — ou refuse. C'est le même contrat asynchrone que
 * l'édition en cellule : une promesse rejetée annule tout, et la grille
 * recharge ses données une fois la promesse résolue.
 *
 * Pourquoi ce partage des rôles : l'ordre des lignes est une donnée MÉTIER
 * (un numéro d'ordre en base, le plus souvent), pas un état d'affichage. La
 * grille ne sait ni comment il se stocke, ni qui a le droit de le changer.
 */

/**
 * Identifiant de la colonne poignée.
 *
 * Comme les autres colonnes internes, c'est une vraie colonne du modèle :
 * épinglage, largeur et recyclage fonctionnent sans traitement particulier.
 */
export const DRAG_COLUMN_ID = '__isg_drag__'

/** Une ligne a été déposée ailleurs. */
export interface RowMoveEvent<TRow = AnyRow> {
  /** La ligne déplacée. */
  row: TRow
  rowId: string
  /** La ligne qui la précédera — `null` : en tête (de la liste ou du groupe). */
  before: TRow | null
  /** La ligne qui la suivra — `null` : en queue (de la liste ou du groupe). */
  after: TRow | null
  /**
   * Valeur de la colonne de groupage pour le groupe de DESTINATION, `null`
   * hors groupage. En groupage serveur, des voisines non chargées peuvent
   * valoir `null` : `groupKey` reste alors le seul repère fiable.
   */
  groupKey: unknown
  /** Valeur du groupe de DÉPART, `null` hors groupage. */
  fromGroupKey: unknown
  /** Colonne de groupage en vigueur, `null` hors groupage. */
  groupColumnId: string | null
}

/** Une ligne de groupe a été déposée entre deux autres groupes — ou SUR un
    autre groupe (`intoKey`), pour les hôtes dont les groupes s'emboîtent. */
export interface GroupMoveEvent {
  /** Valeur du groupe déplacé. */
  key: unknown
  /** Valeur du groupe qui le précédera — `null` : en tête. */
  beforeKey: unknown
  /** Valeur du groupe qui le suivra — `null` : en queue. */
  afterKey: unknown
  /**
   * Le groupe a été déposé SUR la barre d'un autre (tiers central de sa
   * hauteur) : sa valeur — l'hôte en fait un parent, ou refuse. `null` pour
   * un dépôt entre deux barres. `beforeKey`/`afterKey` sont alors `null`.
   */
  intoKey?: unknown
  /** Colonne de groupage en vigueur. */
  columnId: string
}

export interface RowReorderOptions<TRow = AnyRow> {
  /**
   * Une ligne a été déposée. Retourner une promesse fait attendre la grille ;
   * un rejet annule le geste et affiche le message de l'erreur. Après
   * résolution, la grille recharge ses données en conservant le défilement —
   * en mode client, l'hôte doit donc avoir réordonné son tableau de lignes.
   */
  onRowMove: (event: RowMoveEvent<TRow>) => void | Promise<void>
  /**
   * Une ligne de GROUPE a été déposée entre deux autres groupes. Absent, les
   * groupes ne se déplacent pas. Même contrat de promesse que `onRowMove`.
   * Limité à un seul niveau de groupage.
   */
  onGroupMove?: (event: GroupMoveEvent) => void | Promise<void>
  /** La ligne peut-elle être saisie ? `false` masque sa poignée. */
  canDrag?: (row: TRow) => boolean
  /**
   * La colonne métier qui PORTE l'ordre des lignes. Un tri croissant sur
   * cette seule colonne affiche l'ordre canonique : il ne gèle pas les
   * poignées, contrairement à tout autre tri (décroissant compris — l'ordre
   * affiché serait l'inverse de l'ordre métier, et le dépôt mentirait).
   */
  orderColumn?: string
  /** Largeur de la colonne poignée. Défaut : 36. */
  width?: number
}
