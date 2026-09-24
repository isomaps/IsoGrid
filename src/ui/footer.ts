/**
 * Ligne de totaux, en pied de grille.
 *
 * Les agrégats de groupe (`aggFunc` sur une ligne de regroupement) répondent à
 * « combien pour ce sous-ensemble ». Cette ligne-ci répond à l'autre question,
 * qui vient tout aussi souvent devant un tableau de montants : « et au total ? ».
 *
 * Deux sources possibles, selon ce que la grille peut savoir :
 *
 *  - en modèle client, elle calcule sur les lignes qu'elle a ;
 *  - en modèle serveur, elle n'a qu'une fenêtre sur le jeu filtré et ne peut
 *    rien totaliser honnêtement. C'est alors l'hôte qui fournit les valeurs,
 *    via `footer.values()` — son serveur, lui, sait compter.
 *
 * Quand des lignes sont sélectionnées, les totaux basculent sur la sélection :
 * c'est le geste par lequel un utilisateur pose la question « combien font
 * ces trois-là ? », sans quitter l'écran.
 */

import type { AnyRow, ColumnDef } from '../core/types'
import type { RenderColumn } from '../core/table'
import { NS, el, getPath } from './dom'
import { aggregate, type BuiltInAggFunc } from '../core/grouping'
import type { Translator } from '../core/i18n'

export class FooterRenderer {
  readonly element: HTMLElement

  constructor(private t: Translator) {
    this.element = el('div', {
      class: `${NS}-footer-row`,
      attrs: { role: 'row' },
    })
  }

  /** Une colonne participe-t-elle aux totaux ? */
  private estAgregee(def: ColumnDef): boolean {
    return def.aggFunc != null
  }

  /**
   * Redessine le pied.
   *
   * `lignes` sont les lignes disponibles pour un calcul local ; `fournies` les
   * valeurs que l'hôte a données, qui priment toujours — lui seul sait si
   * elles portent sur le jeu entier.
   */
  render(
    colonnes: RenderColumn[],
    lignes: AnyRow[],
    fournies: Record<string, unknown> | null,
    surSelection: boolean,
  ): void {
    this.element.textContent = ''

    /* Aucune colonne à totaliser : pas de bandeau vide en bas de la grille.
       Une table sans montant ne doit pas payer une ligne pour rien. */
    const utile = colonnes.some(c => this.estAgregee(c.def))
    this.element.hidden = !utile
    if (!utile) return

    this.element.classList.toggle(`${NS}-footer-selection`, surSelection)

    for (const colonne of colonnes) {
      const def = colonne.def
      const cellule = el('div', {
        class: [
          `${NS}-footer-cell`,
          colonne.pinned ? `${NS}-pinned-${colonne.pinned}` : '',
          colonne.isLastPinnedStart ? `${NS}-pin-edge-start` : '',
          colonne.isFirstPinnedEnd ? `${NS}-pin-edge-end` : '',
          def.align ? `${NS}-align-${def.align}` : (def.type === 'number' ? `${NS}-align-right` : ''),
        ].filter(Boolean).join(' '),
        attrs: { role: 'gridcell', 'data-col-id': colonne.id },
        style: { width: `${colonne.width}px` },
      })

      if (colonne.pinned) {
        cellule.style.position = 'sticky'
        cellule.style.zIndex = '2'
        if (colonne.pinned === 'start') cellule.style.left = `${colonne.stickyOffset}px`
        else cellule.style.right = `${colonne.stickyOffset}px`
      }

      if (this.estAgregee(def)) {
        cellule.classList.add(`${NS}-footer-value`)
        const valeurs = lignes.map(l => getPath(l, def.field ?? def.id))
        const fournie = fournies ? fournies[colonne.id] : undefined

        if (Array.isArray(def.aggFunc)) {
          /* Plusieurs statistiques sur la même colonne : une ligne chacune,
             libellé court à gauche, valeur à droite — c'est ainsi qu'on les
             lit dans un pied de tableau. */
          cellule.classList.add(`${NS}-footer-multi`)
          for (const nom of def.aggFunc) {
            const brut = fournie && typeof fournie === 'object' && nom in (fournie as object)
              ? (fournie as Record<string, unknown>)[nom]
              : aggregate(valeurs, nom)
            cellule.append(el('span', {
              class: `${NS}-footer-stat`,
              children: [
                el('span', { class: `${NS}-footer-stat-label`, text: this.libelle(nom) }),
                el('span', { class: `${NS}-footer-stat-value`, text: this.formate(def, brut, nom) }),
              ],
            }))
          }
        } else if (fournie && typeof fournie === 'object' && !Array.isArray(fournie)) {
          /* Un total PAR DEVISE renvoyé par la source : une ligne par devise,
             comme les statistiques multiples. Sur une seule ligne, trois devises
             ne tiennent pas dans une colonne de montants et seraient tronquées
             — précisément la partie qu'on voulait lire. */
          cellule.classList.add(`${NS}-footer-multi`)
          for (const [cle, v] of Object.entries(fournie as Record<string, unknown>)) {
            if (typeof v !== 'number') continue
            cellule.append(el('span', {
              class: `${NS}-footer-stat`,
              children: [
                el('span', { class: `${NS}-footer-stat-label`, text: cle }),
                el('span', { class: `${NS}-footer-stat-value`, text: this.formate(def, v) }),
              ],
            }))
          }
        } else {
          const brut = fournie !== undefined ? fournie : aggregate(valeurs, def.aggFunc!)
          cellule.textContent = this.formate(def, brut)
        }
      }

      this.element.append(cellule)
    }
  }

  /** Libellé court d'un agrégat, dans la langue de la grille. */
  private libelle(nom: BuiltInAggFunc): string {
    switch (nom) {
      case 'sum': return this.t.t('aggSum')
      case 'min': return this.t.t('aggMin')
      case 'max': return this.t.t('aggMax')
      case 'avg': return this.t.t('aggAvg')
      case 'count': return this.t.t('aggCount')
      default: return ''
    }
  }

  private formate(def: ColumnDef, valeur: unknown, agg?: string): string {
    if (valeur === null || valeur === undefined || valeur === '') return ''
    if (def.footerFormatter) return def.footerFormatter(valeur, agg)

    // Un total PAR DEVISE ({ CHF: …, EUR: … }) : chaque montant avec son
    // unité, jamais additionnés entre eux.
    if (typeof valeur === 'object' && !Array.isArray(valeur)) {
      return Object.entries(valeur as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'number')
        .map(([cle, v]) => `${cle} ${this.nombre(def, v as number)}`)
        .join(' · ')
    }
    if (typeof valeur === 'number' && def.decimals != null) {
      return this.nombre(def, valeur)
    }
    if (typeof valeur === 'number') {
      /* Deux décimales au plus, et les séparateurs de la locale : un total
         sert à être lu, pas à être recopié. */
      return valeur.toLocaleString(undefined, { maximumFractionDigits: 2 })
    }
    return String(valeur)
  }

  private nombre(def: ColumnDef, v: number): string {
    // Le traducteur de la grille, pas la locale du navigateur : le pied doit
    // s'ecrire comme les cellules au-dessus (« 1 234,56 » en francais).
    const d = def.decimals ?? 2
    return this.t.number(v, { minimumFractionDigits: d, maximumFractionDigits: d })
  }
}
