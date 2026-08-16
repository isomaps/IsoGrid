import type { AnyRow, ColumnDef, IconName } from '../core/types'
import type { GridContext } from './context'
import { NS, el, getPath, onDismiss } from './dom'

/**
 * Menu contextuel du corps de la grille (clic droit).
 *
 * Reprend les entrées standard d'AG Grid : copier la cellule, copier la
 * ligne, copier la ligne avec ses en-têtes, puis l'export. C'est la voie la
 * plus directe vers le presse-papiers — sans elle, sortir une seule valeur
 * d'un tableau oblige à passer par un export complet.
 */

export interface ContextMenuItem {
  /** Séparateur horizontal si `true` ; les autres champs sont ignorés. */
  separator?: boolean
  label?: string
  icon?: IconName
  disabled?: boolean
  action?: () => void | Promise<void>
}

export interface ContextMenuContext<TRow = AnyRow> {
  row: TRow
  rowIndex: number
  column: ColumnDef<TRow>
  value: unknown
  /** Texte affiché dans la cellule, formatage appliqué. */
  formattedValue: string
}

export interface ContextMenuOptions<TRow = AnyRow> {
  /** Masque les entrées de copie. */
  copyItems?: boolean
  /** Masque les entrées d'export. */
  exportItems?: boolean
  /**
   * Remplace entièrement le menu. Recevoir les entrées par défaut permet de
   * les réordonner ou d'en insérer plutôt que de tout réécrire.
   */
  items?: (ctx: ContextMenuContext<TRow>, defaults: ContextMenuItem[]) => ContextMenuItem[]
}

/**
 * Écrit dans le presse-papiers.
 *
 * `navigator.clipboard` exige un contexte sécurisé ; le repli par `<textarea>`
 * + `execCommand` couvre les back-offices encore servis en HTTP simple.
 */
export async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* on tente le repli ci-dessous */
  }

  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    // Hors écran plutôt que `display:none` : un élément non rendu n'est pas
    // sélectionnable, donc la copie échouerait silencieusement.
    area.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

/** Assemble une ligne au format TSV — c'est ce qu'un tableur attend au collage. */
function toTsv(values: string[]): string {
  return values
    .map(v => v.replace(/\t/g, ' ').replace(/\r?\n/g, ' '))
    .join('\t')
}

export class ContextMenu {
  private dispose: () => void = () => {}
  private element?: HTMLElement

  constructor(private ctx: GridContext, private options: ContextMenuOptions = {}) {}

  close(): void {
    this.dispose()
    this.dispose = () => {}
    this.element?.remove()
    this.element = undefined
  }

  open(event: MouseEvent, menuContext: ContextMenuContext): void {
    this.close()
    const t = this.ctx.t

    const visibleColumns = this.ctx.columns.getRenderColumns().map(c => c.def)
    const rowValues = visibleColumns.map(col => this.formatFor(col, menuContext.row))
    const headers = visibleColumns.map(col => t.header(col.header ?? col.id))

    const defaults: ContextMenuItem[] = []

    if (this.options.copyItems !== false) {
      defaults.push(
        {
          label: t.t('copyCell'),
          icon: 'copy',
          action: () => this.copy(menuContext.formattedValue),
        },
        {
          label: t.t('copyRow'),
          icon: 'copy-row',
          action: () => this.copy(toTsv(rowValues)),
        },
        {
          label: t.t('copyRowWithHeaders'),
          icon: 'copy-table',
          action: () => this.copy(`${toTsv(headers)}\n${toTsv(rowValues)}`),
        },
      )
    }

    if (this.options.exportItems !== false) {
      if (defaults.length > 0) defaults.push({ separator: true })
      defaults.push(
        { label: t.t('exportExcel'), icon: 'excel', action: () => this.ctx.api.exportExcel() },
        { label: t.t('exportCsv'), icon: 'csv', action: () => this.ctx.api.exportCsv() },
      )
    }

    const items = this.options.items ? this.options.items(menuContext, defaults) : defaults
    if (items.length === 0) return

    // On ne supprime le menu natif que si l'on a quelque chose à proposer.
    event.preventDefault()

    const menu = el('div', { class: `${NS}-popover ${NS}-menu ${NS}-context-menu`, attrs: { role: 'menu' } })
    for (const item of items) {
      if (item.separator) {
        menu.append(el('div', { class: `${NS}-menu-sep` }))
        continue
      }
      menu.append(el('button', {
        class: `${NS}-menu-item`,
        attrs: { type: 'button', role: 'menuitem', disabled: item.disabled },
        children: [
          item.icon ? this.ctx.icon(item.icon) : el('span', { class: `${NS}-icon` }),
          el('span', { text: item.label ?? '' }),
        ],
        on: {
          click: () => {
            this.close()
            void item.action?.()
          },
        },
      }))
    }

    document.body.append(menu)
    this.element = menu
    this.positionAtPointer(menu, event.clientX, event.clientY)
    this.dispose = onDismiss(menu, () => this.close())
    menu.querySelector<HTMLElement>('button:not([disabled])')?.focus()
  }

  /** Ancre le menu au curseur, en le rabattant s'il déborde de la fenêtre. */
  private positionAtPointer(menu: HTMLElement, x: number, y: number): void {
    menu.style.position = 'fixed'
    menu.style.visibility = 'hidden'
    menu.style.left = '0px'
    menu.style.top = '0px'
    const rect = menu.getBoundingClientRect()

    const left = x + rect.width > window.innerWidth - 8
      ? Math.max(8, x - rect.width)
      : x
    const top = y + rect.height > window.innerHeight - 8
      ? Math.max(8, y - rect.height)
      : y

    menu.style.left = `${Math.round(left)}px`
    menu.style.top = `${Math.round(top)}px`
    menu.style.visibility = ''
  }

  private formatFor(col: ColumnDef, row: AnyRow): string {
    const value = getPath(row, col.field ?? col.id)
    if (col.valueFormatter) {
      return col.valueFormatter({
        value, row, rowIndex: 0, column: col, grid: this.ctx.api,
      })
    }
    return value == null ? '' : String(value)
  }

  private async copy(text: string): Promise<void> {
    const ok = await writeToClipboard(text)
    this.toast(ok ? this.ctx.t.t('copied') : this.ctx.t.t('copyFailed'), ok)
  }

  /** Confirmation brève : sans retour visible, on ne sait pas si la copie a pris. */
  private toast(message: string, ok: boolean): void {
    const toast = el('div', {
      class: `${NS}-toast${ok ? '' : ` ${NS}-toast-error`}`,
      attrs: { role: 'status', 'aria-live': 'polite' },
      children: [this.ctx.icon(ok ? 'check' : 'warning'), el('span', { text: message })],
    })
    document.body.append(toast)
    setTimeout(() => {
      toast.classList.add(`${NS}-toast-out`)
      setTimeout(() => toast.remove(), 250)
    }, 1600)
  }
}
