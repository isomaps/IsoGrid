import type { IconName } from '../core/types'
import { builtinIconRenderer } from './icons'

/** Préfixe unique de toutes les classes CSS de la lib. */
export const NS = 'isg'

export const cls = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).map(p => (p as string).startsWith(NS) ? p : `${NS}-${p}`).join(' ')

interface ElOptions {
  class?: string
  text?: string
  html?: string
  attrs?: Record<string, string | number | boolean | null | undefined>
  style?: Partial<CSSStyleDeclaration>
  on?: Partial<Record<keyof HTMLElementEventMap, (e: never) => void>>
  children?: Array<Node | string | null | undefined>
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (options.class) node.className = options.class
  if (options.text != null) node.textContent = options.text
  if (options.html != null) node.innerHTML = options.html
  if (options.attrs) {
    for (const [k, v] of Object.entries(options.attrs)) {
      if (v == null || v === false) continue
      node.setAttribute(k, v === true ? '' : String(v))
    }
  }
  if (options.style) Object.assign(node.style, options.style)
  if (options.on) {
    for (const [ev, handler] of Object.entries(options.on)) {
      node.addEventListener(ev, handler as EventListener)
    }
  }
  if (options.children) {
    for (const child of options.children) {
      if (child == null) continue
      node.append(child)
    }
  }
  return node
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

/** Échappement HTML. Tout ce qui vient de la donnée passe par là. */
export function escapeHtml(value: unknown): string {
  const s = value == null ? '' : String(value)
  return s.replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ))
}

/* ------------------------------------------------------------------------ */
/* Icônes                                                                    */
/* ------------------------------------------------------------------------ */

export type IconRenderer = (name: IconName) => Node | string

/**
 * Rend une icône. Par défaut le jeu SVG embarqué (voir `icons.ts`) : il
 * s'affiche partout, sans police externe à charger côté hôte.
 */
export function renderIcon(name: IconName, custom?: IconRenderer): Node {
  const out = custom ? custom(name) : builtinIconRenderer(name)
  if (typeof out === 'string') {
    const span = el('span', { class: `${NS}-icon`, html: out })
    span.setAttribute('aria-hidden', 'true')
    return span
  }
  return out
}

/* ------------------------------------------------------------------------ */
/* Petits utilitaires                                                        */
/* ------------------------------------------------------------------------ */

export function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): T & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const wrapped = ((...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...(args as never[])), wait)
  }) as T & { cancel(): void }
  wrapped.cancel = () => { if (timer) clearTimeout(timer) }
  return wrapped
}

/** Lit `a.b.c` dans un objet. Retourne `undefined` si un maillon manque. */
export function getPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined
  if (!path.includes('.')) return (obj as Record<string, unknown>)[path]
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur == null) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/**
 * Ferme un flottant (menu, popover) au prochain clic extérieur ou à Échap.
 * Retourne la fonction de démontage.
 */
export function onDismiss(target: HTMLElement, close: () => void): () => void {
  const onPointer = (e: PointerEvent) => {
    if (!target.contains(e.target as Node)) close()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close() }
  }
  // `capture: false` + setTimeout : sinon le clic qui a ouvert le menu le referme.
  setTimeout(() => {
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
  }, 0)
  return () => {
    document.removeEventListener('pointerdown', onPointer)
    document.removeEventListener('keydown', onKey)
  }
}

/** Repositionne un flottant pour qu'il reste dans la fenêtre. */
export function positionFloating(anchor: HTMLElement, floating: HTMLElement, gap = 4): void {
  const a = anchor.getBoundingClientRect()
  floating.style.position = 'fixed'
  floating.style.visibility = 'hidden'
  floating.style.left = '0px'
  floating.style.top = '0px'
  const f = floating.getBoundingClientRect()

  let left = a.left
  let top = a.bottom + gap
  if (left + f.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - f.width - 8)
  if (top + f.height > window.innerHeight - 8) {
    const above = a.top - f.height - gap
    top = above > 8 ? above : Math.max(8, window.innerHeight - f.height - 8)
  }
  floating.style.left = `${Math.round(left)}px`
  floating.style.top = `${Math.round(top)}px`
  floating.style.visibility = ''
}
