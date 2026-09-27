import type { SavedView, SavedViewsAdapter } from '../core/saved-views'
import type { GridContext } from './context'
import { NS, el, onDismiss, positionFloating } from './dom'

/**
 * Ce dont le menu a besoin, fourni par la grille.
 *
 * Le menu ne touche jamais l'état de la grille lui-même : il demande, la
 * grille applique. C'est ce qui garantit que la vue appliquée depuis le menu
 * et celle appliquée par `selectView()` suivent exactement le même chemin.
 */
export interface SavedViewsController {
  adapter: SavedViewsAdapter
  views(): SavedView[]
  loaded(): boolean
  refresh(): Promise<void>
  activeId(): string | null
  /** L'état affiché s'écarte de la vue active (ou de l'origine). */
  isModified(): boolean
  select(id: string | null): Promise<boolean>
  /** Enregistre. `captureState` : l'état COURANT ; sinon celui déjà stocké dans la vue. */
  save(input: { id?: string; name: string; shared: boolean }, captureState: boolean): Promise<SavedView>
  remove(id: string): Promise<void>
  setDefault(id: string | null): Promise<void>
}

/**
 * Menu « Vues » de la barre d'outils, et sa boîte de dialogue.
 *
 * Les flottants sont montés dans `ctx.portal()` — le shadow root de la grille
 * s'il y en a un — et fermés via `onDismiss`, qui lit `composedPath()` : les
 * deux conditions pour qu'ils restent stylés et cliquables dans un shadow DOM
 * (cf. 0.15.1).
 */
export class SavedViewsMenu {
  private button?: HTMLButtonElement
  private closeMenu?: () => void
  /**
   * Instant de la dernière fermeture. Un clic sur le bouton alors que le menu
   * est ouvert le ferme d'abord (clic « dehors »), puis arrive au bouton :
   * sans ce repère, le menu se rouvrirait aussitôt.
   */
  private closedAt = 0

  constructor(private ctx: GridContext, private ctl: SavedViewsController) {}

  /** Construit le bouton ; appelé à chaque rendu de la barre d'outils. */
  buildButton(): HTMLElement {
    this.button = el('button', {
      class: `${NS}-btn ${NS}-views-btn`,
      attrs: { type: 'button', 'aria-haspopup': 'menu' },
      on: { click: (e: MouseEvent) => this.toggle(e.currentTarget as HTMLElement) },
    })
    this.sync()
    return this.button
  }

  /** Remet libellé et marque « modifiée » en phase, sans reconstruire la barre. */
  sync(): void {
    const btn = this.button
    if (!btn) return
    const t = this.ctx.t
    const active = this.activeView()
    // Sur la vue d'origine le bouton ne porte pas de marque : inutile de
    // comparer à chaque changement.
    const modified = active ? this.ctl.isModified() : false
    const name = active?.name ?? t.t('views')

    const children: Node[] = [this.ctx.icon('views'), el('span', { class: `${NS}-views-name`, text: name })]
    if (active && modified) {
      children.push(el('span', { class: `${NS}-views-modified`, text: t.t('viewModified') }))
    }
    children.push(this.ctx.icon('chevron-down'))
    btn.replaceChildren(...children)
    btn.classList.toggle(`${NS}-active`, !!active)
    const title = active
      ? `${t.t('views')} : ${active.name}${modified ? ` (${t.t('viewModified')})` : ''}`
      : t.t('views')
    btn.setAttribute('title', title)
    btn.setAttribute('aria-label', title)
  }

  close(): void {
    this.closeMenu?.()
  }

  private activeView(): SavedView | null {
    const id = this.ctl.activeId()
    return id === null ? null : this.ctl.views().find(v => v.id === id) ?? null
  }

  private themed<T extends HTMLElement>(node: T): T {
    const theme = this.button?.closest(`.${NS}-root`)?.getAttribute('data-isg-theme')
    if (theme) node.setAttribute('data-isg-theme', theme)
    return node
  }

  private toggle(anchor: HTMLElement): void {
    if (this.closeMenu) { this.closeMenu(); return }
    if (performance.now() - this.closedAt < 300) return
    // Liste pas encore arrivée (adaptateur lent au montage, ou en échec) :
    // on la redemande, et le menu s'ouvre avec ce qu'on a.
    if (!this.ctl.loaded()) {
      void this.ctl.refresh().then(() => this.open(anchor))
      return
    }
    this.open(anchor)
  }

  private item(
    label: string,
    action: () => void,
    opts: { icon?: Node | null; active?: boolean; extra?: Node[]; disabled?: boolean } = {},
  ): HTMLElement {
    return el('button', {
      class: `${NS}-menu-item${opts.active ? ` ${NS}-active` : ''}`,
      attrs: { type: 'button', role: 'menuitem', disabled: opts.disabled ? true : undefined },
      children: [
        opts.icon ?? el('span', { class: `${NS}-icon ${NS}-views-spacer` }),
        el('span', { class: `${NS}-views-label`, text: label }),
        ...(opts.extra ?? []),
      ],
      on: { click: () => { if (!opts.disabled) action() } },
    })
  }

  private open(anchor: HTMLElement): void {
    const t = this.ctx.t
    const menu = this.themed(el('div', {
      class: `${NS}-popover ${NS}-menu ${NS}-views-menu`,
      attrs: { role: 'menu' },
    }))
    let dispose = () => {}
    const close = (parClicExterieur = false) => {
      dispose()
      menu.remove()
      this.closeMenu = undefined
      if (parClicExterieur) this.closedAt = performance.now()
    }
    this.closeMenu = () => close()
    const run = (fn: () => void) => () => { close(); fn() }

    const activeId = this.ctl.activeId()
    const active = this.activeView()
    const modified = this.ctl.isModified()
    const views = this.ctl.views()

    const marks = (v: SavedView): Node[] => {
      const out: Node[] = []
      if (v.id === activeId && modified) {
        out.push(el('span', { class: `${NS}-views-modified`, text: t.t('viewModified') }))
      }
      if (v.isDefault) {
        const star = el('span', { class: `${NS}-views-star`, attrs: { title: t.t('defaultView') } })
        star.append(this.ctx.icon('star'))
        out.push(star)
      }
      return out
    }
    const viewItem = (v: SavedView) => this.item(
      v.name,
      run(() => { void this.ctl.select(v.id) }),
      { icon: v.id === activeId ? this.ctx.icon('check') : null, active: v.id === activeId, extra: marks(v) },
    )

    menu.append(this.item(
      t.t('viewOriginal'),
      run(() => { void this.ctl.select(null) }),
      {
        icon: activeId === null ? this.ctx.icon('check') : null,
        active: activeId === null,
        extra: activeId === null && modified
          ? [el('span', { class: `${NS}-views-modified`, text: t.t('viewModified') })]
          : [],
      },
    ))

    const mine = views.filter(v => !v.shared)
    const shared = views.filter(v => v.shared)
    const section = (title: string, list: SavedView[]) => {
      if (list.length === 0) return
      menu.append(el('div', { class: `${NS}-views-section`, text: title }), ...list.map(viewItem))
    }
    section(t.t('myViews'), mine)
    section(t.t('sharedViews'), shared)
    if (views.length === 0) {
      menu.append(el('div', { class: `${NS}-views-empty`, text: t.t('noSavedViews') }))
    }

    menu.append(el('div', { class: `${NS}-menu-sep` }))

    if (active?.editable) {
      menu.append(this.item(t.t('saveView'), run(() => { void this.saveOver(active) }), { disabled: !modified }))
      menu.append(this.item(t.t('saveViewAs'), run(() => this.openDialog('new'))))
      menu.append(this.item(t.t('renameView'), run(() => this.openDialog('rename', active))))
      menu.append(this.item(t.t('deleteView'), run(() => this.confirmDelete(active))))
    } else {
      menu.append(this.item(active ? t.t('saveViewAs') : t.t('saveNewView'), run(() => this.openDialog('new'))))
    }

    if (active) {
      menu.append(active.isDefault
        ? this.item(t.t('clearDefaultView'), run(() => { void this.act(() => this.ctl.setDefault(null)) }))
        : this.item(t.t('setDefaultView'), run(() => { void this.act(() => this.ctl.setDefault(active.id)) })))
    } else if (views.some(v => v.isDefault)) {
      // Sur la vue d'origine alors qu'une autre vue ouvre la grille : on
      // propose d'en faire à nouveau le point de départ.
      menu.append(this.item(t.t('clearDefaultView'), run(() => { void this.act(() => this.ctl.setDefault(null)) })))
    }

    this.ctx.portal().append(menu)
    positionFloating(anchor, menu)
    dispose = onDismiss(menu, () => close(true))
    menu.querySelector<HTMLElement>('button:not([disabled])')?.focus()
  }

  /** Exécute une action de l'adaptateur ; un échec devient une bulle, pas une exception. */
  private async act<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
    try {
      const out = await fn()
      if (success) this.ctx.toast(success, { kind: 'success' })
      return out
    } catch (error) {
      console.warn('[IsoGrid] vues enregistrées :', error)
      this.ctx.toast(this.ctx.t.t('viewActionFailed'), { kind: 'error' })
      return undefined
    } finally {
      this.sync()
    }
  }

  private saveOver(view: SavedView): Promise<unknown> {
    return this.act(
      () => this.ctl.save({ id: view.id, name: view.name, shared: view.shared }, true),
      this.ctx.t.t('viewSaved'),
    )
  }

  private confirmDelete(view: SavedView): void {
    const t = this.ctx.t
    this.dialog({
      title: t.t('deleteViewConfirm'),
      message: view.name,
      confirmLabel: t.t('deleteView'),
      danger: true,
      submit: async () => {
        await this.ctl.remove(view.id)
        this.ctx.toast(t.t('viewDeleted'), { kind: 'success' })
      },
    })
  }

  /**
   * Boîte « nom + partager ».
   *
   * `new` capture l'état affiché dans une nouvelle vue ; `rename` ne change
   * que le nom (et le partage) — l'état enregistré de la vue reste celui
   * qu'elle avait, même si l'écran a bougé depuis : renommer n'est pas
   * enregistrer.
   */
  private openDialog(mode: 'new' | 'rename', view?: SavedView): void {
    const t = this.ctx.t
    const adapter = this.ctl.adapter
    const input = el('input', {
      class: `${NS}-input ${NS}-views-input`,
      attrs: {
        type: 'text',
        value: mode === 'rename' ? view?.name ?? '' : '',
        placeholder: t.t('viewName'),
        'aria-label': t.t('viewName'),
        maxlength: 120,
      },
    })
    const share = el('input', {
      attrs: { type: 'checkbox', checked: view?.shared ? true : undefined },
    })
    const fields: Node[] = [input]
    if (adapter.canShare) {
      fields.push(el('label', {
        class: `${NS}-views-share`,
        children: [share, el('span', { text: adapter.sharedLabel ?? t.t('shareView') })],
      }))
    }

    this.dialog({
      title: mode === 'rename' ? t.t('renameView').replace(/…$/, '') : t.t('saveNewView').replace(/…$/, ''),
      fields,
      focus: input,
      confirmLabel: t.t('save'),
      submit: async () => {
        const name = input.value.trim()
        if (!name) { input.focus(); throw new DialogValidation(t.t('viewNameRequired')) }
        const shared = adapter.canShare ? share.checked : (view?.shared ?? false)
        if (mode === 'rename' && view) {
          await this.ctl.save({ id: view.id, name, shared }, false)
        } else {
          // Même nom qu'une vue qu'on peut modifier : on la met à jour plutôt
          // que d'en créer une seconde, indiscernable dans le menu.
          const homonyme = this.ctl.views().find(v =>
            v.editable && v.shared === shared && v.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0)
          await this.ctl.save({ id: homonyme?.id, name, shared }, true)
        }
        this.ctx.toast(t.t('viewSaved'), { kind: 'success' })
      },
    })
  }

  private dialog(opts: {
    title: string
    message?: string
    fields?: Node[]
    focus?: HTMLElement
    confirmLabel: string
    danger?: boolean
    submit: () => Promise<void>
  }): void {
    const t = this.ctx.t
    const error = el('div', { class: `${NS}-views-error`, attrs: { role: 'alert' } })
    const cancel = el('button', { class: `${NS}-btn`, attrs: { type: 'button' }, text: t.t('cancel') })
    const confirm = el('button', {
      class: `${NS}-btn ${NS}-btn-primary${opts.danger ? ` ${NS}-btn-danger` : ''}`,
      attrs: { type: 'submit' },
      text: opts.confirmLabel,
    })
    const form = el('form', {
      class: `${NS}-views-form`,
      children: [
        el('div', { class: `${NS}-popover-title`, text: opts.title }),
        opts.message ? el('div', { class: `${NS}-views-message`, text: opts.message }) : null,
        ...(opts.fields ?? []),
        error,
        el('div', { class: `${NS}-views-actions`, children: [cancel, confirm] }),
      ],
    })
    const box = this.themed(el('div', {
      class: `${NS}-popover ${NS}-views-dialog`,
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
      children: [form],
    }))
    const backdrop = el('div', { class: `${NS}-views-backdrop` })

    let dispose = () => {}
    const close = () => { dispose(); box.remove(); backdrop.remove(); this.button?.focus() }
    cancel.addEventListener('click', close)
    form.addEventListener('submit', (e: Event) => {
      e.preventDefault()
      error.textContent = ''
      confirm.disabled = true
      cancel.disabled = true
      opts.submit().then(close, (err: unknown) => {
        confirm.disabled = false
        cancel.disabled = false
        if (err instanceof DialogValidation) { error.textContent = err.message; return }
        console.warn('[IsoGrid] vues enregistrées :', err)
        error.textContent = t.t('viewActionFailed')
      }).finally(() => this.sync())
    })

    this.ctx.portal().append(backdrop, box)
    // Échap et clic sur le fond ferment ; un clic dans la boîte, non.
    dispose = onDismiss(box, close)
    ;(opts.focus ?? confirm).focus()
    if (opts.focus instanceof HTMLInputElement) opts.focus.select()
  }
}

/** Refus de saisie : affiché dans la boîte, qui reste ouverte. */
class DialogValidation extends Error {}
