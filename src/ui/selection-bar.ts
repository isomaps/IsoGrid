import type { SelectionBarOptions } from '../core/types'
import type { SelectionSnapshot } from '../core/selection'
import type { GridContext } from './context'
import { NS, el } from './dom'

/**
 * Barre d'actions sur la sélection (0.31.0), entre la barre d'outils et
 * l'en-tête.
 *
 * Toujours visible par défaut, et c'est le point : des actions qui
 * n'apparaissent qu'une fois des lignes cochées, personne ne les trouve.
 * Grisée, la barre dit comment s'en servir ; avec une sélection, elle donne le
 * nombre de lignes (celui de `getSelection()`, juste aussi en « tout sauf »)
 * et active les actions.
 *
 * Les actions sont celles de l'hôte : la grille ne fait que les présenter et
 * leur passer la sélection.
 */
export class SelectionBar {
  readonly element: HTMLElement

  constructor(
    private ctx: GridContext,
    private options: SelectionBarOptions,
    private getSelection: () => SelectionSnapshot,
    private clear: () => void,
  ) {
    this.element = el('div', { class: `${NS}-selection-bar`, attrs: { role: 'toolbar' } })
    this.render()
  }

  render(): void {
    const t = this.ctx.t
    const sel = this.getSelection()
    const actif = !sel.isEmpty
    // Total encore inconnu en « tout sélectionner » : pas de nombre à afficher
    const n = sel.count
    const visible = this.options.alwaysVisible !== false || actif
    this.element.hidden = !visible
    this.element.classList.toggle(`${NS}-active`, actif)
    this.element.setAttribute('aria-label', t.t('selectionBarHint'))
    if (!visible) { this.element.replaceChildren(); return }

    const compte = !actif
      ? (this.options.hint ?? t.t('selectionBarHint'))
      : n === null
        ? t.t('allRowsSelected')
        : (this.options.countLabel?.(n)
          ?? (n === 1 ? t.t('selectionBarCountOne') : t.t('selectionBarCount').replace('{n}', t.number(n))))
        // Lignes cochées que le filtre masque (keepSelectionOnFilter, 0.32.0)
        + (sel.hidden ? ` ${t.t('selectionHidden').replace('{n}', t.number(sel.hidden))}` : '')

    const children: HTMLElement[] = [el('span', { class: `${NS}-selection-bar-count`, text: compte, attrs: { 'aria-live': 'polite' } })]
    for (const action of this.options.actions) {
      if (action.hidden?.(sel)) continue
      const off = !actif || (action.disabled?.(sel) ?? false)
      const icon = action.iconNode?.() ?? (action.icon ? this.ctx.icon(action.icon) : null)
      children.push(el('button', {
        class: `${NS}-btn ${NS}-selection-action${action.tone && action.tone !== 'neutral' ? ` ${NS}-selection-action-${action.tone}` : ''}`,
        attrs: {
          type: 'button',
          'data-action-id': action.id,
          disabled: off ? true : undefined,
          ...(action.title ? { title: action.title } : {}),
        },
        children: [...(icon ? [icon] : []), el('span', { text: action.label })],
        on: { click: () => { if (!off) action.onClick(this.getSelection()) } },
      }))
    }
    if (actif) {
      children.push(el('button', {
        class: `${NS}-btn ${NS}-btn-ghost ${NS}-selection-clear`,
        attrs: { type: 'button' },
        text: t.t('clearSelection'),
        on: { click: () => this.clear() },
      }))
    }
    this.element.replaceChildren(...children)
  }
}
