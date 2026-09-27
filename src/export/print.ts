import type { ColumnDef } from '../core/types'
import type { ExportDataset } from './collect'

export interface PrintDocumentOptions {
  /** Titre en tête de page, et nom proposé si l'on imprime en PDF. */
  title: string
  /** Ligne sous le titre : date d'impression, nombre de lignes. */
  subtitle: string
  /** Avertissement affiché sous le titre quand `maxRows` a coupé la liste. */
  truncatedNote?: string
  orientation: 'portrait' | 'landscape'
  locale: string
}

/**
 * Impression d'une grille.
 *
 * On n'imprime PAS la grille à l'écran : elle est virtualisée (seules les
 * lignes visibles existent dans le DOM), ses colonnes épinglées sont en
 * `position: sticky` et son corps défile dans un conteneur à hauteur fixe —
 * `window.print()` en sortirait une page tronquée à la hauteur du viewport.
 *
 * On imprime donc un document à part, un vrai `<table>` construit à partir
 * du même jeu de données que l'export (colonnes visibles, tri, filtres), avec
 * les valeurs telles qu'affichées. Le navigateur fait le reste : saut de page,
 * en-tête de tableau répété en haut de chaque page (`thead`), et « Enregistrer
 * en PDF » gratuit dans la boîte d'impression.
 */
export function buildPrintHtml(dataset: ExportDataset, options: PrintDocumentOptions): string {
  const align = (col: ColumnDef) => {
    const a = col.align ?? (col.type === 'number' ? 'right' : undefined)
    return a === 'right' ? ' class="r"' : a === 'center' ? ' class="c"' : ''
  }
  const cols = dataset.columns
  const head = cols.map((col, i) => `<th${align(col)}>${escapeHtml(dataset.headers[i])}</th>`).join('')
  const body = dataset.rows.map(row =>
    `<tr>${row.map((cell, i) => `<td${align(cols[i])}>${escapeHtml(cell == null ? '' : String(cell))}</td>`).join('')}</tr>`,
  ).join('\n')

  // Au-delà d'une douzaine de colonnes, 9 pt ne tient plus sur la largeur
  // d'une page paysage : on resserre plutôt que de laisser couper à droite.
  const fontSize = cols.length > 16 ? 7 : cols.length > 10 ? 8 : 9

  return `<!doctype html>
<html lang="${escapeHtml(options.locale)}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(options.title)}</title>
<style>
  @page { size: A4 ${options.orientation}; margin: 10mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: ${fontSize}pt/1.3 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111; }
  h1 { font-size: 13pt; margin: 0 0 2pt; }
  .sub { color: #555; margin: 0 0 6pt; }
  .warn { color: #a15c00; margin: 0 0 6pt; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  th, td { border: 0.5pt solid #bbb; padding: 2pt 4pt; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
  th { background: #eef1f5; font-weight: 600; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  tbody tr:nth-child(even) td { background: #f7f8fa; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .r { text-align: right; white-space: nowrap; }
  .c { text-align: center; }
</style>
</head>
<body>
<h1>${escapeHtml(options.title)}</h1>
<p class="sub">${escapeHtml(options.subtitle)}</p>
${options.truncatedNote ? `<p class="warn">${escapeHtml(options.truncatedNote)}</p>` : ''}
<table>
<thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table>
</body>
</html>`
}

/**
 * Ouvre la boîte d'impression du navigateur sur `html`.
 *
 * Par un iframe caché et non par `window.open()` : pas de bloqueur de
 * fenêtres surgissantes, pas d'onglet orphelin à fermer, et la page hôte
 * reste où elle est. L'iframe est retiré après l'impression (`afterprint`) ;
 * un iframe resté d'une impression précédente est retiré au suivant.
 */
export function printHtml(html: string): Promise<void> {
  document.querySelectorAll('iframe[data-isogrid-print]').forEach(f => f.remove())

  const frame = document.createElement('iframe')
  frame.setAttribute('data-isogrid-print', '')
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  // Hors écran mais dimensionné : Safari n'imprime pas un iframe `display:none`
  // ni un iframe de taille nulle.
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none'

  return new Promise<void>((resolve, reject) => {
    frame.addEventListener('load', () => {
      const win = frame.contentWindow
      if (!win) { frame.remove(); reject(new Error('IsoGrid: impression impossible (iframe sans fenêtre).')); return }
      win.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 0))
      try {
        win.focus()
        win.print()
        resolve()
      } catch (error) {
        frame.remove()
        reject(error)
      }
    }, { once: true })
    frame.srcdoc = html
    document.body.append(frame)
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
