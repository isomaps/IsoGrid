import { IsoGrid } from '../src/index'
import type { ColumnDef, LocaleCode } from '../src/core/types'
import { createFakeServer, generateInvoices, type Invoice } from './data'
import '../src/styles/isogrid.css'

const columns: ColumnDef<Invoice>[] = [
  { id: 'number', header: 'N° facture', width: 150, pinned: 'start', lockVisible: true, filter: 'text' },
  { id: 'date', header: 'Date', type: 'date', width: 115, group: 'Échéances' },
  { id: 'dueDate', header: 'Échéance', type: 'date', width: 115, group: 'Échéances' },
  { id: 'client', header: 'Client', width: 220, filter: 'set' },
  { id: 'city', header: 'Ville', width: 130, filter: 'set' },
  {
    id: 'status',
    header: 'Statut',
    width: 130,
    filter: 'set',
    cellRenderer: ({ value }) => {
      const span = document.createElement('span')
      span.className = 'demo-chip'
      span.dataset.status = String(value)
      span.textContent = String(value)
      return span
    },
  },
  { id: 'owner', header: 'Gestionnaire', width: 150, filter: 'set' },
  { id: 'amountHt', header: 'Montant HT', type: 'number', width: 130, align: 'right', group: 'Montants', exportFormat: '#,##0.00', aggFunc: 'sum' },
  { id: 'vat', header: 'TVA', type: 'number', width: 110, align: 'right', group: 'Montants', exportFormat: '#,##0.00', aggFunc: 'sum' },
  {
    id: 'total',
    header: 'Total TTC',
    type: 'number',
    width: 140,
    align: 'right',
    pinned: 'end',
    group: 'Montants',
    exportFormat: '#,##0.00',
    valueFormatter: ({ value, row }) =>
      new Intl.NumberFormat('fr-CH', { style: 'currency', currency: String(row.currency) })
        .format(Number(value)),
  },
  { id: 'currency', header: 'Devise', width: 100, filter: 'set', hide: true },
  { id: 'paid', header: 'Payée', type: 'boolean', width: 100, align: 'center' },
  { id: 'notes', header: 'Notes', width: 240, filter: 'text' },
]

const rows = generateInvoices(50_000)
const server = createFakeServer(rows, columns)

const STATE_KEY = 'isogrid-demo-state'
const saved = localStorage.getItem(STATE_KEY)

let grid: IsoGrid<Invoice>

function build(mode: 'server' | 'client') {
  grid?.destroy()
  grid = new IsoGrid<Invoice>(document.querySelector('#grid')!, {
  columns,
  ...(mode === 'server'
    ? { rowModel: 'server' as const, datasource: server }
    : { rowModel: 'client' as const, rows }),
  // Le groupage exige l'ensemble des lignes en mémoire : il n'est proposé
  // qu'en mode client.
  groupPanel: mode === 'client' ? (true as const) : undefined,
  groupDefaultExpanded: 0,
  locale: 'fr',
  theme: 'auto',
  blockSize: 100,
  initialState: saved ? JSON.parse(saved) : undefined,
  onStateChange: (state) => localStorage.setItem(STATE_KEY, JSON.stringify(state)),
  export: { filename: 'factures', sheetName: 'Factures', source: 'all', maxRows: 100_000 },
  rowSelection: 'multiple',
  getRowId: (row) => String(row.id),
  onSelectionChanged: (sel) => {
    const el = document.querySelector('#selection-readout')
    if (el) {
      el.textContent = sel.isEmpty
        ? 'aucune sélection'
        : `mode ${sel.mode} · ${sel.count ?? '?'} ligne(s) · ${sel.ids.length} id(s) transmis`
    }
  },
  sidebar: { panels: ['columns', 'filters'], defaultOpen: false },
  toolbar: { quickFilter: true, quickFilterPlaceholder: 'Rechercher une facture…' },
  onRowClick: (row) => console.debug('[demo] ligne', row.number),
  })
  ;(window as unknown as { grid: unknown }).grid = grid
}

build('server')

/* --- Contrôles de la page de démonstration ------------------------------- */

let extraColumnCount = 0

document.querySelector('#add-column')!.addEventListener('click', () => {
  extraColumnCount++
  grid.addColumn({
    id: `extra${extraColumnCount}`,
    header: `Colonne ${extraColumnCount}`,
    width: 140,
    valueFormatter: ({ row }) => `${row.city} · ${extraColumnCount}`,
  }, 4)
})

document.querySelector('#remove-column')!.addEventListener('click', () => {
  if (extraColumnCount === 0) return
  grid.removeColumn(`extra${extraColumnCount}`)
  extraColumnCount--
})

document.querySelector('#fit')!.addEventListener('click', () => grid.sizeColumnsToFit())

document.querySelector('#reset')!.addEventListener('click', () => {
  localStorage.removeItem(STATE_KEY)
  location.reload()
})

document.querySelector<HTMLSelectElement>('#locale')!.addEventListener('change', (e) => {
  grid.setLocale((e.target as HTMLSelectElement).value as LocaleCode)
})

document.querySelector<HTMLSelectElement>('#theme')!.addEventListener('change', (e) => {
  grid.setTheme((e.target as HTMLSelectElement).value as 'light' | 'dark' | 'auto')
})

document.querySelector<HTMLSelectElement>('#rowmodel')!.addEventListener('change', (e) => {
  build((e.target as HTMLSelectElement).value as 'server' | 'client')
})
