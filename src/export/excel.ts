import type { ColumnDef } from '../core/types'
import type { ExportDataset } from './collect'
import { downloadBlob } from './collect'

export interface ExcelOptions {
  filename: string
  sheetName: string
  freezeHeader: boolean
  autoFilter: boolean
  /** Nombre de colonnes épinglées à `start`, figées à gauche dans le classeur. */
  frozenColumns: number
  /** Fournisseur d'ExcelJS injecté par l'hôte. Voir `ExportOptions.excelJs`. */
  excelJs?: () => unknown | Promise<unknown>
}

/**
 * ExcelJS n'est pas empaqueté avec la lib : il pèse plusieurs centaines de
 * kilo-octets pour une fonction qu'on n'utilise qu'au clic. Il est déclaré en
 * `peerDependency` optionnelle et chargé à la demande, ce qui laisse aussi
 * l'hôte choisir sa version.
 */
async function loadExcelJs(provider?: () => unknown | Promise<unknown>): Promise<any> {
  // L'hôte a la priorité : c'est la seule voie quand un identifiant nu n'est
  // pas résolvable (bundle servi en statique, page sans étape de build).
  if (provider) {
    const mod = await provider()
    return (mod as any)?.default ?? mod
  }
  try {
    // Spécificateur littéral : c'est la seule forme que les bundlers savent
    // réécrire. Il est marqué `external` au build de la lib, et résolu par
    // l'hôte au moment du clic. Voir src/types/exceljs.d.ts.
    const mod = await import('exceljs')
    return (mod as any).default ?? mod
  } catch (cause) {
    // La cause est conservée : « module introuvable » et « le module a
    // échoué à l'évaluation » se soignent différemment, et sans elle on
    // diagnostique à l'aveugle.
    throw new Error(
      'IsoGrid: le chargement d\'exceljs a échoué. Installer `npm i exceljs` pour activer l\'export Excel.',
      { cause },
    )
  }
}

/** Format de nombre Excel déduit du type de colonne quand rien n'est précisé. */
function numberFormat(col: ColumnDef): string | undefined {
  if (col.exportFormat) return col.exportFormat
  switch (col.type) {
    case 'number': return '#,##0.##'
    case 'date': return 'dd/mm/yyyy'
    case 'datetime': return 'dd/mm/yyyy hh:mm'
    default: return undefined
  }
}

export async function exportToExcel(dataset: ExportDataset, options: ExcelOptions): Promise<void> {
  const ExcelJS = await loadExcelJs(options.excelJs)
  const workbook = new ExcelJS.Workbook()
  workbook.created = new Date()
  const sheet = workbook.addWorksheet(options.sheetName, {
    views: options.freezeHeader
      ? [{ state: 'frozen', xSplit: options.frozenColumns, ySplit: 1 }]
      : undefined,
  })

  sheet.columns = dataset.columns.map((col, i) => ({
    header: dataset.headers[i],
    key: col.id,
    width: Math.min(60, Math.max(10, Math.round((col.width ?? 160) / 7))),
    style: { numFmt: numberFormat(col) },
  }))

  for (const row of dataset.rows) sheet.addRow(row)

  const headerRow = sheet.getRow(1)
  headerRow.font = { bold: true }
  headerRow.alignment = { vertical: 'middle' }
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF1F5F9' },
  }
  headerRow.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } }

  if (options.autoFilter && dataset.columns.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: dataset.columns.length },
    }
  }

  // Alignement par colonne, appliqué après coup : `sheet.columns` n'accepte
  // pas un alignement différencié en-tête / corps.
  dataset.columns.forEach((col, i) => {
    if (!col.align) return
    sheet.getColumn(i + 1).alignment = { horizontal: col.align }
  })

  const buffer = await workbook.xlsx.writeBuffer()
  downloadBlob(
    new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    options.filename.endsWith('.xlsx') ? options.filename : `${options.filename}.xlsx`,
  )
}
