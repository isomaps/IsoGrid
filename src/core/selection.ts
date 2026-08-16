/**
 * Modèle de sélection de lignes.
 *
 * Le point difficile est le mode serveur : quand la grille n'a chargé que 100
 * lignes sur 50 000, « tout sélectionner » ne peut pas énumérer des
 * identifiants qu'elle n'a jamais vus. Stocker une liste d'identifiants ne
 * marche donc que pour le mode client.
 *
 * D'où deux modes symétriques :
 *
 *  - `include` : seules les lignes listées sont sélectionnées. C'est le cas
 *    ordinaire, quand l'utilisateur coche quelques lignes.
 *  - `exclude` : TOUTES les lignes du jeu filtré sont sélectionnées, SAUF
 *    celles listées. C'est ce que produit « tout sélectionner », et ça permet
 *    ensuite de décocher trois lignes sans rien charger.
 *
 * L'état est sérialisable tel quel : c'est exactement ce qu'une action de
 * masse doit envoyer au serveur, à charge pour lui de retraduire `exclude` en
 * « la requête filtrée courante, moins ces identifiants ».
 */

/**
 * Identifiant de la colonne de cases à cocher.
 *
 * Elle est enregistrée comme une VRAIE colonne du modèle plutôt que rendue à
 * part : c'est ce qui fait que les décalages `position: sticky` des colonnes
 * épinglées restent justes sans calcul supplémentaire.
 */
export const SELECTION_COLUMN_ID = '__isg_select__'

export type SelectionMode = 'include' | 'exclude'

export interface SelectionState {
  mode: SelectionMode
  /** Identifiants concernés. Sens inversé selon `mode`. */
  ids: string[]
}

export interface SelectionSnapshot extends SelectionState {
  /**
   * Nombre de lignes sélectionnées, ou `null` si indéterminable — cas d'un
   * mode `exclude` alors que le total du jeu filtré n'est pas encore connu.
   */
  count: number | null
  /** Vrai si aucune ligne n'est sélectionnée. */
  isEmpty: boolean
  /** Vrai si toutes les lignes du jeu filtré sont sélectionnées. */
  isAll: boolean
}

/** État d'une case à cocher d'en-tête : ni cochée, partielle, ou cochée. */
export type HeaderCheckboxState = 'none' | 'some' | 'all'

export class SelectionModel {
  private mode: SelectionMode = 'include'
  private ids = new Set<string>()

  constructor(private onChange: () => void) {}

  /* -------------------------------------------------------------------- */
  /* Lecture                                                               */
  /* -------------------------------------------------------------------- */

  isSelected(id: string): boolean {
    return this.mode === 'include' ? this.ids.has(id) : !this.ids.has(id)
  }

  getState(): SelectionState {
    return { mode: this.mode, ids: Array.from(this.ids) }
  }

  /**
   * @param totalRows total du jeu filtré, `null` s'il n'est pas encore connu.
   */
  getSnapshot(totalRows: number | null): SelectionSnapshot {
    const state = this.getState()

    if (this.mode === 'include') {
      return {
        ...state,
        count: this.ids.size,
        isEmpty: this.ids.size === 0,
        isAll: totalRows != null && totalRows > 0 && this.ids.size === totalRows,
      }
    }

    // exclude : sélection = total − exclus
    const count = totalRows == null ? null : Math.max(0, totalRows - this.ids.size)
    return {
      ...state,
      count,
      isEmpty: count === 0,
      isAll: this.ids.size === 0,
    }
  }

  headerState(totalRows: number | null): HeaderCheckboxState {
    const snap = this.getSnapshot(totalRows)
    if (snap.isAll) return 'all'
    if (snap.isEmpty) return 'none'
    return 'some'
  }

  /* -------------------------------------------------------------------- */
  /* Écriture                                                              */
  /* -------------------------------------------------------------------- */

  setSelected(id: string, selected: boolean): void {
    const changed = this.mode === 'include'
      ? (selected ? this.add(id) : this.remove(id))
      // En mode exclude la liste est celle des EXCLUS : la logique s'inverse.
      : (selected ? this.remove(id) : this.add(id))

    if (changed) this.onChange()
  }

  toggle(id: string): void {
    this.setSelected(id, !this.isSelected(id))
  }

  /** Sélection exclusive — pour `rowSelection: 'single'`. */
  selectOnly(id: string): void {
    this.mode = 'include'
    this.ids = new Set([id])
    this.onChange()
  }

  /** Sélectionne une plage d'identifiants (Maj-clic sur les lignes chargées). */
  selectRange(ids: string[], selected: boolean): void {
    let changed = false
    for (const id of ids) {
      const before = this.isSelected(id)
      if (before === selected) continue
      if (this.mode === 'include') {
        selected ? this.ids.add(id) : this.ids.delete(id)
      } else {
        selected ? this.ids.delete(id) : this.ids.add(id)
      }
      changed = true
    }
    if (changed) this.onChange()
  }

  /**
   * Sélectionne l'intégralité du jeu filtré, y compris les lignes jamais
   * chargées. C'est tout l'intérêt du mode `exclude`.
   */
  selectAll(): void {
    this.mode = 'exclude'
    this.ids.clear()
    this.onChange()
  }

  clear(): void {
    if (this.mode === 'include' && this.ids.size === 0) return
    this.mode = 'include'
    this.ids.clear()
    this.onChange()
  }

  /** Restaure un état, sans déclencher de notification (montage initial). */
  restore(state: SelectionState | null | undefined): void {
    this.mode = state?.mode ?? 'include'
    this.ids = new Set(state?.ids ?? [])
  }

  private add(id: string): boolean {
    if (this.ids.has(id)) return false
    this.ids.add(id)
    return true
  }

  private remove(id: string): boolean {
    return this.ids.delete(id)
  }
}
