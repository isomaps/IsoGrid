import type { AnyRow, ColumnDef, IconName } from '../core/types'
import type { GridContext } from './context'
import { NS, el, getPath, onDismiss } from './dom'

/**
 * Menu contextuel du corps de la grille (clic droit).
 *
 * Reprend les entrées standard d'AG Grid : copier la cellule, copier la
 * ligne, copier la ligne avec ses en-têtes, puis l'export et l'impression. C'est la voie la
 * plus directe vers le presse-papiers — sans elle, sortir une seule valeur
 * d'un tableau oblige à passer par un export complet.
 */

export interface ContextMenuItem {
  /** Séparateur horizontal si `true` ; les autres champs sont ignorés. */
  separator?: boolean
  /**
   * Intertitre de section, non cliquable ; les autres champs sont ignorés.
   * Pour un menu long que l'hôte range par thèmes (« Actions »,
   * « Préparation / livraison »…) : des séparateurs seuls ne disent pas ce
   * que chaque groupe contient.
   */
  heading?: string
  label?: string
  icon?: IconName
  /**
   * Pictogramme fourni par l'hôte, prioritaire sur `icon` : pour des entrées
   * dont l'icône vient de SON jeu (paramétrage, police d'icônes maison), hors
   * de la liste fermée d'`IconName`. Appelé à chaque ouverture du menu.
   */
  iconNode?: () => Node
  disabled?: boolean
  /** Infobulle de l'entrée — pourquoi elle est désactivée, par exemple. */
  title?: string
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
  /** Masque l'entrée « Imprimer », rangée avec l'export. */
  printItem?: boolean
  /**
   * Remplace entièrement le menu. Recevoir les entrées par défaut permet de
   * les réordonner ou d'en insérer plutôt que de tout réécrire.
   */
  items?: (ctx: ContextMenuContext<TRow>, defaults: ContextMenuItem[]) => ContextMenuItem[]
  /**
   * Appui long au doigt (ms) qui ouvre ce même menu. Défaut : 500.
   * `false` le désactive.
   *
   * Sur écran tactile il n'y a pas de clic droit : iOS n'émet jamais
   * `contextmenu`, Android seulement parfois. Sans ce geste, tout ce que porte
   * le menu serait hors d'atteinte au doigt. Seuls les pointeurs `touch`
   * l'arment : la souris et le stylet gardent leur clic droit.
   */
  longPress?: number | false
  /**
   * Zone verticale utile de la page, lue à chaque ouverture du menu.
   *
   * Par défaut le menu se rabat dans la FENÊTRE — mais quand l'hôte a un
   * bandeau fixe (en-tête d'application, barre d'outils collante), un menu
   * long remonte dessous et ses premières entrées deviennent inatteignables.
   * `top` borne le haut du menu ; `bottom` (défaut : bas de la fenêtre) borne
   * le bas. La hauteur restante est posée en `max-height` — le CSS du menu
   * fait déjà défiler son contenu.
   */
  menuBoundary?: () => { top: number; bottom?: number }
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
    /* Dans le document, pas dans le portail : `execCommand('copy')` ne voit
       pas une sélection faite à l'intérieur d'un shadow root. */
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

  /**
   * Ouvre un menu d'items arbitraires à une position donnée.
   *
   * Séparé de `open()` pour que la colonne d'actions réutilise exactement le
   * même flottant : positionnement rabattu dans la fenêtre, fermeture au clic
   * extérieur et à Échap, focus au clavier.
   */
  openItems(items: ContextMenuItem[], x: number, y: number): void {
    this.close()
    if (items.length === 0) return

    const menu = el('div', { class: `${NS}-popover ${NS}-menu ${NS}-context-menu`, attrs: { role: 'menu' } })
    for (const item of items) {
      if (item.separator) {
        menu.append(el('div', { class: `${NS}-menu-sep` }))
        continue
      }
      if (item.heading !== undefined) {
        menu.append(el('div', { class: `${NS}-menu-heading`, attrs: { role: 'presentation' }, text: item.heading }))
        continue
      }
      let icone: Node = el('span', { class: `${NS}-icon` })
      if (item.iconNode) {
        icone = el('span', { class: `${NS}-icon ${NS}-icon-host`, children: [item.iconNode()] })
      } else if (item.icon) {
        icone = this.ctx.icon(item.icon)
      }
      menu.append(el('button', {
        class: `${NS}-menu-item`,
        attrs: { type: 'button', role: 'menuitem', disabled: item.disabled, title: item.title },
        children: [icone, el('span', { text: item.label ?? '' })],
        on: {
          click: () => { this.close(); void item.action?.() },
        },
      }))
    }

    this.ctx.portal().append(menu)
    this.element = menu
    this.positionAtPointer(menu, x, y)
    this.dispose = onDismiss(menu, () => this.close())
    menu.querySelector<HTMLElement>('button:not([disabled])')?.focus()
  }

  open(event: MouseEvent, menuContext: ContextMenuContext): void {
    this.close()
    const items = this.itemsFor(menuContext)
    if (items.length === 0) return

    // On ne supprime le menu natif que si l'on a quelque chose à proposer.
    event.preventDefault()
    this.openItems(items, event.clientX, event.clientY)
  }

  /**
   * Même menu qu'au clic droit, ouvert à une position donnée : c'est la
   * porte de l'appui long, qui n'a pas d'événement `contextmenu` à annuler.
   */
  openAt(menuContext: ContextMenuContext, x: number, y: number): void {
    this.close()
    this.openItems(this.itemsFor(menuContext), x, y)
  }

  /** Délai de l'appui long, ou `null` s'il est désactivé. */
  longPressDelay(): number | null {
    const v = this.options.longPress
    if (v === false) return null
    return typeof v === 'number' && v > 0 ? v : 500
  }

  /**
   * Entrées par défaut qui valent pour une LIGNE, sans cellule visée :
   * copier la ligne (avec ou sans en-têtes), exporter.
   *
   * C'est ce que reçoit la colonne d'actions (`rowActions.items`) : le bouton
   * « ⋮ » n'est posé sur aucune cellule, « copier la cellule » n'y a donc pas
   * de sens — tout le reste, si. Les valeurs sont lues au moment du clic, pas
   * à la construction : la colonne d'actions demande ses entrées à chaque
   * rendu de ligne, et formater toute la ligne pour un menu qu'on n'ouvrira
   * pas serait du travail perdu.
   */
  rowDefaults(row: AnyRow): ContextMenuItem[] {
    return this.defaults(row, null)
  }

  private itemsFor(menuContext: ContextMenuContext): ContextMenuItem[] {
    const defaults = this.defaults(menuContext.row, menuContext)
    return this.options.items ? this.options.items(menuContext, defaults) : defaults
  }

  private defaults(row: AnyRow, cellule: ContextMenuContext | null): ContextMenuItem[] {
    const t = this.ctx.t
    const rowValues = () => this.ctx.columns.getRenderColumns()
      .map(c => this.formatFor(c.def, row))
    const headers = () => this.ctx.columns.getRenderColumns()
      .map(c => t.header(c.def.header ?? c.def.id))

    const defaults: ContextMenuItem[] = []

    if (this.options.copyItems !== false) {
      if (cellule) {
        defaults.push({
          label: t.t('copyCell'),
          icon: 'copy',
          action: () => this.copy(cellule.formattedValue),
        })
      }
      defaults.push(
        {
          label: t.t('copyRow'),
          icon: 'copy-row',
          action: () => this.copy(toTsv(rowValues())),
        },
        {
          label: t.t('copyRowWithHeaders'),
          icon: 'copy-table',
          action: () => this.copy(`${toTsv(headers())}\n${toTsv(rowValues())}`),
        },
      )
    }

    const exporter = this.options.exportItems !== false
    const imprimer = this.options.printItem !== false
    if (exporter || imprimer) {
      if (defaults.length > 0) defaults.push({ separator: true })
      // `useSelection` actif et lignes cochées : le libellé annonce le
      // périmètre réduit — sans lui, rien ne dirait pourquoi le fichier ne
      // contient que trois lignes. Les entrées sont construites à chaque
      // ouverture du menu, le suffixe suit donc l'état de la sélection.
      const coche = this.ctx.api.getSelectedRows().length > 0
      const sufExport = this.ctx.options.export?.useSelection && coche ? ` ${t.t('selectionSuffix')}` : ''
      const sufPrint = this.ctx.options.print?.useSelection && coche ? ` ${t.t('selectionSuffix')}` : ''
      if (exporter) {
        defaults.push(
          { label: `${t.t('exportExcel')}${sufExport}`, icon: 'excel', action: () => this.ctx.api.exportExcel() },
          { label: `${t.t('exportCsv')}${sufExport}`, icon: 'csv', action: () => this.ctx.api.exportCsv() },
        )
      }
      // Avec l'export : c'est la même question (« sortir cette liste »), et
      // le même périmètre — toute la liste filtrée, pas la ligne cliquée.
      if (imprimer) {
        defaults.push({ label: `${t.t('print')}${sufPrint}`, icon: 'print', action: () => this.ctx.api.print() })
      }
    }
    return defaults
  }

  /**
   * Ancre le menu au curseur, en le rabattant s'il déborde de la fenêtre —
   * ou de la zone donnée par `menuBoundary` (bandeau fixe de l'hôte).
   */
  private positionAtPointer(menu: HTMLElement, x: number, y: number): void {
    const boundary = this.options.menuBoundary?.()
    const minTop = Math.max(8, boundary?.top ?? 8)
    const maxBottom = Math.min(window.innerHeight - 8, boundary?.bottom ?? window.innerHeight - 8)

    menu.style.position = 'fixed'
    menu.style.visibility = 'hidden'
    menu.style.left = '0px'
    menu.style.top = '0px'
    // Jamais plus haut que la zone utile : au-delà, le contenu défile
    // (l'overflow est dans la feuille de style du menu).
    menu.style.maxHeight = `${Math.round(maxBottom - minTop)}px`
    const rect = menu.getBoundingClientRect()

    const left = x + rect.width > window.innerWidth - 8
      ? Math.max(8, x - rect.width)
      : x
    let top = y + rect.height > maxBottom
      ? y - rect.height
      : y
    // Le rabat vers le haut peut passer sous le bandeau : on borne, et la
    // `max-height` garantit que le bas reste dans la zone.
    top = Math.max(minTop, top)

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
    this.ctx.toast(ok ? this.ctx.t.t('copied') : this.ctx.t.t('copyFailed'),
                   { kind: ok ? 'success' : 'error' })
  }

}
