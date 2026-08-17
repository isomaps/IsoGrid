import type { ToolbarOptions } from '../core/types'
import type { GridContext } from './context'
import { NS, debounce, el, onDismiss, positionFloating } from './dom'

/**
 * Barre d'outils.
 *
 * Disposition calquée sur les tables Filament, pour qu'une grille posée dans
 * un back-office existant ne détonne pas : tout est groupé à droite —
 * recherche, export, puis les deux entrées de panneau (filtres, colonnes).
 * C'est aussi pour ça que la bande d'onglets verticale du panneau latéral est
 * désactivée par défaut : deux points d'entrée pour la même chose, c'est un
 * de trop.
 */
export class Toolbar {
  readonly element: HTMLElement
  private quickInput?: HTMLInputElement
  private right!: HTMLElement

  constructor(
    private ctx: GridContext,
    private options: ToolbarOptions,
    private onOpenPanel: (panel: 'columns' | 'filters') => void,
  ) {
    this.element = el('div', { class: `${NS}-toolbar` })
    this.render()
  }

  render(): void {
    const t = this.ctx.t
    this.element.replaceChildren()

    const left = el('div', { class: `${NS}-toolbar-left` })
    const slot = this.options.slot?.()
    if (slot) left.append(slot)

    this.right = el('div', { class: `${NS}-toolbar-right` })

    if (this.options.quickFilter !== false) {
      const debounced = debounce((value: string) => {
        this.ctx.api.setQuickFilter(value)
      }, 300)

      this.quickInput = el('input', {
        class: `${NS}-input ${NS}-quick-filter`,
        attrs: {
          type: 'search',
          value: this.ctx.columns.getQuickFilter(),
          placeholder: this.options.quickFilterPlaceholder ?? t.t('quickFilterPlaceholder'),
          'aria-label': t.t('search'),
        },
        on: {
          input: (e: Event) => debounced((e.target as HTMLInputElement).value),
          keydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              debounced.cancel()
              this.ctx.api.setQuickFilter((e.target as HTMLInputElement).value)
            }
          },
        },
      })
      this.right.append(el('div', {
        class: `${NS}-search-box`,
        children: [this.ctx.icon('search'), this.quickInput],
      }))
    }

    // Opt-IN et non opt-out : l'export vit dans le menu du clic droit, aux
    // côtés des copies. Un second point d'entrée dans la barre d'outils la
    // charge sans rien ajouter.
    if (this.options.exportButton === true) {
      this.right.append(el('button', {
        class: `${NS}-btn`,
        attrs: { type: 'button', 'aria-haspopup': 'menu' },
        children: [this.ctx.icon('export'), el('span', { text: t.t('export') })],
        on: {
          click: (e: MouseEvent) => this.openExportMenu(e.currentTarget as HTMLElement),
        },
      }))
    }

    if (this.options.filtersButton !== false) {
      const activeCount = this.ctx.columns.getActiveFilterCount()
      this.right.append(el('button', {
        class: `${NS}-icon-btn ${NS}-panel-btn${activeCount > 0 ? ` ${NS}-active` : ''}`,
        attrs: { type: 'button', title: t.t('filters'), 'aria-label': t.t('filters') },
        children: [
          this.ctx.icon('filter'),
          // Le compteur est toujours rendu, y compris à zéro : c'est ce que
          // fait Filament, et cela évite que la barre se réorganise dès qu'un
          // filtre est posé.
          el('span', {
            class: `${NS}-count-badge${activeCount > 0 ? ` ${NS}-active` : ''}`,
            text: String(activeCount),
          }),
        ],
        on: { click: () => this.onOpenPanel('filters') },
      }))
    }

    if (this.options.columnsButton !== false) {
      this.right.append(el('button', {
        class: `${NS}-icon-btn ${NS}-panel-btn`,
        attrs: { type: 'button', title: t.t('columns'), 'aria-label': t.t('columns') },
        children: [this.ctx.icon('columns')],
        on: { click: () => this.onOpenPanel('columns') },
      }))
    }

    this.element.append(left, this.right)
  }

  /** Remet la valeur affichée en phase avec l'état (restauration, `setState`). */
  syncQuickFilter(): void {
    if (this.quickInput && this.quickInput.value !== this.ctx.columns.getQuickFilter()) {
      this.quickInput.value = this.ctx.columns.getQuickFilter()
    }
  }

  /** Met à jour le compteur de filtres sans reconstruire la barre (ni perdre le focus). */
  syncFilterCount(): void {
    const badge = this.right?.querySelector<HTMLElement>(`.${NS}-count-badge`)
    if (!badge) return
    const count = this.ctx.columns.getActiveFilterCount()
    badge.textContent = String(count)
    badge.classList.toggle(`${NS}-active`, count > 0)
    badge.parentElement?.classList.toggle(`${NS}-active`, count > 0)
  }

  private openExportMenu(anchor: HTMLElement): void {
    const t = this.ctx.t
    const menu = el('div', { class: `${NS}-popover ${NS}-menu`, attrs: { role: 'menu' } })
    let dispose = () => {}
    const close = () => { dispose(); menu.remove() }

    menu.append(
      el('button', {
        class: `${NS}-menu-item`,
        attrs: { type: 'button', role: 'menuitem' },
        children: [this.ctx.icon('excel'), el('span', { text: t.t('exportExcel') })],
        on: { click: () => { close(); void this.ctx.api.exportExcel() } },
      }),
      el('button', {
        class: `${NS}-menu-item`,
        attrs: { type: 'button', role: 'menuitem' },
        children: [this.ctx.icon('csv'), el('span', { text: t.t('exportCsv') })],
        on: { click: () => { close(); void this.ctx.api.exportCsv() } },
      }),
    )

    document.body.append(menu)
    positionFloating(anchor, menu)
    dispose = onDismiss(menu, close)
    menu.querySelector<HTMLElement>('button')?.focus()
  }
}
