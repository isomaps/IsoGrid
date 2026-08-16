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

      // Une fonction déclarée depuis Blade ne peut être qu'une CHAÎNE : PHP ne
      // sérialise pas de fonction. On la résout en fonction globale et on lui
      // passe `$wire`, ce qui lui permet d'appeler une méthode du composant
      // Livewire porteur sans qu'on ait à déclarer de route. Le reste de la
      // configuration suit en troisième argument (URLs, libellés, options).
      const resoudre = (nom: string, quoi: string): CallableFunction => {
        const fn = (window as unknown as Record<string, unknown>)[nom]
        if (typeof fn !== 'function') {
          throw new Error(`IsoGrid: ${quoi} « ${nom} » est introuvable sur window.`)
        }
        return fn as CallableFunction
      }

      const md = cfg.masterDetail as (typeof cfg.masterDetail & { renderer: unknown }) | undefined
      if (md && typeof md.renderer === 'string') {
        const fn = resoudre(md.renderer, 'le renderer de détail')
        const { renderer: _ignore, ...reste } = md
        options.masterDetail = {
          ...md,
          renderer: (ctx) => fn(ctx, this.$wire, reste) as Node | string,
        }
      }

      // Les colonnes déclarées en PHP ne peuvent pas porter de fonction non
      // plus : `cellRenderer`, `valueFormatter` et `cellClass` acceptent donc
      // un nom de fonction globale. Chacune reçoit le contexte de cellule et
      // `$wire`, comme les autres points d'extension.
      const auFilDesColonnes = ['cellRenderer', 'valueFormatter', 'cellClass'] as const
      if (Array.isArray(cfg.columns)) {
        options.columns = cfg.columns.map((col) => {
          const brut = col as unknown as Record<string, unknown>
          let copie: Record<string, unknown> | null = null
          for (const cle of auFilDesColonnes) {
            if (typeof brut[cle] !== 'string') continue
            const fn = resoudre(brut[cle] as string, `le rendu de colonne « ${String(brut.id)} »`)
            copie ??= { ...brut }
            copie[cle] = (ctx: unknown) => fn(ctx, this.$wire)
          }
          return (copie ?? brut) as never
        })
      }

      const ra = cfg.rowActions as (typeof cfg.rowActions & { items: unknown }) | undefined
      if (ra && typeof ra.items === 'string') {
        const fn = resoudre(ra.items, 'le fournisseur d\'actions')
        const { items: _ignore, ...reste } = ra
        options.rowActions = {
          ...ra,
          items: (row, index) => (fn(row, this.$wire, reste, index) ?? []) as never,
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
