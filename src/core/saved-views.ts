import type { GridState } from './types'
import { SELECTION_COLUMN_ID } from './selection'
import { GROUP_COLUMN_ID } from './grouping'
import { DETAIL_COLUMN_ID, ROW_ACTIONS_COLUMN_ID } from './detail'

/* ------------------------------------------------------------------------ */
/* Contrat                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Ce qu'une vue enregistrée retient de la grille.
 *
 * C'est l'état « de présentation » — colonnes, tri, filtres, recherche,
 * groupage — sans ce qui décrit un moment de consultation (groupes dépliés,
 * détails ouverts) : réappliquer une vue, c'est reposer une question, pas
 * revenir à l'endroit exact où l'on s'était arrêté.
 *
 * Les colonnes internes de la grille (cases de sélection, arborescence,
 * chevron de détail, actions) n'y figurent jamais : elles dépendent des
 * options de la grille, pas du choix de l'utilisateur.
 */
export interface SavedViewState {
  columnOrder: string[]
  columnVisibility: Record<string, boolean>
  columnSizing: Record<string, number>
  columnPinning: { start: string[]; end: string[] }
  sort: { id: string; desc: boolean }[]
  filters: GridState['filters']
  quickFilter: string
  rowGroup?: string[]
}

export interface SavedView {
  id: string
  name: string
  /** Visible par d'autres utilisateurs que son auteur. */
  shared: boolean
  /** L'utilisateur courant peut la modifier, la renommer, la supprimer. */
  editable: boolean
  /** Appliquée à l'ouverture de la grille. Une seule à la fois. */
  isDefault: boolean
  state: SavedViewState
}

/**
 * Stockage des vues, fourni par l'hôte.
 *
 * La grille ne sait rien de l'endroit où vivent les vues ni de qui y a
 * accès : elle demande la liste, et délègue enregistrement, suppression et
 * choix de la vue par défaut. C'est l'hôte qui décide ce que « partagée » veut
 * dire, qui peut modifier quoi (`editable`), et à qui s'applique le défaut.
 *
 * Toutes les méthodes sont asynchrones. Un rejet est affiché à l'utilisateur
 * (bulle de notification) et n'altère pas la grille.
 */
export interface SavedViewsAdapter {
  list(): Promise<SavedView[]>
  /** Sans `id` : création. Avec : mise à jour. Rend la vue telle qu'enregistrée. */
  save(view: { id?: string; name: string; shared: boolean; state: SavedViewState }): Promise<SavedView>
  remove(id: string): Promise<void>
  /** `null` : plus de vue par défaut, la grille s'ouvre sur son état d'origine. */
  setDefault(id: string | null): Promise<void>
  /** Affiche la case « partager » dans la boîte d'enregistrement. Défaut : false. */
  canShare?: boolean
  /** Libellé de la case « partager ». Défaut : libellé du catalogue. */
  sharedLabel?: string
}

/* ------------------------------------------------------------------------ */
/* Outils                                                                    */
/* ------------------------------------------------------------------------ */

const INTERNAL_COLUMNS = new Set([
  SELECTION_COLUMN_ID, GROUP_COLUMN_ID, DETAIL_COLUMN_ID, ROW_ACTIONS_COLUMN_ID,
])

export function isInternalColumn(id: string): boolean {
  return INTERNAL_COLUMNS.has(id)
}

function pick<T>(obj: Record<string, T> | undefined, keep: (id: string) => boolean): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [id, value] of Object.entries(obj ?? {})) if (keep(id)) out[id] = value
  return out
}

/** Copie profonde de l'état de grille, réduite à ce qu'une vue retient. */
export function toSavedViewState(state: GridState): SavedViewState {
  const keep = (id: string) => !isInternalColumn(id)
  return JSON.parse(JSON.stringify({
    columnOrder: state.columnOrder.filter(keep),
    columnVisibility: pick(state.columnVisibility, keep),
    columnSizing: pick(state.columnSizing, keep),
    columnPinning: {
      start: state.columnPinning.start.filter(keep),
      end: state.columnPinning.end.filter(keep),
    },
    sort: state.sort.filter(s => keep(s.id)).map(s => ({ id: s.id, desc: s.desc })),
    filters: pick(state.filters, keep),
    quickFilter: state.quickFilter ?? '',
    rowGroup: (state.rowGroup ?? []).slice(),
  })) as SavedViewState
}

/** Sérialisation à clés triées : deux objets égaux donnent le même texte. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    }
    return v
  })
}

/**
 * Forme canonique d'un état, pour comparer deux vues.
 *
 * Deux états qui s'AFFICHENT pareil doivent être égaux, même s'ils ne
 * s'écrivent pas pareil : un ordre vide et l'ordre de déclaration matérialisé,
 * une visibilité absente et `true`, une largeur arrondie ou non. Sans cela,
 * une vue fraîchement appliquée se dirait « modifiée ».
 */
function canonical(state: SavedViewState, columnIds: string[]): string {
  const known = new Set(columnIds)
  const keep = (id: string) => known.has(id)
  const order = (state.columnOrder ?? []).filter(keep)
  const sizing = pick(state.columnSizing, keep)
  return stable({
    order: order.concat(columnIds.filter(id => !order.includes(id))),
    hidden: columnIds.filter(id => state.columnVisibility?.[id] === false).sort(),
    sizing: Object.fromEntries(Object.entries(sizing).map(([k, v]) => [k, Math.round(Number(v))])),
    start: (state.columnPinning?.start ?? []).filter(keep),
    end: (state.columnPinning?.end ?? []).filter(keep),
    sort: (state.sort ?? []).filter(s => keep(s.id)).map(s => [s.id, !!s.desc]),
    filters: pick(state.filters, keep),
    quick: (state.quickFilter ?? '').trim(),
    group: state.rowGroup ?? [],
  })
}

/** Les deux états produisent-ils la même grille, pour ces colonnes ? */
export function sameViewState(a: SavedViewState, b: SavedViewState, columnIds: string[]): boolean {
  return canonical(a, columnIds) === canonical(b, columnIds)
}
