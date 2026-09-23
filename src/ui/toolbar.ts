import type { ColumnFilterModel, ToolbarTag, ToolbarOptions } from '../core/types'
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

    // Tags de filtres rapides, à gauche de la recherche.
    for (const tag of this.options.tags ?? []) {
      left.append(this.buildTag(tag))
    }

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

    // Dernier de la liste : c'est le bouton qui change le moins souvent d'avis
    // (on l'active ou pas, une fois, sur la grille) — les autres, plus
    // fréquents, restent groupés à sa gauche.
    if (this.options.fullscreenButton === true) {
      this.right.append(this.buildFullscreenButton())
    }

    this.element.append(left, this.right)
  }

  private buildFullscreenButton(): HTMLElement {
    const t = this.ctx.t
    const isFs = this.ctx.api.isFullscreen()

    return el('button', {
      class: `${NS}-icon-btn ${NS}-fullscreen-btn`,
      attrs: {
        type: 'button',
        title: t.t(isFs ? 'exitFullscreen' : 'fullscreen'),
        'aria-label': t.t(isFs ? 'exitFullscreen' : 'fullscreen'),
      },
      children: [this.ctx.icon(isFs ? 'fullscreen-exit' : 'fullscreen')],
      on: { click: () => this.ctx.api.toggleFullscreen() },
    })
  }

  /**
   * Reflete l'etat courant sur le bouton sans reconstruire toute la barre :
   * une reconstruction perdrait le focus/la frappe en cours dans la recherche
   * rapide. Meme esprit que `syncFilterCount()`.
   */
  syncFullscreenButton(): void {
    const btn = this.right?.querySelector<HTMLElement>(`.${NS}-fullscreen-btn`)
    if (!btn) return

    const t = this.ctx.t
    const isFs = this.ctx.api.isFullscreen()
    btn.replaceChildren(this.ctx.icon(isFs ? 'fullscreen-exit' : 'fullscreen'))
    const label = t.t(isFs ? 'exitFullscreen' : 'fullscreen')
    btn.setAttribute('title', label)
    btn.setAttribute('aria-label', label)
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

  /**
   * Un tag actif est un tag dont TOUTES les colonnes portent déjà exactement
   * son filtre. On compare l'état normalisé et non l'objet d'origine : un
   * filtre saisi à la main dans le panneau peut coïncider avec un tag, et
   * dans ce cas le tag doit s'allumer — sinon l'écran dirait deux choses
   * différentes du même état.
   */
  private tagEstActif(tag: ToolbarTag): boolean {
    const etat = this.ctx.columns.getState().filters
    const entrees = Object.entries(tag.filters)
    if (entrees.length === 0) return false

    return entrees.every(([colonne, modele]) => memeFiltre(etat[colonne], modele))
  }

  private buildTag(tag: ToolbarTag): HTMLElement {
    const actif = this.tagEstActif(tag)

    return el('button', {
      class: `${NS}-tag ${actif ? `${NS}-tag-on` : ''} ${tag.tone ? `${NS}-tag-${tag.tone}` : ''}`,
      attrs: {
        type: 'button',
        'aria-pressed': actif ? 'true' : 'false',
        ...(tag.title ? { title: tag.title } : {}),
      },
      children: [
        el('span', { text: tag.label }),
        ...(tag.badge !== undefined && tag.badge !== null && tag.badge !== ''
          ? [el('span', {
              class: `${NS}-tag-badge`,
              text: String(tag.badge),
              attrs: tag.badgeTitle ? { title: tag.badgeTitle } : {},
            })]
          : []),
      ],
      on: {
        click: () => {
          const etaitActif = this.tagEstActif(tag)
          for (const [colonne, modele] of Object.entries(tag.filters)) {
            this.ctx.api.setFilter(colonne, etaitActif ? null : modele)
          }
          // Après le tour de boucle : `setFilter` passe par le modèle de
          // colonnes, dont l'état n'est lisible qu'une fois la mise à jour
          // propagée. Se redessiner tout de suite relisait l'ancien état, et
          // le tag restait éteint alors que son filtre s'appliquait.
          queueMicrotask(() => this.render())
        },
      },
    })
  }
}

/**
 * Deux filtres décrivent-ils la même chose ?
 *
 * Comparaison champ par champ et non par `JSON.stringify` : l'état conservé
 * par la grille est NORMALISÉ (clés complétées, ordre non garanti), donc il
 * ne ressemble jamais littéralement au modèle écrit à la main dans un tag.
 * Comparer les textes laissait le tag éteint alors que son filtre était bien
 * appliqué.
 */
function memeFiltre(
  a: ColumnFilterModel | undefined | null,
  b: ColumnFilterModel | undefined | null,
): boolean {
  if (!a || !b || a.type !== b.type) return false

  const ca = a.conditions ?? []
  const cb = b.conditions ?? []
  if (ca.length !== cb.length) return false

  const memeValeur = (x: unknown, y: unknown): boolean => {
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) return false
      const tri = (v: unknown[]) => [...v].map(String).sort()
      const [tx, ty] = [tri(x), tri(y)]
      return tx.every((v, i) => v === ty[i])
    }
    return String(x ?? '') === String(y ?? '')
  }

  return ca.every((c, i) =>
    c.op === cb[i].op
    && memeValeur(c.value, cb[i].value)
    && memeValeur(c.value2, cb[i].value2))
}
