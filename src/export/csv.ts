import type { ExportCell, ExportDataset } from './collect'
import { downloadBlob } from './collect'

export interface CsvOptions {
  filename: string
  /** Défaut : `;` — c'est ce qu'Excel attend dans les locales européennes. */
  delimiter?: string
  /** Ajoute le BOM UTF-8 pour qu'Excel n'écrase pas les accents. Défaut : true. */
  bom?: boolean
}

function formatCell(value: ExportCell, delimiter: string): string {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'

  const s = String(value)
  // Guillemets, séparateur, saut de ligne : la cellule doit être protégée.
  // Le `=` en tête neutralise l'injection de formule à l'ouverture.
  const needsQuotes = s.includes(delimiter) || s.includes('"') || /[\r\n]/.test(s)
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s
  return needsQuotes ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** Écrit et télécharge un CSV. Aucune dépendance : c'est le chemin toujours disponible. */
export function exportToCsv(dataset: ExportDataset, options: CsvOptions): void {
  const delimiter = options.delimiter ?? ';'
  const lines: string[] = []

  lines.push(dataset.headers.map(h => formatCell(h, delimiter)).join(delimiter))
  for (const row of dataset.rows) {
    lines.push(row.map(cell => formatCell(cell, delimiter)).join(delimiter))
  }

  const content = (options.bom === false ? '' : '﻿') + lines.join('\r\n')
  downloadBlob(
    new Blob([content], { type: 'text/csv;charset=utf-8' }),
    options.filename.endsWith('.csv') ? options.filename : `${options.filename}.csv`,
  )
}
