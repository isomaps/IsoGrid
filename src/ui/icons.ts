import type { IconName } from '../core/types'

/**
 * Jeu d'icônes embarqué.
 *
 * La première version rendait des classes Font Awesome, par convention
 * maison. Le défaut est apparu en production : le panneau Filament ne charge
 * pas Font Awesome, et les boutons se retrouvaient invisibles tout en restant
 * cliquables. Une bibliothèque destinée à être installée dans des hôtes
 * variés ne peut pas parier sur une police externe.
 *
 * Ces tracés sont donc dessinés ici, sans dépendance ni question de licence.
 * Ils héritent de `currentColor`, donc suivent la couleur du bouton porteur.
 * Un hôte qui veut ses propres pictogrammes passe `renderIcon` ; celui qui
 * veut Font Awteesome utilise `fontAwesomeIconRenderer`.
 */

interface IconSpec {
  d: string
  /** Icône pleine (remplie) plutôt que tracée au trait. */
  solid?: boolean
  /** Défaut : '0 0 16 16'. */
  viewBox?: string
}

/**
 * Tracés en viewBox 16×16, trait de 1.5, sans remplissage — sauf mention
 * contraire.
 *
 * `filter` et `columns` reprennent la géométrie des Heroicons « solid »
 * (MIT, Tailwind Labs) : ce sont les pictogrammes qu'emploient les tables
 * Filament, et la grille doit se fondre dans le même back-office.
 */
const PATHS: Record<IconName, string | IconSpec> = {
  'sort-asc': 'M8 13V3.5M4.5 7 8 3.5 11.5 7',
  'sort-desc': 'M8 3v9.5M4.5 9 8 12.5 11.5 9',
  'sort-none': 'M5 6.75 8 3.75l3 3M5 9.25l3 3 3-3',
  'filter': {
    solid: true,
    viewBox: '0 0 24 24',
    d: 'M3.792 2.938A49.069 49.069 0 0 1 12 2.25c2.797 0 5.54.236 8.209.688a1.857 1.857 0 0 1 1.541 1.836v1.044a3 3 0 0 1-.879 2.121l-6.182 6.182a1.5 1.5 0 0 0-.439 1.061v2.927a3 3 0 0 1-1.658 2.684l-1.757.878A.75.75 0 0 1 9.75 21v-5.818a1.5 1.5 0 0 0-.44-1.06L3.13 7.938a3 3 0 0 1-.879-2.121V4.774c0-.98.723-1.796 1.542-1.836Z',
  },
  'filter-active': {
    solid: true,
    viewBox: '0 0 24 24',
    d: 'M3.792 2.938A49.069 49.069 0 0 1 12 2.25c2.797 0 5.54.236 8.209.688a1.857 1.857 0 0 1 1.541 1.836v1.044a3 3 0 0 1-.879 2.121l-6.182 6.182a1.5 1.5 0 0 0-.439 1.061v2.927a3 3 0 0 1-1.658 2.684l-1.757.878A.75.75 0 0 1 9.75 21v-5.818a1.5 1.5 0 0 0-.44-1.06L3.13 7.938a3 3 0 0 1-.879-2.121V4.774c0-.98.723-1.796 1.542-1.836Z',
  },
  // Trois lignes dégressives : c'est le pictogramme de filtre qu'emploie AG
  // Grid dans ses en-têtes. Beaucoup plus lisible qu'un entonnoir à 11 px, où
  // celui-ci se réduit à un triangle indistinct.
  'filter-column': 'M2.5 4.5h11M4.5 8h7M6.5 11.5h3',
  'menu': 'M8 4.2h.01M8 8h.01M8 11.8h.01',
  'columns': {
    solid: true,
    viewBox: '0 0 24 24',
    d: 'M15 3.75H9v16.5h6V3.75ZM16.5 20.25h3.375c1.035 0 1.875-.84 1.875-1.875V5.625c0-1.035-.84-1.875-1.875-1.875H16.5v16.5ZM4.125 3.75H7.5v16.5H4.125a1.875 1.875 0 0 1-1.875-1.875V5.625c0-1.035.84-1.875 1.875-1.875Z',
  },
  'sidebar': 'M2.5 3h11v10h-11zM10 3v10',
  'close': 'M4 4l8 8M12 4l-8 8',
  'search': 'M11.5 11.5 14 14M12.5 7.25a5.25 5.25 0 1 1-10.5 0 5.25 5.25 0 0 1 10.5 0z',
  'pin-start': 'M2.5 2.5v11M13.5 8H6M9 4.5 5.5 8 9 11.5',
  'pin-end': 'M13.5 2.5v11M2.5 8H10M7 4.5 10.5 8 7 11.5',
  'unpin': 'M2.5 2.5v11M6.5 5.5l7 5M13.5 5.5l-7 5',
  'export': 'M8 10.5V2.5M5 5.5 8 2.5l3 3M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10',
  'excel': 'M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5zM9 1.5v4h4M6 8l4 4.5M10 8l-4 4.5',
  'csv': 'M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5zM9 1.5v4h4M5.5 9h5M5.5 11.5h3',
  // Deux feuillets superposés : le geste « copier » universel.
  'copy': 'M5.75 5.75h7.75v7.75H5.75zM2.5 10.25v-7.5a.25.25 0 0 1 .25-.25h7.5v2.25',
  // Un tableau dont une bande est isolée : la ligne.
  'copy-row': 'M2 4.25h12v7.5H2zM2 8h12',
  // Tableau avec bandeau d'en-tête : la ligne AVEC ses en-têtes.
  'copy-table': 'M2 3.5h12v9H2zM2 6.5h12M6.5 6.5v6',
  'check': 'M3.5 8.5l3 3 6-6.5',
  'chevron-down': 'M4 6l4 4 4-4',
  'chevron-right': 'M6 3.5 10.5 8 6 12.5',
  'eye': 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM9.75 8a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0z',
  'eye-off': 'M6.4 4a5.9 5.9 0 0 1 1.6-.2c4 0 6.5 4.2 6.5 4.2a12 12 0 0 1-2 2.5M3.8 5.3A12 12 0 0 0 1.5 8S4 12.2 8 12.2c.9 0 1.7-.2 2.4-.5M2 2l12 12',
  'grip': 'M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01',
  'spinner': 'M8 1.75a6.25 6.25 0 1 0 6.25 6.25',
  'warning': 'M8 2.5 1.75 13.5h12.5zM8 6.5v3.2M8 11.6h.01',
}

/** Icônes dont le tracé se lit comme des points plutôt que des lignes. */
const DOTTED = new Set<IconName>(['menu', 'grip'])

function svg(name: IconName): SVGSVGElement {
  const raw = PATHS[name]
  const spec: IconSpec = typeof raw === 'string' ? { d: raw } : raw

  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  node.setAttribute('viewBox', spec.viewBox ?? '0 0 16 16')
  node.setAttribute('width', '1em')
  node.setAttribute('height', '1em')
  node.setAttribute('fill', 'none')
  node.setAttribute('aria-hidden', 'true')
  node.setAttribute('focusable', 'false')
  node.classList.add('isg-icon', `isg-icon-${name}`)

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', spec.d)
  if (spec.solid) {
    path.setAttribute('fill', 'currentColor')
  } else {
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    // Un « point » se dessine avec un segment nul et une extrémité ronde
    // épaisse : plus léger que six éléments <circle>.
    path.setAttribute('stroke-width', DOTTED.has(name) ? '2' : '1.5')
  }
  node.append(path)

  return node
}

export function builtinIconRenderer(name: IconName): Node {
  return svg(name)
}

/* ------------------------------------------------------------------------ */
/* Variante Font Awesome                                                     */
/* ------------------------------------------------------------------------ */

const FA: Record<IconName, string> = {
  'sort-asc': 'fa-solid fa-arrow-up-short-wide',
  'sort-desc': 'fa-solid fa-arrow-down-wide-short',
  'sort-none': 'fa-solid fa-sort',
  'filter': 'fa-solid fa-filter',
  'filter-column': 'fa-solid fa-filter',
  'filter-active': 'fa-solid fa-filter-circle-xmark',
  'menu': 'fa-solid fa-ellipsis-vertical',
  'columns': 'fa-solid fa-table-columns',
  'sidebar': 'fa-solid fa-bars-staggered',
  'close': 'fa-solid fa-xmark',
  'search': 'fa-solid fa-magnifying-glass',
  'pin-start': 'fa-solid fa-arrow-left-to-line',
  'pin-end': 'fa-solid fa-arrow-right-to-line',
  'unpin': 'fa-solid fa-thumbtack-slash',
  'export': 'fa-solid fa-file-export',
  'excel': 'fa-solid fa-file-excel',
  'csv': 'fa-solid fa-file-csv',
  'copy': 'fa-regular fa-copy',
  'copy-row': 'fa-solid fa-table-list',
  'copy-table': 'fa-solid fa-table',
  'check': 'fa-solid fa-check',
  'chevron-down': 'fa-solid fa-chevron-down',
  'chevron-right': 'fa-solid fa-chevron-right',
  'eye': 'fa-solid fa-eye',
  'eye-off': 'fa-solid fa-eye-slash',
  'grip': 'fa-solid fa-grip-vertical',
  'spinner': 'fa-solid fa-circle-notch fa-spin',
  'warning': 'fa-solid fa-triangle-exclamation',
}

/**
 * À passer en `renderIcon` dans un hôte où Font Awesome est chargé, pour que
 * la grille adopte la même fonte d'icônes que le reste de l'interface.
 */
export function fontAwesomeIconRenderer(name: IconName): Node {
  const node = document.createElement('i')
  node.className = `${FA[name]} isg-icon`
  node.setAttribute('aria-hidden', 'true')
  return node
}
