import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/**
 * Build « vendorable » : produit des fichiers autonomes destinés à être
 * déposés dans `public/vendor/isogrid/` d'une application hôte et servis en
 * statique, sans passer par sa chaîne d'assets.
 *
 * C'est le mode d'intégration obligatoire pour Web/www : son `deploy.sh`
 * lance `npx vite build` sur le serveur mais JAMAIS `npm install`. Ajouter
 * une dépendance npm y ferait donc échouer le build en production.
 *
 * Deux sorties séparées :
 *  - `isogrid.js`  — la grille, TanStack inclus (~170 ko), chargée à l'ouverture
 *  - `exceljs.js`  — ExcelJS seul, chargé UNIQUEMENT au clic sur « Exporter »
 *
 * Les garder distincts évite de faire payer le poids d'ExcelJS à toutes les
 * pages qui affichent une grille sans jamais exporter.
 */

function emitStylesheet(): Plugin {
  return {
    name: 'isogrid-emit-stylesheet',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'isogrid.css',
        source: readFileSync(resolve(__dirname, 'src/styles/isogrid.css'), 'utf-8'),
      })
    },
  }
}

export default defineConfig({
  plugins: [emitStylesheet()],

  /**
   * Indispensable ici, et ici seulement.
   *
   * En mode bibliothèque, Vite laisse volontairement `process.env.NODE_ENV`
   * intact : c'est au bundler du consommateur de le remplacer. Or ce bundle
   * est servi TEL QUEL au navigateur, où `process` n'existe pas — table-core
   * y accède à la construction de la table, et la grille explose au montage
   * sur « process is not defined ».
   */
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env': '{}',
  },
  build: {
    outDir: 'dist-vendor',
    emptyOutDir: true,
    lib: {
      entry: {
        isogrid: resolve(__dirname, 'src/index.ts'),
        exceljs: resolve(__dirname, 'src/vendor/exceljs-entry.ts'),
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      // Sorti du graphe de `isogrid.js` : il a son propre fichier, chargé à la
      // demande via l'option `export.excelJs`.
      external: (id) => id === 'exceljs',
      output: { inlineDynamicImports: false },
    },
    cssCodeSplit: false,
    sourcemap: false,
    target: 'es2022',
    minify: 'esbuild',
  },
})
