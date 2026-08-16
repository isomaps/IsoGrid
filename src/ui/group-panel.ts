import type { GridContext } from './context'
import { NS, el } from './dom'

/**
 * Zone de dépôt du groupage.
 *
 * Reprend le principe du « row group panel » d'AG Grid : on y fait glisser un
 * en-tête de colonne pour grouper, et les niveaux s'y affichent comme un fil
 * d'Ariane réordonnable. C'est la seule affordance qui rende le groupage
 * découvrable — sans elle, il faut savoir qu'un menu de colonne le propose.
 */
export class GroupPanel {
  readonly element: HTMLElement
  /** Index de survol pendant un glisser, pour l'insertion entre deux jetons. */
  private dropIndex: number | null = null

  constructor(
    private ctx: GridContext,
    private mode: true | 'whenGrouping',
  ) {
    this.element = el('div', { class: `${NS}-group-panel` })
    this.wireDropZone()
    this.render()
  }

  render(): void {
    const t = this.ctx.t
    const groups = this.ctx.api.getRowGroup()

    // En mode `whenGrouping`, la zone disparaît tant qu'aucun groupe n'existe :
    // elle ne coûte alors pas de hauteur sur les grilles qui ne groupent pas.
    const hidden = this.mode === 'whenGrouping' && groups.length === 0
    this.element.classList.toggle(`${NS}-hidden`, hidden)
    if (hidden) { this.element.replaceChildren(); return }

    this.element.replaceChildren()
    this.element.append(this.ctx.icon('grip'))

    if (groups.length === 0) {
      this.element.append(el('span', {
        class: `${NS}-group-panel-empty`,
        text: t.t('groupPanelEmpty'),
      }))
      return
    }

    groups.forEach((columnId, index) => {
      if (index > 0) {
        this.element.append(el('span', { class: `${NS}-group-chevron`, children: [this.ctx.icon('chevron-right')] }))
      }
      this.element.append(this.buildChip(columnId, index))
    })

    this.element.append(el('button', {
      class: `${NS}-btn ${NS}-btn-ghost ${NS}-btn-sm ${NS}-group-clear`,
      attrs: { type: 'button' },
      text: t.t('ungroup'),
      on: { click: () => this.ctx.api.setRowGroup([]) },
    }))
  }

  private buildChip(columnId: string, index: number): HTMLElement {
    const def = this.ctx.columns.getDef(columnId)
    const label = this.ctx.t.header(def?.header ?? columnId)

    const chip = el('div', {
      class: `${NS}-group-chip`,
      attrs: { draggable: 'true', 'data-group-index': index, title: label },
      children: [
        el('span', { class: `${NS}-group-chip-label`, text: label }),
        el('button', {
          class: `${NS}-icon-btn ${NS}-group-chip-remove`,
          attrs: { type: 'button', 'aria-label': this.ctx.t.t('ungroup') },
          children: [this.ctx.icon('close')],
          on: {
            click: (e: MouseEvent) => {
              e.stopPropagation()
              this.ctx.api.removeRowGroup(columnId)
            },
          },
        }),
      ],
    })

    // Réordonner les niveaux : l'ordre des jetons EST l'ordre de groupage.
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('application/x-isogrid-group-index', String(index))
      e.dataTransfer!.effectAllowed = 'move'
      chip.classList.add(`${NS}-dragging`)
    })
    chip.addEventListener('dragend', () => chip.classList.remove(`${NS}-dragging`))

    return chip
  }

  private wireDropZone(): void {
    const panel = this.element

    panel.addEventListener('dragover', (e) => {
      e.preventDefault()
      panel.classList.add(`${NS}-drop-active`)
      this.dropIndex = this.computeDropIndex(e.clientX)
    })
    panel.addEventListener('dragleave', (e) => {
      // `dragleave` se déclenche aussi en passant au-dessus d'un enfant :
      // on ne réagit qu'en quittant réellement la zone.
      if (panel.contains(e.relatedTarget as Node)) return
      panel.classList.remove(`${NS}-drop-active`)
      this.dropIndex = null
    })

    panel.addEventListener('drop', (e) => {
      e.preventDefault()
      panel.classList.remove(`${NS}-drop-active`)
      const at = this.dropIndex
      this.dropIndex = null

      const current = this.ctx.api.getRowGroup()

      // Déplacement d'un jeton existant.
      const movedIndex = e.dataTransfer?.getData('application/x-isogrid-group-index')
      if (movedIndex) {
        const from = Number(movedIndex)
        const next = current.slice()
        const [moved] = next.splice(from, 1)
        next.splice(Math.max(0, Math.min(at ?? next.length, next.length)), 0, moved)
        this.ctx.api.setRowGroup(next)
        return
      }

      // Dépôt d'un en-tête de colonne.
      const columnId = e.dataTransfer?.getData('text/plain')
      if (!columnId || current.includes(columnId)) return
      const def = this.ctx.columns.getDef(columnId)
      if (!def || def.enableRowGroup === false) return

      const next = current.slice()
      next.splice(at ?? next.length, 0, columnId)
      this.ctx.api.setRowGroup(next)
    })
  }

  /** Position d'insertion d'après l'abscisse du curseur. */
  private computeDropIndex(x: number): number {
    const chips = [...this.element.querySelectorAll<HTMLElement>(`.${NS}-group-chip`)]
    for (let i = 0; i < chips.length; i++) {
      const rect = chips[i].getBoundingClientRect()
      if (x < rect.left + rect.width / 2) return i
    }
    return chips.length
  }
}
