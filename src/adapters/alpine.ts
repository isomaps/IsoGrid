import { IsoGrid } from '../ui/grid'
import { createLivewireDatasource, type WireProxy } from './livewire'
import {
  createHttpStateStore, createLocalStateStore, isPromiseLike, type GridStateStore,
} from '../core/state-store'
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

export interface IsoGridAlpineConfig extends Omit<IsoGridOptions<AnyRow>, 'datasource' | 'stateStore'> {
  /**
   * Nom du paramètre d'URL où refléter l'état (filtres, tri, recherche).
   *
   * Une vue filtrée devient alors partageable et survit à un rechargement —
   * ce que le seul `localStorage` ne permet pas : il garde l'état pour SOI,
   * pas pour le lien qu'on envoie à quelqu'un.
   *
   * L'URL a priorité sur le stockage local : un lien reçu doit montrer ce
   * qu'il promet, même si l'on a laissé d'autres filtres en place la veille.
   */
  urlParam?: string
  /**
   * - `'livewire'` : appelle les méthodes du composant Livewire porteur
   * - une chaîne : URL d'un point d'entrée HTTP
   * - omis : mode client, avec `rows`
   */
  source?: 'livewire' | string

  /**
   * Clé de persistance dans `localStorage`. L'état (colonnes, tri, filtres)
   * y est relu au montage et réécrit à chaque changement.
   *
   * Per-navigateur et per-poste : pour que l'utilisateur retrouve ses réglages
   * ailleurs, lui préférer `stateUrl` (ou `stateStore`).
   */
  persistKey?: string

  /**
   * Point d'entrée qui garde l'état côté hôte : GET pour le relire, POST
   * `{ key, state }` pour l'écrire. L'utilisateur retrouve alors ses colonnes
   * et ses filtres depuis n'importe quel poste.
   *
   * `persistKey` sert ici de discriminant quand plusieurs grilles partagent le
   * même point d'entrée.
   */
  stateUrl?: string

  /**
   * Dépôt d'état complet. Depuis Blade, `load` et `save` s'y déclarent comme
   * ailleurs : par NOM de fonction globale, PHP ne sérialisant pas de
   * fonction. Chacune reçoit `$wire` en dernier argument.
   */
  stateStore?: GridStateStore | { load?: string; save?: string; debounce?: number; loadTimeout?: number }

  /** URL d'un ExcelJS embarqué, pour les hôtes qui ne résolvent pas les identifiants nus. */
  excelJsUrl?: string
}

interface AlpineComponent {
  $el: HTMLElement
  $wire?: WireProxy
  grid: IsoGrid | null
  config: IsoGridAlpineConfig
  surRechargement?: (ev: Event) => void
  pleinEcran: boolean
  dernierEtat: Partial<GridState>
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
    surRechargement: undefined as ((ev: Event) => void) | undefined,
    pleinEcran: false,
    dernierEtat: {} as Partial<GridState>,

    mount(this: AlpineComponent) {
      const cfg = this.config

      // L'URL prime sur le dépôt d'état : un lien partagé doit montrer ce
      // qu'il promet.
      const { fs: fsUrl, ...etatUrl } = (cfg.urlParam ? readUrlState(cfg.urlParam) : undefined) ?? {}

      // `Object.keys` et non un simple `??` : une URL qui ne porte QUE le
      // plein écran laisserait sinon un état vide écraser les filtres retenus
      // dans le dépôt — la grille s'ouvrirait en grand et remise à zéro, ce
      // que le lien ne promettait pas.
      const etatDuLien = Object.keys(etatUrl).length > 0 ? etatUrl as Partial<GridState> : undefined

      this.pleinEcran = fsUrl === 1
      this.dernierEtat = etatDuLien ?? {}

      // `onStateChange` n'est pas enveloppé ici : il peut encore être un NOM
      // de fonction à ce stade. La persistance s'y greffe plus bas, une fois
      // les rappels résolus. `stateStore` est repris plus bas pour la même
      // raison : depuis Blade il peut porter des NOMS de fonction.
      const options: IsoGridOptions<AnyRow> = {
        ...cfg,
        stateStore: undefined,
        initialState: etatDuLien ?? cfg.initialState,
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

      // Mêmes contraintes pour les rappels d'événement : PHP ne sérialise pas
      // de fonction, donc `onSelectionChanged`, `onStateChange` et `onError`
      // acceptent eux aussi un nom de fonction globale. C'est ce qui permet à
      // une page Blade de renvoyer la sélection courante vers son composant
      // Livewire — donc d'y brancher des actions de masse — sans écrire de
      // JavaScript applicatif.
      const rappels = ['onSelectionChanged', 'onStateChange', 'onError', 'onRowClick', 'onRowDoubleClick'] as const
      for (const cle of rappels) {
        const brut = (cfg as unknown as Record<string, unknown>)[cle]
        if (typeof brut !== 'string') continue
        const fn = resoudre(brut, `le rappel « ${cle} »`)
        ;(options as unknown as Record<string, unknown>)[cle] =
          (...args: unknown[]) => fn(...args, this.$wire)
      }

      // La persistance dans l'URL enveloppe `onStateChange` : elle doit venir
      // APRÈS la résolution ci-dessus, sinon elle appellerait la chaîne au
      // lieu de la fonction.
      const suiteEtat = options.onStateChange
      options.onStateChange = (state) => {
        this.dernierEtat = state
        if (cfg.urlParam) writeUrlState(cfg.urlParam, state, this.pleinEcran)
        suiteEtat?.(state)
      }

      // Où ranger les préférences d'affichage. Trois écritures possibles, de
      // la plus explicite à la plus ancienne ; `persistKey` seul garde son
      // comportement historique, le localStorage du navigateur.
      const brutStore = cfg.stateStore as Record<string, unknown> | undefined
      if (brutStore) {
        const store: GridStateStore = { ...(brutStore as GridStateStore) }
        if (typeof brutStore.load === 'string') {
          const fn = resoudre(brutStore.load, 'la lecture de l\'état')
          store.load = () => fn(this.$wire) as never
        }
        if (typeof brutStore.save === 'string') {
          const fn = resoudre(brutStore.save, 'l\'enregistrement de l\'état')
          store.save = (state) => fn(state, this.$wire) as never
        }
        options.stateStore = store
      } else if (cfg.stateUrl) {
        options.stateStore = createHttpStateStore({ url: cfg.stateUrl, key: cfg.persistKey })
      } else if (cfg.persistKey) {
        options.stateStore = createLocalStateStore(cfg.persistKey)
      }

      // Un lien qui porte une vue l'emporte sur le dépôt pour ce qu'il
      // transporte (filtres, tri, recherche) ; le dépôt garde la main sur la
      // mise en page personnelle (colonnes, largeurs), que l'URL ne porte pas.
      if (etatDuLien && options.stateStore?.load) {
        const lire = options.stateStore.load
        const fusion = (retenu: Partial<GridState> | null | undefined): Partial<GridState> => {
          if (!retenu) return etatDuLien
          const { filters: _f, sort: _s, quickFilter: _q, ...miseEnPage } = retenu
          return { ...miseEnPage, ...etatDuLien }
        }
        options.stateStore = {
          ...options.stateStore,
          load: () => {
            const lu = lire()
            return isPromiseLike<Partial<GridState> | null | undefined>(lu)
              ? Promise.resolve(lu).then(fusion)
              : fusion(lu)
          },
        }
      }

      const suiteFs = options.onFullscreenChange
      options.onFullscreenChange = (actif) => {
        this.pleinEcran = actif
        // L'état courant de la grille et non le dernier reçu : un état relu
        // du dépôt n'est pas renvoyé par `onStateChange`.
        if (cfg.urlParam) writeUrlState(cfg.urlParam, this.grid?.getState() ?? this.dernierEtat, actif)
        suiteFs?.(actif)
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

      // Après construction et non par une option : la bascule agit sur la
      // racine déjà montée, et le `ResizeObserver` du viewport recalcule seul
      // les lignes visibles.
      if (this.pleinEcran) this.grid.toggleFullscreen()

      // Rechargement à la demande. Une grille vit sous `wire:ignore` — sinon
      // le prochain rendu Livewire effacerait le DOM qu'elle a construit —,
      // et par conséquent aucun rafraîchissement du composant porteur ne la
      // traverse : après avoir enregistré une modification dans un panneau
      // latéral, la ligne restait affichée telle qu'avant. La page émet donc
      // `isogrid:reload` et la grille recharge son bloc courant.
      //
      // `detail.key` permet de ne viser qu'une grille quand la page en porte
      // plusieurs ; sans clé, toutes rechargent.
      this.surRechargement = (ev: Event) => {
        const cible = (ev as CustomEvent<{ key?: string }>).detail?.key
        if (cible && cible !== cfg.persistKey) return
        this.grid?.reload()
      }
      window.addEventListener('isogrid:reload', this.surRechargement)
    },

    destroy(this: AlpineComponent) {
      if (this.surRechargement) {
        window.removeEventListener('isogrid:reload', this.surRechargement)
        this.surRechargement = undefined
      }
      this.grid?.destroy()
      this.grid = null
    },
  }
}

/**
 * Ce qui va dans l'URL : filtres, tri, recherche.
 *
 * Pas la visibilité ni la largeur des colonnes — c'est un réglage personnel,
 * qui reste dans le stockage local. Un lien partagé doit transmettre la
 * QUESTION posée aux données, pas la mise en page de celui qui l'envoie.
 */
function etatPartageable(state: Partial<GridState>): Partial<GridState> {
  const partiel: Partial<GridState> = {}
  if (state.filters && Object.keys(state.filters).length > 0) partiel.filters = state.filters
  if (state.sort && state.sort.length > 0) partiel.sort = state.sort
  if (state.quickFilter) partiel.quickFilter = state.quickFilter
  return partiel
}

/**
 * Ce que l'URL transporte : l'état partageable de la grille, plus le plein
 * écran — `fs: 1` — qui n'appartient pas à `GridState` mais mérite de suivre
 * le lien : on partage souvent une vue large justement pour qu'elle s'ouvre
 * large.
 */
type EtatUrl = Partial<GridState> & { fs?: 1 }

function readUrlState(param: string): EtatUrl | undefined {
  try {
    const brut = new URLSearchParams(window.location.search).get(param)
    if (!brut) return undefined
    const lu = JSON.parse(brut) as EtatUrl
    return lu && typeof lu === 'object' ? lu : undefined
  } catch {
    // URL bricolée à la main : on démarre sur l'état par défaut plutôt que de
    // refuser d'afficher la grille.
    return undefined
  }
}

function writeUrlState(param: string, state: Partial<GridState>, pleinEcran = false): void {
  try {
    const partiel: EtatUrl = etatPartageable(state)
    if (pleinEcran) partiel.fs = 1
    const url = new URL(window.location.href)
    if (Object.keys(partiel).length === 0) {
      url.searchParams.delete(param)
    } else {
      url.searchParams.set(param, JSON.stringify(partiel))
    }
    // `replaceState` et non `pushState` : chaque frappe dans la recherche
    // ajouterait sinon une entrée d'historique, et le bouton « retour »
    // deviendrait inutilisable.
    window.history.replaceState(window.history.state, '', url)
  } catch {
    /* silencieux : le reflet dans l'URL est un confort */
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
