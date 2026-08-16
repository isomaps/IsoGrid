import type { RenderColumn, RenderHeader } from '../core/table'
import type { GridContext } from './context'
import { NS, el, onDismiss, positionFloating } from './dom'
import { openFilterPopover } from '../filters/widgets'
import { resolveFilterConfig } from '../filters/model'

/**
 * Rendu de l'en-tête : bandeaux de groupe, cellules de colonne, tri,
 * redimensionnement, bouton de filtre, menu contextuel et déplacement par
 * glisser-déposer.
 */
export class HeaderRenderer {
  readonly element: HTMLElement

  constructor(private ctx: GridContext) {
    this.element = el('div', { class: `${NS}-header`, attrs: { role: 'rowgroup' } })
  }

  render(): void {
    this.element.replaceChildren()
    const rows = this.ctx.columns.getHeaderRows()
    const headerHeight = this.ctx.options.headerHeight ?? 40

    rows.forEach((headers, rowIndex) => {
      const isLeafRow = rowIndex === rows.length - 1
      const row = el('div', {
        class: `${NS}-header-row${isLeafRow ? ` ${NS}-header-row-leaf` : ` ${NS}-header-row-group`}`,
        attrs: { role: 'row' },
        style: { height: `${headerHeight}px` },
      })
      for (const header of headers) {
        row.append(isLeafRow ? this.buildLeafCell(header) : this.buildGroupCell(header))
      }
      this.element.append(row)
    })
  }

  /* -------------------------------------------------------------------- */
  /* Cellules                                                              */
  /* -------------------------------------------------------------------- */

  private applyStickyStyle(node: HTMLElement, pinned: RenderHeader['pinned'], offset: number): void {
    if (!pinned) return
    node.style.position = 'sticky'
    node.style.zIndex = '3'
    if (pinned === 'start') node.style.left = `${offset}px`
    else node.style.right = `${offset}px`
  }

  private buildGroupCell(header: RenderHeader): HTMLElement {
    const cell = el('div', {
      class: `${NS}-hcell ${NS}-hcell-group${header.isPlaceholder ? ` ${NS}-hcell-empty` : ''}`,
      attrs: { role: 'columnheader', 'aria-colspan': header.colSpan },
      style: { width: `${header.width}px` },
      children: header.isPlaceholder
        ? []
        : [el('span', { class: `${NS}-hcell-label`, text: this.ctx.t.header(header.groupLabel ?? '') })],
    })
    this.applyStickyStyle(cell, header.pinned, header.stickyOffset)
    return cell
  }

  private buildLeafCell(header: RenderHeader): HTMLElement {
    const column = header.column
    if (!column) return el('div', { class: `${NS}-hcell ${NS}-hcell-empty`, style: { width: `${header.width}px` } })

    const def = column.def
    const t = this.ctx.t
    const sortState = this.ctx.columns.getSortState(column.id)
    const sortable = def.sortable !== false
    const filterConfig = resolveFilterConfig(def)
    const isFiltered = this.ctx.columns.getFilters()[column.id] != null

    const cell = el('div', {
      class: [
        `${NS}-hcell`,
        column.pinned ? `${NS}-pinned-${column.pinned}` : '',
        column.isLastPinnedStart ? `${NS}-pin-edge-start` : '',
        column.isFirstPinnedEnd ? `${NS}-pin-edge-end` : '',
        def.align ? `${NS}-align-${def.align}` : '',
        sortState.direction ? `${NS}-sorted` : '',
      ].filter(Boolean).join(' '),
      attrs: {
        role: 'columnheader',
        'data-col-id': column.id,
        'aria-sort': sortState.direction === 'asc' ? 'ascending'
          : sortState.direction === 'desc' ? 'descending'
            : sortable ? 'none' : undefined,
        title: def.headerTooltip ?? undefined,
        tabindex: 0,
      },
      style: { width: `${column.width}px` },
    })
    this.applyStickyStyle(cell, column.pinned, column.stickyOffset)

    /* --- libellé + tri --- */
    const labelBox = el('div', {
      class: `${NS}-hcell-main${sortable ? ` ${NS}-sortable` : ''}`,
      children: [
        el('span', { class: `${NS}-hcell-label`, text: t.header(def.header ?? def.id) }),
      ],
    })

    if (sortable) {
      const iconName = sortState.direction === 'asc' ? 'sort-asc'
        : sortState.direction === 'desc' ? 'sort-desc'
          : 'sort-none'
      const sortBox = el('span', {
        class: `${NS}-sort-indicator${sortState.direction ? ` ${NS}-active` : ''}`,
        children: [this.ctx.icon(iconName)],
      })
      // L'index n'a de sens qu'en tri multiple.
      if (sortState.index > 0 || (sortState.direction && this.ctx.columns.getSort().length > 1)) {
        sortBox.append(el('span', { class: `${NS}-sort-index`, text: String(sortState.index + 1) }))
      }
      labelBox.append(sortBox)

      const toggle = (e: MouseEvent | KeyboardEvent) => {
        this.ctx.columns.toggleSort(column.id, e.shiftKey)
        this.ctx.reload()
      }
      labelBox.addEventListener('click', toggle)
      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e) }
      })
    }
    cell.append(labelBox)

    /* --- actions --- */
    const actions = el('div', { class: `${NS}-hcell-actions` })

    if (filterConfig) {
      actions.append(el('button', {
        class: `${NS}-icon-btn ${NS}-filter-btn${isFiltered ? ` ${NS}-active` : ''}`,
        attrs: {
          type: 'button',
          title: t.t('filterBy'),
          'aria-label': `${t.t('filterBy')} ${t.header(def.header ?? def.id)}`,
        },
        children: [this.ctx.icon(isFiltered ? 'filter' : 'filter-column')],
        on: {
          click: (e: MouseEvent) => {
            e.stopPropagation()
            openFilterPopover(this.ctx, def, e.currentTarget as HTMLElement)
          },
        },
      }))
    }

    actions.append(el('button', {
      class: `${NS}-icon-btn ${NS}-menu-btn`,
      attrs: { type: 'button', title: t.t('columns'), 'aria-label': t.t('columns'), 'aria-haspopup': 'menu' },
      children: [this.ctx.icon('menu')],
      on: {
        click: (e: MouseEvent) => {
          e.stopPropagation()
          this.openColumnMenu(column, e.currentTarget as HTMLElement)
        },
      },
    }))
    cell.append(actions)

    /* --- poignée de redimensionnement --- */
    if (def.resizable !== false) {
      cell.append(this.buildResizeHandle(column))
    }

    /* --- déplacement --- */
    if (def.lockPosition !== true) {
      this.wireColumnDrag(cell, column)
    }

    return cell
  }

  /* -------------------------------------------------------------------- */
  /* Redimensionnement                                                     */
  /* -------------------------------------------------------------------- */

  private buildResizeHandle(column: RenderColumn): HTMLElement {
    const handle = el('div', {
      class: `${NS}-resize-handle`,
      attrs: { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': column.id },
    })

    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const startWidth = column.width
      handle.setPointerCapture(e.pointerId)
      document.body.classList.add(`${NS}-resizing`)

      const onMove = (ev: PointerEvent) => {
        this.ctx.columns.setColumnWidth(column.id, startWidth + (ev.clientX - startX))
      }
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('pointercancel', onUp)
        document.body.classList.remove(`${NS}-resizing`)
        this.ctx.emitState()
      }
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onUp)
    })

    // Double-clic = ajustement au contenu, comme dans un tableur.
    handle.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      this.ctx.api.autoSizeColumn(column.id)
    })

    return handle
  }

  /* -------------------------------------------------------------------- */
  /* Déplacement de colonne                                                */
  /* -------------------------------------------------------------------- */

  private wireColumnDrag(cell: HTMLElement, column: RenderColumn): void {
    cell.setAttribute('draggable', 'true')

    cell.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', column.id)
      e.dataTransfer!.effectAllowed = 'move'
      cell.classList.add(`${NS}-dragging`)
    })
    cell.addEventListener('dragend', () => {
      cell.classList.remove(`${NS}-dragging`)
      this.element.querySelectorAll(`.${NS}-drop-before, .${NS}-drop-after`)
        .forEach(n => n.classList.remove(`${NS}-drop-before`, `${NS}-drop-after`))
    })
    cell.addEventListener('dragover', (e) => {
      e.preventDefault()
      const rect = cell.getBoundingClientRect()
      const after = e.clientX > rect.left + rect.width / 2
      cell.classList.toggle(`${NS}-drop-before`, !after)
      cell.classList.toggle(`${NS}-drop-after`, after)
    })
    cell.addEventListener('dragleave', () => {
      cell.classList.remove(`${NS}-drop-before`, `${NS}-drop-after`)
    })
    cell.addEventListener('drop', (e) => {
      e.preventDefault()
      const draggedId = e.dataTransfer?.getData('text/plain')
      cell.classList.remove(`${NS}-drop-before`, `${NS}-drop-after`)
      if (!draggedId || draggedId === column.id) return

      const order = this.ctx.columns.getTable().getAllLeafColumns().map(c => c.id)
      const targetIndex = order.indexOf(column.id)
      const rect = cell.getBoundingClientRect()
      const after = e.clientX > rect.left + rect.width / 2
      this.ctx.columns.moveColumn(draggedId, after ? targetIndex + 1 : targetIndex)
      this.ctx.emitState()
    })
  }

  /* -------------------------------------------------------------------- */
  /* Menu de colonne                                                       */
  /* -------------------------------------------------------------------- */

  private openColumnMenu(column: RenderColumn, anchor: HTMLElement): void {
    const t = this.ctx.t
    const def = column.def
    const menu = el('div', { class: `${NS}-popover ${NS}-menu`, attrs: { role: 'menu' } })

    let dispose = () => {}
    const close = () => { dispose(); menu.remove() }

    const item = (icon: Parameters<GridContext['icon']>[0], label: string, action: () => void, active = false) =>
      el('button', {
        class: `${NS}-menu-item${active ? ` ${NS}-active` : ''}`,
        attrs: { type: 'button', role: 'menuitem' },
        children: [this.ctx.icon(icon), el('span', { text: label })],
        on: { click: () => { action(); close() } },
      })

    const sortState = this.ctx.columns.getSortState(column.id)
    if (def.sortable !== false) {
      menu.append(
        item('sort-asc', t.t('sortAsc'), () => {
          this.ctx.columns.setSort([{ id: column.id, desc: false }])
          this.ctx.reload()
        }, sortState.direction === 'asc'),
        item('sort-desc', t.t('sortDesc'), () => {
          this.ctx.columns.setSort([{ id: column.id, desc: true }])
          this.ctx.reload()
        }, sortState.direction === 'desc'),
      )
      if (sortState.direction) {
        menu.append(item('sort-none', t.t('clearSort'), () => {
          this.ctx.columns.setSort(this.ctx.columns.getSort().filter(s => s.id !== column.id))
          this.ctx.reload()
        }))
      }
      menu.append(el('div', { class: `${NS}-menu-sep` }))
    }

    menu.append(
      item('pin-start', t.t('pinStart'), () => {
        this.ctx.columns.pinColumn(column.id, column.pinned === 'start' ? false : 'start')
        this.ctx.emitState()
      }, column.pinned === 'start'),
      item('pin-end', t.t('pinEnd'), () => {
        this.ctx.columns.pinColumn(column.id, column.pinned === 'end' ? false : 'end')
        this.ctx.emitState()
      }, column.pinned === 'end'),
    )
    if (column.pinned) {
      menu.append(item('unpin', t.t('unpin'), () => {
        this.ctx.columns.pinColumn(column.id, false)
        this.ctx.emitState()
      }))
    }

    menu.append(el('div', { class: `${NS}-menu-sep` }))
    menu.append(item('columns', t.t('autoSize'), () => this.ctx.api.autoSizeColumn(column.id)))

    if (def.lockVisible !== true) {
      menu.append(item('eye-off', t.t('hideColumn'), () => {
        this.ctx.api.setColumnVisible(column.id, false)
      }))
    }

    document.body.append(menu)
    positionFloating(anchor, menu)
    dispose = onDismiss(menu, close)
    menu.querySelector<HTMLElement>('button')?.focus()
  }
}
