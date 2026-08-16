import type { DataRequest, DataResponse, Datasource, SetFilterOption } from '../src/core/types'
import { applyFilters, applySort } from '../src/filters/model'
import type { ColumnDef } from '../src/core/types'

export interface Invoice extends Record<string, unknown> {
  id: number
  number: string
  date: string
  dueDate: string
  client: string
  city: string
  status: string
  currency: string
  amountHt: number
  vat: number
  total: number
  paid: boolean
  owner: string
  notes: string
}

const CLIENTS = [
  'Fiduciaire Rhône SA', 'Alpes Conseil Sàrl', 'Léman Gestion SA', 'Jura Audit SA',
  'Valais Expertise Sàrl', 'Genève Compta SA', 'Vaud Partenaires SA', 'Fribourg Fiduciaire',
  'Neuchâtel Conseil SA', 'Tessin Revisione SA', 'Berne Treuhand AG', 'Zurich Audit AG',
]
const CITIES = ['Genève', 'Lausanne', 'Sion', 'Fribourg', 'Neuchâtel', 'Berne', 'Zurich', 'Lugano', 'Delémont', 'Martigny']
const STATUSES = ['brouillon', 'envoyée', 'payée', 'en retard', 'annulée']
const OWNERS = ['S. Glasson', 'M. Dubois', 'A. Perret', 'C. Rossi', 'L. Meier']

/** Générateur déterministe : la démo doit être reproductible d'un rechargement à l'autre. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generateInvoices(count: number): Invoice[] {
  const random = mulberry32(20260816)
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]
  const rows: Invoice[] = []

  for (let i = 0; i < count; i++) {
    const issued = new Date(2024, 0, 1 + Math.floor(random() * 900))
    const due = new Date(issued.getTime() + (15 + Math.floor(random() * 45)) * 86400000)
    const amountHt = Math.round((120 + random() * 24_000) * 100) / 100
    const vatRate = pick([0, 2.6, 3.8, 8.1])
    const vat = Math.round(amountHt * vatRate) / 100
    const status = pick(STATUSES)

    rows.push({
      id: i + 1,
      number: `F-${issued.getFullYear()}-${String(i + 1).padStart(5, '0')}`,
      date: issued.toISOString().slice(0, 10),
      dueDate: due.toISOString().slice(0, 10),
      client: pick(CLIENTS),
      city: pick(CITIES),
      status,
      currency: pick(['CHF', 'CHF', 'CHF', 'EUR']),
      amountHt,
      vat,
      total: Math.round((amountHt + vat) * 100) / 100,
      paid: status === 'payée',
      owner: pick(OWNERS),
      notes: random() > 0.75 ? 'Relance envoyée par courriel' : '',
    })
  }
  return rows
}

/**
 * Faux serveur : filtre, trie et pagine en mémoire, avec une latence
 * artificielle. Il exerce exactement le même chemin que le mode serveur réel,
 * y compris l'annulation des requêtes périmées.
 */
export function createFakeServer(rows: Invoice[], columns: ColumnDef<Invoice>[], latencyMs = 220): Datasource<Invoice> {
  let cacheKey = ''
  let cached: Invoice[] = []

  const resolve = (request: Pick<DataRequest, 'sort' | 'filters' | 'quickFilter'>): Invoice[] => {
    const key = JSON.stringify([request.filters, request.sort, request.quickFilter])
    if (key !== cacheKey) {
      cached = applySort(applyFilters(rows, request.filters, columns, request.quickFilter), request.sort, columns)
      cacheKey = key
    }
    return cached
  }

  const delay = (signal?: AbortSignal) => new Promise<void>((ok, ko) => {
    const timer = setTimeout(ok, latencyMs + Math.random() * 120)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      ko(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    })
  })

  return {
    async getRows(request: DataRequest): Promise<DataResponse<Invoice>> {
      await delay(request.signal)
      const resolved = resolve(request)
      console.debug('[fake-server] rows', request.startRow, '→', request.endRow, `(${resolved.length} au total)`)
      return { rows: resolved.slice(request.startRow, request.endRow), rowCount: resolved.length }
    },

    async getSetValues(columnId, request): Promise<SetFilterOption[]> {
      await delay(request.signal)
      const others = { ...request.filters }
      delete others[columnId]
      const base = applyFilters(rows, others, columns, request.quickFilter)

      const counts = new Map<string, number>()
      for (const row of base) {
        const key = String(row[columnId] ?? '')
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return Array.from(counts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count }))
    },
  }
}
