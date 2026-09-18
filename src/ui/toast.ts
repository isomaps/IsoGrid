/**
 * Confirmation brève, en bas de la grille.
 *
 * Une action déclenchée depuis un tableau — copier, enregistrer, supprimer,
 * exporter — ne laisse souvent aucune trace à l'écran : la ligne a déjà l'air
 * juste avant comme après. Sans un mot, l'utilisateur ne sait pas si son geste
 * a porté, et le refait.
 *
 * Volontairement fugace et sans bouton : ce n'est pas une décision à prendre,
 * c'est un accusé de réception. Ce qui demande une action de l'utilisateur
 * mérite un vrai dialogue, pas ceci.
 */

import { NS, el } from './dom'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastOptions {
  kind?: ToastKind
  /** Durée d'affichage, en ms. Défaut : 1600, 3000 pour une erreur. */
  duration?: number
}

/** Durée de la transition de sortie, qui doit suivre le CSS. */
const SORTIE_MS = 250

export class ToastHost {
  /** Le dernier message affiché, remplacé par le suivant. */
  private courant?: { node: HTMLElement, timer: number }

  constructor(
    private portal: () => HTMLElement | ShadowRoot,
    private icon: (name: 'check' | 'warning') => Node,
  ) {}

  show(message: string, options: ToastOptions = {}): void {
    const kind = options.kind ?? 'success'
    /* Une erreur reste plus longtemps : elle demande à être lue, pas seulement
       aperçue du coin de l'œil. */
    const duration = options.duration ?? (kind === 'error' ? 3000 : 1600)

    /* Un seul message à la fois : deux enregistrements rapprochés ne doivent
       pas empiler deux bulles l'une sur l'autre. */
    this.clear()

    const node = el('div', {
      class: [`${NS}-toast`, kind === 'error' ? `${NS}-toast-error` : '',
              kind === 'info' ? `${NS}-toast-info` : ''].filter(Boolean).join(' '),
      attrs: { role: 'status', 'aria-live': kind === 'error' ? 'assertive' : 'polite' },
      children: [
        this.icon(kind === 'error' ? 'warning' : 'check'),
        el('span', { text: message }),
      ],
    })
    this.portal().append(node)

    const timer = window.setTimeout(() => {
      node.classList.add(`${NS}-toast-out`)
      window.setTimeout(() => node.remove(), SORTIE_MS)
      this.courant = undefined
    }, duration)

    this.courant = { node, timer }
  }

  /** Retire le message affiché, sans attendre. */
  clear(): void {
    if (!this.courant) return
    window.clearTimeout(this.courant.timer)
    this.courant.node.remove()
    this.courant = undefined
  }

  destroy(): void { this.clear() }
}
