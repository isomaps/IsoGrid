import type {
  ColumnDef, ColumnFilterConfig, ColumnFilterModel, FilterCondition, FilterOperator, SetFilterOption,
} from '../core/types'
import type { GridContext } from '../ui/context'
import { NS, debounce, el, onDismiss, positionFloating } from '../ui/dom'
import {
  BINARY_OPERATORS, NULLARY_OPERATORS, operatorLabelKey, resolveFilterConfig,
} from './model'

/**
 * Éditeur de filtre d'une colonne.
 *
 * Rendu en deux contextes : dans un popover ancré au bouton d'en-tête, et
 * empilé dans le panneau « Filtres » de la sidebar. Le même composant sert
 * aux deux — c'est ce qui garantit qu'ils ne divergent jamais.
 */
export class FilterEditor {
  readonly element: HTMLElement
  private config: ColumnFilterConfig
  private model: ColumnFilterModel
  private conditionsHost!: HTMLElement
  private joinRow?: HTMLElement
  private setOptions: SetFilterOption[] | null = null
  private setSearch = ''

  constructor(
    private ctx: GridContext,
    private column: ColumnDef,
    private onCommit: (model: ColumnFilterModel | null) => void,
  ) {
    const config = resolveFilterConfig(column)
    if (!config) throw new Error(`IsoGrid: la colonne « ${column.id} » n'est pas filtrable`)
    this.config = config

    const existing = this.ctx.columns.getFilters()[column.id]
    this.model = existing
      ? structuredClone(existing)
      : { type: config.type, conditions: [this.blankCondition()], join: 'and' }

    this.element = el('div', { class: `${NS}-filter` })
    this.render()
  }

  private blankCondition(): FilterCondition {
    return { op: this.config.defaultOperator ?? 'contains', value: undefined }
  }

  private commit(): void {
    // On ne normalise pas ici : une condition à moitié saisie doit rester
    // affichée. C'est la grille qui filtre les conditions incomplètes.
    this.onCommit(this.model)
  }

  private render(): void {
    this.element.replaceChildren()
    if (this.config.type === 'set') {
      this.renderSetFilter()
    } else {
      this.renderConditionFilter()
    }
    this.renderFooter()
  }

  /* -------------------------------------------------------------------- */
  /* Filtres à conditions (texte, nombre, date, booléen)                   */
  /* -------------------------------------------------------------------- */

  private renderConditionFilter(): void {
    this.conditionsHost = el('div', { class: `${NS}-filter-conditions` })
    this.element.append(this.conditionsHost)
    this.renderConditions()
  }

  private renderConditions(): void {
    this.conditionsHost.replaceChildren()

    this.model.conditions.forEach((cond, index) => {
      if (index > 0) this.conditionsHost.append(this.buildJoinRow())
      this.conditionsHost.append(this.buildConditionRow(cond, index))
    })

    // Une seconde condition suffit : au-delà on bascule dans le territoire du
    // constructeur de requêtes, hors périmètre.
    if (this.model.conditions.length < 2 && this.config.type !== 'boolean') {
      this.conditionsHost.append(el('button', {
        class: `${NS}-filter-add`,
        attrs: { type: 'button' },
        children: [this.ctx.icon('chevron-down'), this.ctx.t.t('addCondition')],
        on: {
          click: () => {
            this.model.conditions.push(this.blankCondition())
            this.renderConditions()
          },
        },
      }))
    }
  }

  private buildJoinRow(): HTMLElement {
    const mkButton = (value: 'and' | 'or') => el('button', {
      class: `${NS}-join-btn${(this.model.join ?? 'and') === value ? ` ${NS}-active` : ''}`,
      attrs: { type: 'button' },
      text: this.ctx.t.t(value),
      on: {
        click: () => {
          this.model.join = value
          this.renderConditions()
          this.commit()
        },
      },
    })
    this.joinRow = el('div', { class: `${NS}-filter-join`, children: [mkButton('and'), mkButton('or')] })
    return this.joinRow
  }

  private buildConditionRow(cond: FilterCondition, index: number): HTMLElement {
    const row = el('div', { class: `${NS}-filter-row` })

    const operators = this.config.operators ?? []
    const select = el('select', {
      class: `${NS}-select`,
      attrs: { 'aria-label': this.ctx.t.t('filterBy') },
      children: operators.map(op => el('option', {
        attrs: { value: op, selected: op === cond.op },
        text: this.ctx.t.t(operatorLabelKey(op)),
      })),
      on: {
        change: (e: Event) => {
          cond.op = (e.target as HTMLSelectElement).value as FilterOperator
          if (NULLARY_OPERATORS.has(cond.op)) { cond.value = undefined; cond.value2 = undefined }
          this.renderConditions()
          this.commit()
        },
      },
    })
    row.append(select)

    if (!NULLARY_OPERATORS.has(cond.op)) {
      row.append(...this.buildValueInputs(cond))
    }

    if (index > 0) {
      row.append(el('button', {
        class: `${NS}-icon-btn ${NS}-filter-remove`,
        attrs: { type: 'button', title: this.ctx.t.t('removeCondition'), 'aria-label': this.ctx.t.t('removeCondition') },
        children: [this.ctx.icon('close')],
        on: {
          click: () => {
            this.model.conditions.splice(index, 1)
            this.renderConditions()
            this.commit()
          },
        },
      }))
    }
    return row
  }

  private buildValueInputs(cond: FilterCondition): HTMLElement[] {
    const debounced = debounce(() => this.commit(), this.config.debounce ?? 300)

    if (this.config.type === 'boolean') {
      return [el('select', {
        class: `${NS}-select`,
        children: [
          el('option', { attrs: { value: 'true', selected: cond.value !== false && cond.value !== 'false' }, text: this.ctx.t.t('true') }),
          el('option', { attrs: { value: 'false', selected: cond.value === false || cond.value === 'false' }, text: this.ctx.t.t('false') }),
        ],
        on: {
          change: (e: Event) => {
            cond.value = (e.target as HTMLSelectElement).value === 'true'
            this.commit()
          },
        },
      })]
    }

    const inputType = this.config.type === 'number' ? 'number'
      : this.config.type === 'date' ? 'date'
        : 'text'

    const mkInput = (key: 'value' | 'value2', placeholderKey: 'valuePlaceholder' | 'fromPlaceholder' | 'toPlaceholder') =>
      el('input', {
        class: `${NS}-input`,
        attrs: {
          type: inputType,
          value: cond[key] == null ? '' : String(cond[key]),
          placeholder: this.ctx.t.t(placeholderKey),
          inputmode: this.config.type === 'number' ? 'decimal' : undefined,
        },
        on: {
          input: (e: Event) => {
            const raw = (e.target as HTMLInputElement).value
            cond[key] = raw === '' ? undefined : raw
            debounced()
          },
          keydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter') { debounced.cancel(); this.commit() }
          },
        },
      })

    return BINARY_OPERATORS.has(cond.op)
      ? [mkInput('value', 'fromPlaceholder'), mkInput('value2', 'toPlaceholder')]
      : [mkInput('value', 'valuePlaceholder')]
  }

  /* -------------------------------------------------------------------- */
  /* Filtre par valeurs (set)                                              */
  /* -------------------------------------------------------------------- */

  private selectedValues(): Set<string> {
    const cond = this.model.conditions[0]
    const list = Array.isArray(cond?.value) ? cond.value as unknown[] : []
    return new Set(list.map(v => String(v ?? '')))
  }

  private renderSetFilter(): void {
    const host = el('div', { class: `${NS}-filter-set` })
    this.element.append(host)

    const paint = () => {
      host.replaceChildren()

      if (this.setOptions == null) {
        host.append(el('div', {
          class: `${NS}-filter-loading`,
          children: [this.ctx.icon('spinner'), this.ctx.t.t('loading')],
        }))
        return
      }

      if (!this.config.hideSearch) {
        host.append(el('input', {
          class: `${NS}-input ${NS}-filter-search`,
          attrs: { type: 'search', placeholder: this.ctx.t.t('searchValues'), value: this.setSearch },
          on: {
            input: (e: Event) => {
              this.setSearch = (e.target as HTMLInputElement).value
              paint()
            },
          },
        }))
      }

      const needle = this.setSearch.trim().toLocaleLowerCase()
      const visible = this.setOptions.filter(o =>
        !needle || String(o.label ?? o.value ?? '').toLocaleLowerCase().includes(needle))

      const selected = this.selectedValues()
      const allShownSelected = visible.length > 0 && visible.every(o => selected.has(String(o.value ?? '')))

      host.append(el('label', {
        class: `${NS}-set-option ${NS}-set-all`,
        children: [
          el('input', {
            attrs: { type: 'checkbox', checked: allShownSelected },
            on: {
              change: (e: Event) => {
                const on = (e.target as HTMLInputElement).checked
                const next = new Set(selected)
                for (const o of visible) {
                  const key = String(o.value ?? '')
                  if (on) next.add(key)
                  else next.delete(key)
                }
                this.model.conditions = [{ op: this.model.conditions[0]?.op ?? 'in', value: Array.from(next) }]
                paint()
                this.commit()
              },
            },
          }),
          el('span', { text: allShownSelected ? this.ctx.t.t('deselectAll') : this.ctx.t.t('selectAll') }),
        ],
      }))

      if (visible.length === 0) {
        host.append(el('div', { class: `${NS}-filter-empty`, text: this.ctx.t.t('noValues') }))
        return
      }

      const list = el('div', { class: `${NS}-set-list` })
      for (const option of visible) {
        const key = String(option.value ?? '')
        const label = option.label ?? (key === '' ? this.ctx.t.t('blankValue') : key)
        list.append(el('label', {
          class: `${NS}-set-option`,
          children: [
            el('input', {
              attrs: { type: 'checkbox', checked: selected.has(key) },
              on: {
                change: (e: Event) => {
                  const next = this.selectedValues()
                  if ((e.target as HTMLInputElement).checked) next.add(key)
                  else next.delete(key)
                  this.model.conditions = [{ op: this.model.conditions[0]?.op ?? 'in', value: Array.from(next) }]
                  this.commit()
                  // Pas de `paint()` : redessiner viderait le focus et
                  // ferait sauter la liste sous le curseur.
                },
              },
            }),
            el('span', { class: `${NS}-set-label`, text: label }),
            option.count != null
              ? el('span', { class: `${NS}-set-count`, text: this.ctx.t.number(option.count) })
              : null,
          ],
        }))
      }
      host.append(list)
    }

    paint()
    this.ctx.fetchSetValues(this.column.id).then(
      (values) => { this.setOptions = values; paint() },
      () => { this.setOptions = []; paint() },
    )
  }

  /* -------------------------------------------------------------------- */
  /* Pied                                                                  */
  /* -------------------------------------------------------------------- */

  private renderFooter(): void {
    this.element.append(el('div', {
      class: `${NS}-filter-footer`,
      children: [
        el('button', {
          class: `${NS}-btn ${NS}-btn-ghost`,
          attrs: { type: 'button' },
          text: this.ctx.t.t('clearFilter'),
          on: {
            click: () => {
              this.model = { type: this.config.type, conditions: [this.blankCondition()], join: 'and' }
              this.setSearch = ''
              this.render()
              this.onCommit(null)
            },
          },
        }),
      ],
    }))
  }
}

/** Ouvre l'éditeur de filtre dans un popover ancré à un bouton d'en-tête. */
export function openFilterPopover(
  ctx: GridContext,
  column: ColumnDef,
  anchor: HTMLElement,
): void {
  const popover = el('div', { class: `${NS}-popover ${NS}-filter-popover`, attrs: { role: 'dialog' } })
  popover.append(el('div', {
    class: `${NS}-popover-title`,
    text: `${ctx.t.t('filterBy')} · ${ctx.t.header(column.header ?? column.id)}`,
  }))

  const editor = new FilterEditor(ctx, column, (model) => {
    ctx.api.setFilter(column.id, model)
  })
  popover.append(editor.element)

  document.body.append(popover)
  positionFloating(anchor, popover)

  const dispose = onDismiss(popover, () => {
    dispose()
    popover.remove()
    anchor.focus()
  })

  // Le premier champ saisissable prend le focus : filtrer au clavier sans
  // repasser par la souris.
  popover.querySelector<HTMLElement>('input, select')?.focus()
}
