import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/**
 * La feuille de style est livrée en fichier séparé plutôt qu'injectée par le
 * JS : l'hôte contrôle l'ordre de cascade et peut la surcharger. Elle n'est
 * importée par aucun module de `src`, donc Vite ne l'émettrait pas seul.
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
  // table-core teste « process.env.NODE_ENV » pour ses avertissements de développement.
  // En mode bibliothèque, Vite ne remplace pas cette expression : sans cette ligne, le
  // bundle plante dans le navigateur (« process is not defined ») chez tout hôte sans build.
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    lib: {
      entry: {
        isogrid: resolve(__dirname, 'src/index.ts'),
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      // ExcelJS est une peerDependency optionnelle, chargée dynamiquement au
      // clic : il ne doit jamais entrer dans le bundle.
      external: ['exceljs'],
      output: {
        assetFileNames: (asset) =>
          asset.names?.[0]?.endsWith('.css') ? 'isogrid.css' : 'assets/[name][extname]',
      },
    },
    cssCodeSplit: false,
    sourcemap: true,
    target: 'es2022',
    minify: 'esbuild',
  },
  server: {
    port: 5178,
    open: '/demo/index.html',
  },
})
