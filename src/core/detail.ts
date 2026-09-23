import type { AnyRow } from './types'

/**
 * Lignes de détail dépliables (« master-detail »).
 *
 * Une ligne maître se déplie sur un panneau libre : sous-grille, fiche,
 * formulaire. Le contenu est fourni par l'hôte et vient souvent d'un appel
 * réseau, donc sa hauteur n'est PAS connue au moment où on l'insère — et elle
 * change quand la réponse arrive.
 *
 * C'est ce qui casse la virtualisation naïve : elle suppose des lignes de
 * hauteur égale, donc `offset = index × hauteur`. Ici il faut mesurer, puis
 * recalculer les décalages. `DetailLayout` s'en charge en gardant les seules
 * exceptions — les quelques lignes dépliées — plutôt qu'un tableau de
 * hauteurs long comme le jeu de données.
 */

export const DETAIL_COLUMN_ID = '__isg_detail__'

/** Colonne d'actions de ligne, épinglée à droite. */
export const ROW_ACTIONS_COLUMN_ID = '__isg_actions__'

export interface DetailContext<TRow = AnyRow> {
  row: TRow
  rowIndex: number
  /**
   * À appeler quand le contenu a fini de changer de taille et que la mesure
   * automatique ne suffit pas. Rarement utile : un `ResizeObserver` suit déjà
   * le panneau.
   */
  invalidateHeight: () => void
}

export interface MasterDetailOptions<TRow = AnyRow> {
  /** Construit le contenu du panneau. Peut être asynchrone via le DOM retourné. */
  renderer: (ctx: DetailContext<TRow>) => Node | string

  /**
   * Hauteur du panneau. `'auto'` (défaut) mesure le contenu réel et suit ses
   * changements de taille — indispensable quand il est chargé en réseau.
   */
  height?: number | 'auto'

  /** Hauteur affichée tant que le contenu n'est pas mesuré. Défaut : 120. */
  provisionalHeight?: number

  /** Quelles lignes peuvent se déplier. Défaut : toutes. */
  isRowMaster?: (row: TRow, rowIndex: number) => boolean

  /** Largeur de la colonne de chevron. Défaut : 40. */
  columnWidth?: number
}

/**
 * Calcule les décalages verticaux quand des panneaux s'intercalent entre les
 * lignes.
 *
 * Un panneau S'AJOUTE sous sa ligne maître, il ne la remplace pas : la ligne
 * garde sa hauteur normale, et le panneau décale tout ce qui suit de sa
 * propre hauteur entière. Traiter le panneau comme une hauteur de ligne
 * substituée décalerait tout d'une ligne trop peu, et la ligne suivante
 * chevaucherait le panneau.
 *
 * On ne stocke que les exceptions : un tableau de 50 000 hauteurs coûterait
 * une passe complète à chaque dépliage, alors qu'on n'a jamais qu'une poignée
 * de panneaux ouverts.
 */
export class DetailLayout {
  /**
   * Hauteurs exceptionnelles, triées par index.
   *
   * `position: 'after'` = un panneau de détail, qui se place SOUS sa ligne
   * maître et ne la décale donc pas. `position: 'before'` = un intertitre de
   * section, qui se place AU-DESSUS de sa ligne et la décale, elle comprise.
   * Les deux cohabitent : une même ligne peut ouvrir une section et porter un
   * panneau.
   */
  private entries: Array<{ index: number; height: number; position: 'before' | 'after' }> = []

  constructor(private rowHeight: number) {}

  setRowHeight(height: number): void {
    this.rowHeight = height
  }

  reset(): void {
    this.entries = []
  }

  /** Déclare un panneau à un index d'affichage donné. */
  set(index: number, height: number): void {
    const found = this.entries.find(e => e.index === index && e.position === 'after')
    if (found) { found.height = height; return }
    this.entries.push({ index, height, position: 'after' })
    this.entries.sort((a, b) => a.index - b.index || (a.position === 'before' ? -1 : 1))
  }

  /** Déclare un intertitre AU-DESSUS de la ligne d'index donné. */
  setBefore(index: number, height: number): void {
    const found = this.entries.find(e => e.index === index && e.position === 'before')
    if (found) { found.height = height; return }
    this.entries.push({ index, height, position: 'before' })
    this.entries.sort((a, b) => a.index - b.index || (a.position === 'before' ? -1 : 1))
  }

  /** Oublie tous les intertitres, sans toucher aux panneaux ouverts. */
  clearBefore(): void {
    this.entries = this.entries.filter(e => e.position !== 'before')
  }

  has(index: number): boolean {
    return this.entries.some(e => e.index === index && e.position === 'after')
  }

  /** Hauteur du panneau attaché à cette ligne, 0 s'il n'y en a pas. */
  getPanelHeight(index: number): number {
    return this.entries.find(e => e.index === index && e.position === 'after')?.height ?? 0
  }

  /** Hauteur de l'intertitre posé au-dessus de cette ligne, 0 sinon. */
  getHeaderHeight(index: number): number {
    return this.entries.find(e => e.index === index && e.position === 'before')?.height ?? 0
  }

  /**
   * Hauteur ajoutée par les panneaux situés AVANT `index`.
   *
   * Le panneau de la ligne `index` elle-même n'y entre pas : il se place sous
   * elle, donc il ne la décale pas.
   */
  private surplusBefore(index: number): number {
    let sum = 0
    for (const e of this.entries) {
      if (e.index > index) break
      // Un panneau de la ligne elle-même ne la décale pas ; son intertitre, si.
      if (e.index === index && e.position === 'after') continue
      sum += e.height
    }
    return sum
  }

  offsetOf(index: number): number {
    return index * this.rowHeight + this.surplusBefore(index)
  }

  totalHeight(rowCount: number): number {
    let sum = rowCount * this.rowHeight
    for (const e of this.entries) sum += e.height
    return sum
  }

  /** Premier index dont le bas dépasse `scrollTop`. */
  indexAt(scrollTop: number, rowCount: number): number {
    if (this.entries.length === 0) {
      return Math.max(0, Math.min(rowCount, Math.floor(scrollTop / this.rowHeight)))
    }

    // On avance d'exception en exception ; dès que le point cherché tombe
    // dans une zone de lignes régulières, une division conclut.
    let offset = 0
    let index = 0
    for (const e of this.entries) {
      if (e.position === 'before') {
        // Lignes régulières AVANT la ligne coiffée par l'intertitre.
        const regular = (e.index - index) * this.rowHeight
        if (scrollTop < offset + regular) {
          return index + Math.floor((scrollTop - offset) / this.rowHeight)
        }
        offset += regular
        index = e.index
        // Un point dans l'intertitre désigne la première ligne de sa section.
        if (scrollTop < offset + e.height) return e.index
        offset += e.height
        continue
      }

      // Panneau : zone régulière jusqu'à la ligne maître INCLUSE.
      const regular = (e.index - index + 1) * this.rowHeight
      if (scrollTop < offset + regular) {
        return index + Math.floor((scrollTop - offset) / this.rowHeight)
      }
      offset += regular
      index = e.index + 1
      // Tout point qui tombe dans le panneau désigne encore sa ligne maître.
      if (scrollTop < offset + e.height) return e.index
      offset += e.height
    }
    return Math.min(rowCount, index + Math.floor((scrollTop - offset) / this.rowHeight))
  }
}

/** État d'ouverture des détails, par identifiant de ligne. */
export class DetailModel {
  private open = new Set<string>()

  isOpen(rowId: string): boolean {
    return this.open.has(rowId)
  }

  toggle(rowId: string): boolean {
    if (this.open.has(rowId)) { this.open.delete(rowId); return false }
    this.open.add(rowId)
    return true
  }

  close(rowId: string): void {
    this.open.delete(rowId)
  }

  closeAll(): void {
    this.open.clear()
  }

  getOpen(): string[] {
    return Array.from(this.open)
  }

  restore(ids: string[] | undefined): void {
    this.open = new Set(ids ?? [])
  }
}
