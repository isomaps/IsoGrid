import { NS } from './dom'

/**
 * Bulles d'aide au-dessus des boutons à icône seule.
 *
 * Un pictogramme sans libellé ne se comprend qu'au survol. L'attribut `title`
 * natif y répond mal : il n'apparaît qu'après une bonne seconde d'immobilité,
 * pas du tout au clavier, et certains navigateurs le taisent dans un shadow
 * DOM. On affiche donc une vraie bulle, au-dessus de l'icône (en dessous s'il
 * n'y a pas la place), vite, et aussi au focus clavier.
 *
 * UN écouteur délégué sur la racine de la grille, pas un par bouton : la barre
 * d'outils, l'en-tête et les cellules se reconstruisent sans cesse, et les
 * boutons posés par l'hôte dans ses cellules (`cellRenderer`) en profitent
 * sans rien déclarer. Est concerné tout élément portant `title` (ou
 * `data-isg-tip`) qui est un bouton à icône : `.isg-icon-btn`, ou un élément
 * sans texte visible. Un lien ou un bouton qui porte déjà son libellé garde
 * le comportement natif — la bulle répéterait ce qu'on lit.
 *
 * Le `title` est déplacé dans `data-isg-tip` au premier survol, sinon le
 * navigateur afficherait sa propre bulle par-dessus la nôtre ; `aria-label`
 * est posé s'il manquait, pour que le nom accessible ne se perde pas. Un code
 * qui réécrit `title` plus tard (bascule du plein écran) est relu au survol
 * suivant.
 */

/** Délai avant la première bulle ; les suivantes, enchaînées, sont immédiates. */
const DELAI_MS = 350
/** Fenêtre pendant laquelle on passe d'une icône à l'autre sans attendre. */
const ENCHAINEMENT_MS = 600

export class Tooltips {
  private bulle?: HTMLElement
  private cible?: HTMLElement
  private minuteur?: number
  private derniereFermeture = 0

  constructor(
    private root: HTMLElement,
    private portal: () => HTMLElement | ShadowRoot,
  ) {
    root.addEventListener('pointerover', this.surSurvol)
    root.addEventListener('pointerout', this.surSortie)
    root.addEventListener('pointerdown', this.fermer)
    root.addEventListener('focusin', this.surFocus)
    root.addEventListener('focusout', this.fermer)
    window.addEventListener('scroll', this.fermer, true)
    document.addEventListener('keydown', this.surTouche)
  }

  destroy(): void {
    this.fermer()
    this.root.removeEventListener('pointerover', this.surSurvol)
    this.root.removeEventListener('pointerout', this.surSortie)
    this.root.removeEventListener('pointerdown', this.fermer)
    this.root.removeEventListener('focusin', this.surFocus)
    this.root.removeEventListener('focusout', this.fermer)
    window.removeEventListener('scroll', this.fermer, true)
    document.removeEventListener('keydown', this.surTouche)
  }

  private surSurvol = (e: PointerEvent): void => {
    // Au doigt, pas de survol : la bulle apparaîtrait au toucher et
    // resterait collée après l'action.
    if (e.pointerType === 'touch') return
    const cible = this.cibleDe(e.target)
    if (!cible || cible === this.cible) return
    this.programmer(cible)
  }

  private surSortie = (e: PointerEvent): void => {
    if (!this.cible) return
    const vers = e.relatedTarget as Node | null
    if (vers && this.cible.contains(vers)) return
    this.fermer()
  }

  private surFocus = (e: FocusEvent): void => {
    const cible = this.cibleDe(e.target)
    if (!cible) return
    // Au clavier seulement : un clic donne aussi le focus, et la bulle
    // surgirait sous le pointeur au moment où l'on vient d'agir.
    try { if (!cible.matches(':focus-visible')) return } catch { return }
    this.programmer(cible)
  }

  private surTouche = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.fermer()
  }

  private cibleDe(target: EventTarget | null): HTMLElement | null {
    let n = target instanceof Element ? target : null
    while (n && n !== this.root) {
      if (n instanceof HTMLElement && (n.hasAttribute('title') || n.hasAttribute('data-isg-tip'))) {
        return this.estIcone(n) ? n : null
      }
      n = n.parentElement
    }
    return null
  }

  private estIcone(n: HTMLElement): boolean {
    // Posé exprès, sans `title` : la bulle est voulue, quel que soit l'élément.
    if (n.hasAttribute('data-isg-tip') && !n.hasAttribute('title') && n.getAttribute('data-isg-tip')) return true
    if (n.classList.contains(`${NS}-icon-btn`)) return true
    const bouton = n.tagName === 'BUTTON' || n.getAttribute('role') === 'button' || n.tagName.includes('-')
    return bouton && (n.textContent ?? '').trim() === ''
  }

  private texteDe(n: HTMLElement): string {
    const title = n.getAttribute('title')
    if (title !== null) {
      n.setAttribute('data-isg-tip', title)
      n.removeAttribute('title')
      if (title && !n.hasAttribute('aria-label')) n.setAttribute('aria-label', title)
    }
    return n.getAttribute('data-isg-tip') ?? ''
  }

  private programmer(cible: HTMLElement): void {
    this.fermer()
    this.cible = cible
    // Le title part tout de suite : laissé là pendant le délai, c'est la
    // bulle native qui gagnerait la course.
    const texte = this.texteDe(cible)
    if (!texte) { this.cible = undefined; return }
    const chaud = Date.now() - this.derniereFermeture < ENCHAINEMENT_MS
    this.minuteur = window.setTimeout(() => this.afficher(cible, texte), chaud ? 0 : DELAI_MS)
  }

  private afficher(cible: HTMLElement, texte: string): void {
    if (!cible.isConnected) return
    const bulle = document.createElement('div')
    bulle.className = `${NS}-tooltip`
    bulle.setAttribute('role', 'tooltip')
    bulle.textContent = texte
    this.portal().append(bulle)
    this.bulle = bulle

    const r = cible.getBoundingClientRect()
    const b = bulle.getBoundingClientRect()
    const ecart = 6
    let top = r.top - b.height - ecart
    const dessous = top < 4
    if (dessous) top = r.bottom + ecart
    const centre = r.left + r.width / 2
    const left = Math.min(Math.max(4, centre - b.width / 2), window.innerWidth - b.width - 4)
    bulle.style.top = `${Math.round(top)}px`
    bulle.style.left = `${Math.round(left)}px`
    // La pointe reste sous l'icône même quand la bulle est rabattue au bord.
    bulle.style.setProperty('--isg-tip-x', `${Math.round(centre - left)}px`)
    if (dessous) bulle.classList.add(`${NS}-tooltip-below`)
  }

  private fermer = (): void => {
    if (this.minuteur) { clearTimeout(this.minuteur); this.minuteur = undefined }
    if (this.bulle) {
      this.bulle.remove()
      this.bulle = undefined
      this.derniereFermeture = Date.now()
    }
    this.cible = undefined
  }
}
