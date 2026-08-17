import type { ColumnDef, SidebarOptions } from '../core/types'
import type { GridContext } from './context'
import { NS, el } from './dom'
import { FilterEditor } from '../filters/widgets'
import { resolveFilterConfig } from '../filters/model'

type PanelId = 'columns' | 'filters'

/**
 * Panneau latéral : onglets « Colonnes » et « Filtres ».
 *
 * C'est l'équivalent de la sidebar d'AG Grid, qui est une fonction Enterprise
 * chez eux. Le panneau colonnes gère visibilité, réordonnancement par
 * glisser-déposer et épinglage ; le panneau filtres empile les mêmes éditeurs
 * que les popovers d'en-tête.
 */
export class Sidebar {
  readonly element: HTMLElement
  private panels: PanelId[]
  private activePanel: PanelId | null = null
  private body: HTMLElement
  private tabsBar: HTMLElement
  private columnSearch = ''

  private showTabs: boolean

  constructor(private ctx: GridContext, options: SidebarOptions) {
    this.panels = options.panels ?? ['columns', 'filters']
    this.showTabs = options.tabs === true

    this.tabsBar = el('div', { class: `${NS}-sidebar-tabs`, attrs: { role: 'tablist' } })
    this.body = el('div', { class: `${NS}-sidebar-body` })

    this.element = el('div', {
      class: `${NS}-sidebar ${NS}-sidebar-${options.position ?? 'end'}`,
      style: { '--isg-sidebar-width': `${options.width ?? 260}px` } as Partial<CSSStyleDeclaration>,
      children: [this.tabsBar, this.body],
    })

    const initial = options.defaultOpen
    if (initial && this.panels.includes(initial)) this.activePanel = initial
    this.renderTabs()
    this.render()
  }

  isOpen(): boolean {
    return this.activePanel != null
  }

  toggle(panel?: PanelId): void {
    const target = panel ?? this.panels[0]
    this.activePanel = this.activePanel === target ? null : target
    this.renderTabs()
    this.render()
  }

  /** Ouvre un panneau précis (appelé par la barre d'outils). */
  open(panel: PanelId): void {
    this.activePanel = panel
    this.renderTabs()
    this.render()
  }

  getActivePanel(): PanelId | null {
    return this.activePanel
  }

  private renderTabs(): void {
    this.tabsBar.replaceChildren()
    this.tabsBar.style.display = this.showTabs ? '' : 'none'
    if (!this.showTabs) return
    for (const panel of this.panels) {
      const isActive = this.activePanel === panel
      const badge = panel === 'filters' ? this.ctx.columns.getActiveFilterCount() : 0
      this.tabsBar.append(el('button', {
        class: `${NS}-sidebar-tab${isActive ? ` ${NS}-active` : ''}`,
        attrs: {
          type: 'button',
          role: 'tab',
          'aria-selected': isActive,
          title: this.ctx.t.t(panel),
        },
        children: [
          this.ctx.icon(panel === 'columns' ? 'columns' : 'filter'),
          el('span', { class: `${NS}-sidebar-tab-label`, text: this.ctx.t.t(panel) }),
          badge > 0 ? el('span', { class: `${NS}-badge`, text: String(badge) }) : null,
        ],
        on: { click: () => this.toggle(panel) },
      }))
    }
  }

  render(): void {
    this.element.classList.toggle(`${NS}-open`, this.isOpen())
    this.body.replaceChildren()
    if (!this.activePanel) return
    if (this.activePanel === 'columns') this.renderColumnsPanel()
    else this.renderFiltersPanel()
  }

  /* -------------------------------------------------------------------- */
  /* Panneau colonnes                                                      */
  /* -------------------------------------------------------------------- */

  private renderColumnsPanel(): void {
    const t = this.ctx.t
    const defs = this.ctx.columns.getOrderedDefs()
    const state = this.ctx.columns.getState()

    this.body.append(el('div', {
      class: `${NS}-panel-header`,
      children: [
        el('input', {
          class: `${NS}-input`,
          attrs: { type: 'search', placeholder: t.t('searchColumns'), value: this.columnSearch },
          on: {
            input: (e: Event) => {
              this.columnSearch = (e.target as HTMLInputElement).value
              this.render()
            },
          },
        }),
        el('div', {
          class: `${NS}-panel-actions`,
          children: [
            el('button', {
              class: `${NS}-btn ${NS}-btn-ghost`,
              attrs: { type: 'button' },
              text: t.t('showAll'),
              on: { click: () => this.setAllVisible(true) },
            }),
            el('button', {
              class: `${NS}-btn ${NS}-btn-ghost`,
              attrs: { type: 'button' },
              text: t.t('hideAll'),
              on: { click: () => this.setAllVisible(false) },
            }),
          ],
        }),
      ],
    }))

    const needle = this.columnSearch.trim().toLocaleLowerCase()
    const visible = defs.filter(d =>
      !needle || t.header(d.header ?? d.id).toLocaleLowerCase().includes(needle))

    if (visible.length === 0) {
      this.body.append(el('div', { class: `${NS}-panel-empty`, text: t.t('noColumnMatch') }))
      return
    }

    const list = el('div', { class: `${NS}-column-list` })
    for (const def of visible) {
      list.append(this.buildColumnRow(def, state.columnVisibility[def.id] !== false))
    }
    this.body.append(list)
  }

  private setAllVisible(visible: boolean): void {
    const next: Record<string, boolean> = {}
    for (const def of this.ctx.columns.getAllDefs()) {
      // Une colonne verrouillée reste visible quoi qu'il arrive.
      next[def.id] = def.lockVisible ? true : visible
    }
    this.ctx.columns.setState({ columnVisibility: next })
    this.ctx.emitState()
  }

  private buildColumnRow(def: ColumnDef, isVisible: boolean): HTMLElement {
    const t = this.ctx.t
    const pinned = this.ctx.columns.getState().columnPinning
    const pinPosition = pinned.start.includes(def.id) ? 'start'
      : pinned.end.includes(def.id) ? 'end'
        : false

    // La ligne n'est PAS `draggable` d'emblée : elle le devient le temps d'une
    // prise sur la poignée. Sinon le moindre glissement depuis le libellé ou la
    // case démarrait un déplacement, et sélectionner le texte devenait
    // impossible.
    const row = el('div', {
      class: `${NS}-column-row`,
      attrs: { 'data-col-id': def.id, draggable: 'false' },
    })

    const grip = el('span', {
      class: `${NS}-column-grip`,
      attrs: { title: t.t('reorderColumn'), 'aria-hidden': 'true' },
      children: [this.ctx.icon('grip')],
    })
    if (!def.lockPosition) {
      grip.addEventListener('pointerdown', () => { row.draggable = true })
      // On rend la ligne inerte dès que la prise se relâche, y compris quand le
      // glisser n'a jamais commencé.
      grip.addEventListener('pointerup', () => { row.draggable = false })
      row.addEventListener('dragend', () => { row.draggable = false })
    }
    row.append(grip)

    row.append(el('label', {
      class: `${NS}-column-toggle`,
      children: [
        el('input', {
          attrs: { type: 'checkbox', checked: isVisible, disabled: def.lockVisible },
          on: {
            change: (e: Event) => {
              this.ctx.api.setColumnVisible(def.id, (e.target as HTMLInputElement).checked)
            },
          },
        }),
        el('span', { class: `${NS}-column-name`, text: t.header(def.header ?? def.id) }),
      ],
    }))

    const pinButton = (position: 'start' | 'end', icon: 'pin-start' | 'pin-end', label: string) =>
      el('button', {
        class: `${NS}-icon-btn ${NS}-pin-btn${pinPosition === position ? ` ${NS}-active` : ''}`,
        attrs: { type: 'button', title: label, 'aria-label': label, 'aria-pressed': pinPosition === position },
        children: [this.ctx.icon(icon)],
        on: {
          click: () => {
            this.ctx.columns.pinColumn(def.id, pinPosition === position ? false : position)
            this.ctx.emitState()
          },
        },
      })

    row.append(el('div', {
      class: `${NS}-column-pins`,
      children: [
        pinButton('start', 'pin-start', t.t('pinStart')),
        pinButton('end', 'pin-end', t.t('pinEnd')),
      ],
    }))

    if (!def.lockPosition) this.wireRowDrag(row, def.id)
    return row
  }

  private wireRowDrag(row: HTMLElement, columnId: string): void {
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', columnId)
      row.classList.add(`${NS}-dragging`)
    })
    row.addEventListener('dragend', () => row.classList.remove(`${NS}-dragging`))
    row.addEventListener('dragover', (e) => {
      e.preventDefault()
      const rect = row.getBoundingClientRect()
      const after = e.clientY > rect.top + rect.height / 2
      row.classList.toggle(`${NS}-drop-before`, !after)
      row.classList.toggle(`${NS}-drop-after`, after)
    })
    row.addEventListener('dragleave', () => {
      row.classList.remove(`${NS}-drop-before`, `${NS}-drop-after`)
    })
    row.addEventListener('drop', (e) => {
      e.preventDefault()
      row.classList.remove(`${NS}-drop-before`, `${NS}-drop-after`)
      const draggedId = e.dataTransfer?.getData('text/plain')
      if (!draggedId || draggedId === columnId) return

      const order = this.ctx.columns.getTable().getAllLeafColumns().map(c => c.id)
      const targetIndex = order.indexOf(columnId)
      const rect = row.getBoundingClientRect()
      const after = e.clientY > rect.top + rect.height / 2
      this.ctx.columns.moveColumn(draggedId, after ? targetIndex + 1 : targetIndex)
      this.ctx.emitState()
    })
  }

  /* -------------------------------------------------------------------- */
  /* Panneau filtres                                                       */
  /* -------------------------------------------------------------------- */

  private renderFiltersPanel(): void {
    const t = this.ctx.t
    const defs = this.ctx.columns.getOrderedDefs().filter(d => resolveFilterConfig(d) != null)
    const active = this.ctx.columns.getFilters()

    this.body.append(el('div', {
      class: `${NS}-panel-header`,
      children: [
        el('button', {
          class: `${NS}-btn ${NS}-btn-ghost`,
          attrs: { type: 'button', disabled: Object.keys(active).length === 0 },
          text: t.t('clearAllFilters'),
          on: {
            click: () => {
              this.ctx.columns.clearFilters()
              this.ctx.reload()
            },
          },
        }),
      ],
    }))

    if (defs.length === 0) {
      this.body.append(el('div', { class: `${NS}-panel-empty`, text: t.t('noFilterActive') }))
      return
    }

    const list = el('div', { class: `${NS}-filter-list` })
    for (const def of defs) {
      const isActive = active[def.id] != null
      const content = el('div', { class: `${NS}-accordion-body` })
      let built = false

      const header = el('button', {
        class: `${NS}-accordion-header${isActive ? ` ${NS}-active` : ''}`,
        attrs: { type: 'button', 'aria-expanded': isActive },
        children: [
          this.ctx.icon('chevron-right'),
          el('span', { class: `${NS}-accordion-title`, text: t.header(def.header ?? def.id) }),
          isActive ? el('span', { class: `${NS}-badge`, text: '1' }) : null,
        ],
      })

      const item = el('div', {
        class: `${NS}-accordion${isActive ? ` ${NS}-open` : ''}`,
        children: [header, content],
      })

      // L'éditeur n'est construit qu'à la première ouverture : sinon on
      // déclencherait un chargement de valeurs `set` pour chaque colonne, au
      // simple montage du panneau.
      const buildOnce = () => {
        if (built) return
        built = true
        const editor = new FilterEditor(this.ctx, def, (model) => {
          this.ctx.api.setFilter(def.id, model)
        })
        content.append(editor.element)
      }

      header.addEventListener('click', () => {
        const open = item.classList.toggle(`${NS}-open`)
        header.setAttribute('aria-expanded', String(open))
        if (open) buildOnce()
      })

      // Un filtre déjà actif s'affiche ouvert : l'item porte déjà la classe.
      if (isActive) buildOnce()

      list.append(item)
    }
    this.body.append(list)
  }
}
