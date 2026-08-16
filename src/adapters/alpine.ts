import { IsoGrid } from '../ui/grid'
import { createLivewireDatasource, type WireProxy } from './livewire'
import type { AnyRow, GridState, IsoGridOptions } from '../core/types'

/**
 * Adaptateur Alpine.js.
 *
 * Permet de monter une grille depuis une vue Blade sans écrire une ligne de
 * JavaScript applicatif :
 *
 * ```blade
 * <div x-data="isogrid({ columns: @js($columns), source: 'livewire' })"
 *      x-init="mount()" class="h-[70vh]"></div>
 * ```
 *
 * Le composant se charge du montage, du démontage (`destroy` sur
 * `x-destroy`), et — quand la grille vit dans un composant Livewire — du
 * branchement automatique sur `$wire`.
 */

export interface IsoGridAlpineConfig extends Omit<IsoGridOptions<AnyRow>, 'datasource'> {
  /**
   * - `'livewire'` : appelle les méthodes du composant Livewire porteur
   * - une chaîne : URL d'un point d'entrée HTTP
   * - omis : mode client, avec `rows`
   */
  source?: 'livewire' | string

  /**
   * Clé de persistance dans `localStorage`. L'état (colonnes, tri, filtres)
   * y est relu au montage et réécrit à chaque changement.
   */
  persistKey?: string

  /** URL d'un ExcelJS embarqué, pour les hôtes qui ne résolvent pas les identifiants nus. */
  excelJsUrl?: string
}

interface AlpineComponent {
  $el: HTMLElement
  $wire?: WireProxy
  grid: IsoGrid | null
  config: IsoGridAlpineConfig
  mount(): void
  destroy(): void
}

/** Contrat minimal de l'objet Alpine dont nous avons besoin. */
export interface AlpineLike {
  data(name: string, callback: (...args: never[]) => unknown): void
}

export function isoGridAlpineComponent(config: IsoGridAlpineConfig) {
  return {
    grid: null as IsoGrid | null,
    config,

    mount(this: AlpineComponent) {
      const cfg = this.config

      const restored = cfg.persistKey ? readState(cfg.persistKey) : undefined

      const options: IsoGridOptions<AnyRow> = {
        ...cfg,
        initialState: restored ?? cfg.initialState,
        onStateChange: (state) => {
          if (cfg.persistKey) writeState(cfg.persistKey, state)
          cfg.onStateChange?.(state)
        },
      }

      if (cfg.source === 'livewire') {
        options.rowModel = 'server'
        // `$wire` est résolu paresseusement : au moment du `x-init`, Livewire
        // n'a pas toujours fini d'attacher le composant.
        options.datasource = createLivewireDatasource({ wire: () => this.$wire })
      } else if (typeof cfg.source === 'string') {
        options.rowModel = 'server'
        options.datasource = cfg.source
      }

      // Un renderer déclaré depuis Blade ne peut être qu'une CHAÎNE : PHP ne
      // sérialise pas de fonction. On la résout en fonction globale, et on
      // lui passe `$wire` en second argument — c'est ce qui permet à un
      // panneau de détail d'appeler une méthode du composant Livewire porteur
      // sans qu'on ait à déclarer une route.
      const md = cfg.masterDetail as (typeof cfg.masterDetail & { renderer: unknown }) | undefined
      if (md && typeof md.renderer === 'string') {
        const name = md.renderer
        const fn = (window as unknown as Record<string, unknown>)[name]
        if (typeof fn !== 'function') {
          throw new Error(`IsoGrid: le renderer de détail « ${name} » est introuvable sur window.`)
        }
        options.masterDetail = {
          ...md,
          renderer: (ctx) => (fn as (c: unknown, w: unknown) => Node | string)(ctx, this.$wire),
        }
      }

      if (cfg.excelJsUrl) {
        options.export = {
          ...cfg.export,
          excelJs: () => import(/* @vite-ignore */ cfg.excelJsUrl!),
        }
      }

      this.grid = new IsoGrid(this.$el, options)
    },

    destroy(this: AlpineComponent) {
      this.grid?.destroy()
      this.grid = null
    },
  }
}

function readState(key: string): Partial<GridState> | undefined {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as Partial<GridState> : undefined
  } catch {
    // Stockage indisponible (mode privé, quota) : on démarre sur l'état par
    // défaut plutôt que d'empêcher la grille de s'afficher.
    return undefined
  }
}

function writeState(key: string, state: GridState): void {
  try {
    localStorage.setItem(key, JSON.stringify(state))
  } catch {
    /* silencieux : la persistance est un confort, pas une fonction critique */
  }
}

/**
 * Enregistre le composant auprès d'Alpine.
 *
 * À appeler avant `Alpine.start()`. Si Alpine est déjà démarré (cas courant
 * avec Livewire, qui le démarre lui-même), l'appel reste valide : Alpine
 * accepte l'enregistrement tardif pour les composants montés ensuite.
 */
export function registerIsoGridAlpine(alpine: AlpineLike, name = 'isogrid'): void {
  alpine.data(name, isoGridAlpineComponent as never)
}

/**
 * Enregistrement automatique quand Alpine est déjà exposé globalement, ou
 * dès qu'il s'annonce via `alpine:init`. Couvre le cas Livewire/Filament, où
 * l'hôte ne nous laisse aucun point d'accroche sur le démarrage d'Alpine.
 */
export function autoRegisterIsoGridAlpine(name = 'isogrid'): void {
  const globalAlpine = (window as unknown as { Alpine?: AlpineLike }).Alpine
  if (globalAlpine) {
    registerIsoGridAlpine(globalAlpine, name)
    return
  }
  document.addEventListener('alpine:init', () => {
    const alpine = (window as unknown as { Alpine?: AlpineLike }).Alpine
    if (alpine) registerIsoGridAlpine(alpine, name)
  }, { once: true })
}
