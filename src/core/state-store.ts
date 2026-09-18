import type { GridState } from './types'
import { csrfToken } from '../datasource/server'

/* ------------------------------------------------------------------------ */
/* Contrat de persistance                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Où l'hôte range les préférences d'affichage de la grille.
 *
 * Écrire dans le `localStorage` du navigateur dépanne, mais l'utilisateur qui
 * change de poste repart de zéro et une organisation ne peut rien fixer par
 * profil. Ce point d'extension laisse donc l'hôte décider : son serveur, son
 * compte utilisateur, sa base — la grille ne sait rien du transport.
 *
 * Les deux fonctions peuvent être **asynchrones** : c'est le cas normal quand
 * l'état vit sur un serveur. La grille s'y adapte (voir `load`), et un échec
 * réseau ne l'empêche jamais de fonctionner : une préférence d'affichage qui
 * ne s'enregistre pas ne doit pas bloquer le travail.
 */
export interface GridStateStore {
  /**
   * Relit l'état enregistré. Retourner `null` quand il n'y en a pas.
   *
   * Une valeur rendue **tout de suite** (mémoire, `localStorage`) est appliquée
   * AVANT le premier rendu : la grille se monte déjà triée, filtrée, avec ses
   * colonnes. Une **promesse** décale le premier chargement de données jusqu'à
   * son arrivée — la grille affiche « Chargement… » puis se dessine une seule
   * fois, plutôt que de s'afficher deux fois de suite.
   */
  load?: () => Partial<GridState> | null | undefined | Promise<Partial<GridState> | null | undefined>

  /**
   * Enregistre l'état. Appelée après regroupement des changements rapprochés
   * (voir `debounce`), et jamais pendant la restauration : la grille ne renvoie
   * pas à l'hôte ce qu'il vient de lui donner.
   *
   * Un rejet est signalé puis oublié : la grille continue avec l'état affiché.
   */
  save?: (state: GridState) => void | Promise<void>

  /**
   * Délai de regroupement des enregistrements, en ms. Défaut : 800.
   *
   * Redimensionner une colonne ou taper dans un filtre produit des dizaines de
   * changements par seconde ; sans ce délai, autant d'appels au serveur.
   */
  debounce?: number

  /**
   * Temps d'attente maximal de `load`, en ms. Défaut : 5000.
   *
   * Passé ce délai la grille démarre sans les préférences, et les applique si
   * elles finissent par arriver. Sans ce garde-fou, un serveur qui ne répond
   * pas laisserait une grille vide pour toujours.
   */
  loadTimeout?: number

  /** Échec de lecture ou d'écriture. Sans lui, un avertissement en console. */
  onError?: (error: unknown, phase: 'load' | 'save') => void
}

/** Vrai pour tout objet « thenable », promesse native ou non. */
export function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | null)?.then === 'function'
}

/* ------------------------------------------------------------------------ */
/* Deux dépôts prêts à l'emploi                                              */
/* ------------------------------------------------------------------------ */

/**
 * Ce que les dépôts fournis retiennent : tout l'état SAUF la recherche.
 *
 * Un terme de recherche est transitoire — il répond à une question posée à
 * l'instant, pas à une préférence d'affichage. Retenu, il rouvre la page des
 * jours plus tard en cachant l'essentiel des lignes, et rien à l'écran ne dit
 * pourquoi : on croit à une perte de données.
 *
 * Elle est écartée à la LECTURE aussi : un état enregistré avant cette règle
 * en contient une, qui ressusciterait sinon à chaque chargement. La recherche
 * reste partageable par l'URL (`urlParam` de l'adaptateur Alpine), où elle est
 * explicite.
 */
function sansRecherche<T extends Partial<GridState>>(state: T): Omit<T, 'quickFilter'> {
  const { quickFilter: _recherche, ...reste } = state
  return reste
}

/**
 * Dépôt `localStorage` — le comportement historique de `persistKey`.
 *
 * Synchrone, donc appliqué avant le premier rendu. Par navigateur et par
 * poste : à réserver au confort, pas aux préférences qu'on veut retrouver
 * ailleurs.
 */
export function createLocalStateStore(key: string): GridStateStore {
  return {
    load() {
      try {
        const raw = localStorage.getItem(key)
        return raw ? sansRecherche(JSON.parse(raw) as Partial<GridState>) : null
      } catch {
        // Stockage indisponible (navigation privée, quota) : on démarre sur
        // l'état par défaut plutôt que d'empêcher la grille de s'afficher.
        return null
      }
    },
    save(state) {
      try {
        localStorage.setItem(key, JSON.stringify(sansRecherche(state)))
      } catch {
        /* silencieux : la persistance est un confort, pas une fonction critique */
      }
    },
    // Le stockage local est instantané : inutile d'attendre pour écrire.
    debounce: 200,
  }
}

export interface HttpStateStoreOptions {
  /** Point d'entrée. Lu en GET, écrit en POST. */
  url: string
  /**
   * Distingue plusieurs grilles servies par le même point d'entrée. Envoyé en
   * `?key=` à la lecture et dans le corps à l'écriture.
   */
  key?: string
  headers?: Record<string, string> | (() => Record<string, string>)
  credentials?: RequestCredentials
  debounce?: number
  loadTimeout?: number
  onError?: (error: unknown, phase: 'load' | 'save') => void
}

/**
 * Dépôt HTTP : l'état suit l'utilisateur d'un poste à l'autre.
 *
 * Le serveur reçoit un GET et répond soit l'état, soit `{ state: … }`, soit
 * une enveloppe vide quand l'utilisateur n'a rien enregistré ; il reçoit un
 * POST `{ key, state }` pour écrire. C'est à lui de décider à qui appartient
 * cet état — utilisateur, profil, poste de travail : la grille n'en sait rien.
 *
 * Aucune erreur ne remonte à l'utilisateur : une préférence non enregistrée
 * n'empêche pas de travailler.
 */
export function createHttpStateStore(options: HttpStateStoreOptions | string): GridStateStore {
  const opts: HttpStateStoreOptions = typeof options === 'string' ? { url: options } : options

  const buildHeaders = (write: boolean): Record<string, string> => {
    const base: Record<string, string> = {
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    }
    if (write) {
      base['Content-Type'] = 'application/json'
      const token = csrfToken()
      if (token) base['X-CSRF-TOKEN'] = token
    }
    const extra = typeof opts.headers === 'function' ? opts.headers() : opts.headers
    return { ...base, ...extra }
  }

  return {
    async load() {
      const sep = opts.url.includes('?') ? '&' : '?'
      const target = opts.key ? `${opts.url}${sep}key=${encodeURIComponent(opts.key)}` : opts.url
      const res = await fetch(target, {
        headers: buildHeaders(false),
        credentials: opts.credentials ?? 'same-origin',
      })
      // 404 = « pas de préférences pour cet utilisateur », pas une panne.
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`IsoGrid: l'état a répondu ${res.status} ${res.statusText}`)
      const body = await res.json() as Record<string, unknown> | null
      if (!body) return null
      // Tolère les deux formes : l'état nu, ou enveloppé.
      const state = (body.state ?? body.data ?? body) as Partial<GridState>
      if (!state || typeof state !== 'object') return null
      const retenu = sansRecherche(state)
      return Object.keys(retenu).length > 0 ? retenu : null
    },

    async save(state) {
      const res = await fetch(opts.url, {
        method: 'POST',
        headers: buildHeaders(true),
        credentials: opts.credentials ?? 'same-origin',
        body: JSON.stringify({ key: opts.key, state: sansRecherche(state) }),
      })
      if (!res.ok) throw new Error(`IsoGrid: l'état a répondu ${res.status} ${res.statusText}`)
    },

    debounce: opts.debounce,
    loadTimeout: opts.loadTimeout,
    onError: opts.onError,
  }
}
