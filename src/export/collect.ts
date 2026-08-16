import type { AnyRow, ColumnDef, ExportOptions, ExportProgress } from '../core/types'
import type { BlockCache } from '../datasource/server'
import { getPath } from '../ui/dom'

/** Une cellule prête à écrire, avec son type conservé pour Excel. */
export type ExportCell = string | number | boolean | Date | null

export interface ExportDataset {
  columns: ColumnDef[]
  headers: string[]
  rows: ExportCell[][]
  /** Vrai si le plafond `maxRows` a coupé l'export. */
  truncated: boolean
}

export interface CollectOptions {
  cache: BlockCache
  columns: ColumnDef[]
  headerLabel: (col: ColumnDef) => string
  cellValue: (col: ColumnDef, row: AnyRow, rowIndex: number) => ExportCell
  options: Required<Pick<ExportOptions, 'source' | 'maxRows' | 'pageSize'>>
  onProgress?: (p: ExportProgress) => void
}

/**
 * Rassemble les lignes à exporter.
 *
 * En mode serveur avec `source: 'all'`, cela veut dire rapatrier tout le jeu
 * filtré page par page — c'est la contrepartie assumée d'un export qui tourne
 * dans le navigateur. Le plafond `maxRows` évite qu'un clic distrait tire
 * deux millions de lignes.
 */
export async function collectExportData(opts: CollectOptions): Promise<ExportDataset> {
  const columns = opts.columns.filter(c => !c.excludeFromExport)
  const headers = columns.map(opts.headerLabel)
  const rows: ExportCell[][] = []
  let truncated = false

  const pushRows = (source: AnyRow[], startIndex: number) => {
    source.forEach((row, i) => {
      if (rows.length >= opts.options.maxRows) { truncated = true; return }
      rows.push(columns.map(col => opts.cellValue(col, row, startIndex + i)))
    })
  }

  if (opts.options.source === 'loaded') {
    const loaded = opts.cache.getLoadedRows()
    pushRows(loaded, 0)
    opts.onProgress?.({ loaded: rows.length, total: rows.length, phase: 'building' })
    return { columns, headers, rows, truncated }
  }

  const total = opts.cache.getRowCount()
  opts.onProgress?.({ loaded: 0, total, phase: 'fetching' })

  for await (const page of opts.cache.iterateAll(opts.options.pageSize, opts.options.maxRows)) {
    pushRows(page, rows.length)
    opts.onProgress?.({ loaded: rows.length, total, phase: 'fetching' })
    if (truncated) break
  }

  opts.onProgress?.({ loaded: rows.length, total, phase: 'building' })
  return { columns, headers, rows, truncated }
}

/** Déclenche le téléchargement d'un blob côté navigateur. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  // Libéré au tour suivant : révoquer immédiatement annule le téléchargement
  // sur certains navigateurs.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Valeur brute d'une cellule, typée pour l'export. */
export function rawCellValue(col: ColumnDef, row: AnyRow): ExportCell {
  const value = getPath(row, col.field ?? col.id)
  if (value == null) return null
  if (value instanceof Date) return value
  if (typeof value === 'number' || typeof value === 'boolean') return value

  const asString = String(value)
  if (col.type === 'number') {
    const n = Number(asString.replace(',', '.'))
    return Number.isNaN(n) ? asString : n
  }
  if (col.type === 'date' || col.type === 'datetime') {
    const d = new Date(asString)
    return Number.isNaN(d.getTime()) ? asString : d
  }
  return asString
}
