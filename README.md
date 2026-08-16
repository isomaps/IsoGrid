# IsoGrid

Grille de données maison, framework-agnostique. Elle vise l'ergonomie d'AG Grid
— colonnes épinglées, filtres par colonne, panneau latéral, export Excel,
modèle de lignes serveur — sans la licence Enterprise et avec notre design.

> **Pourquoi elle existe.** Dans AG Grid, l'export Excel, la sidebar *et* le
> modèle de lignes serveur sont **tous les trois** réservés à l'édition
> Enterprise (~800 $/développeur/an). Ce sont précisément les trois besoins de
> départ.

## Architecture en une phrase

`@tanstack/table-core` (MIT) tient le **modèle de colonnes** — visibilité,
ordre, épinglage `start`/`end`, largeurs, redimensionnement, groupes
d'en-tête, décalages O(1) pour le `position: sticky`, bascule du tri multiple.
Tout le reste — rendu DOM virtualisé, filtres, panneau latéral, export,
chargement par blocs — est à nous.

## Installation

```bash
npm i @isomaps/isogrid
npm i exceljs          # optionnel : uniquement pour l'export .xlsx
```

Font Awesome est attendu dans la page (convention maison). Sans lui, fournir
`renderIcon` pour injecter ses propres SVG.

## Démarrage

```ts
import { IsoGrid } from '@isomaps/isogrid'
import '@isomaps/isogrid/style.css'

const grid = new IsoGrid(document.querySelector('#grid')!, {
  rowModel: 'server',
  datasource: '/admin/factures/grid',
  locale: 'fr',
  columns: [
    { id: 'number', header: 'N° facture', pinned: 'start', lockVisible: true },
    { id: 'client', header: 'Client', filter: 'set' },
    { id: 'date',   header: 'Date',   type: 'date' },
    { id: 'total',  header: 'Total',  type: 'number', align: 'right', pinned: 'end' },
  ],
  onStateChange: (state) => localStorage.setItem('ma-grille', JSON.stringify(state)),
})
```

Le conteneur doit avoir une **hauteur** (la grille remplit 100 % de son
parent). C'est l'erreur d'intégration numéro un.

## Modèles de lignes

| | `client` | `server` |
|---|---|---|
| Données | `rows: [...]` en mémoire | `datasource` (URL ou objet) |
| Tri / filtres | instantanés, dans le navigateur | délégués au serveur |
| Volume | jusqu'à ~50 000 lignes confortablement | illimité (chargement par blocs) |
| `setRows()` | oui | non — utiliser `refresh()` |

Les deux passent par la **même** interface `Datasource` : basculer de l'un à
l'autre ne change rien au reste du code.

## Contrat serveur

`POST` vers l'URL fournie (ou `GET ?q=<json>`) :

```jsonc
{
  "startRow": 0,
  "endRow": 100,
  "sort": [{ "id": "total", "desc": true }],
  "filters": {
    "client": { "type": "set",  "conditions": [{ "op": "in", "value": ["Léman SA"] }] },
    "total":  { "type": "number", "conditions": [
      { "op": "gte", "value": 1000 },
      { "op": "lt",  "value": 5000 }
    ], "join": "and" }
  },
  "quickFilter": "genève",
  "columns": ["number", "client", "total"]   // colonnes visibles : le SELECT peut se restreindre
}
```

Réponse attendue :

```jsonc
{ "rows": [ /* … */ ], "rowCount": 12345 }   // rowCount null => défilement infini
```

Les enveloppes Laravel courantes sont tolérées : `data`/`total`/`recordsFiltered`
sont reconnus en plus de `rows`/`rowCount`. Le jeton `<meta name="csrf-token">`
est envoyé automatiquement.

Pour les filtres `set`, un second point d'entrée (`<url>/set-values` par
défaut) reçoit `{ column, filters, quickFilter }` et renvoie
`{ values: [{ value, count }] }`.

### Côté Laravel

`laravel/IsoGridQuery.php` traduit cette requête en contraintes Eloquent :

```php
return IsoGridQuery::make($request)
    ->allow(['number' => 'invoices.number', 'client' => 'clients.name', 'total' => 'invoices.total'])
    ->searchable(['number', 'client'])
    ->respond(Invoice::query()->join('clients', 'clients.id', '=', 'invoices.client_id'));
```

`allow()` est **obligatoire** : un identifiant de colonne ne peut pas être lié
en paramètre SQL, la liste blanche est la seule protection contre l'injection.

## Filtres

Cinq types : `text`, `number`, `date`, `boolean`, `set`. Jusqu'à deux
conditions par colonne, jointes par `ET`/`OU`. Les opérateurs sont fermés
(table de correspondance côté serveur, jamais de concaténation).

Le type est déduit du `type` de colonne ; `filter: false` désactive, un objet
`{ type, operators, defaultOperator, debounce, hideSearch }` affine.

## Export

```ts
await grid.exportExcel({ filename: 'factures', source: 'all', maxRows: 100_000 })
await grid.exportCsv()
```

En mode serveur, `source: 'all'` **rapatrie tout le jeu filtré** page par page
(1 000 lignes par défaut) avant d'écrire le fichier — c'est la contrepartie
d'un export qui tourne dans le navigateur. `source: 'loaded'` n'exporte que ce
qui est déjà en cache. `maxRows` est un garde-fou dur.

Le `.xlsx` produit fige la ligne d'en-tête **et les colonnes épinglées à
`start`**, pose les auto-filtres, et applique les formats de nombre/date par
colonne (`exportFormat`).

ExcelJS est une `peerDependency` **optionnelle**, chargée dynamiquement au
clic : elle ne pèse rien tant qu'on n'exporte pas. Le CSV, lui, n'a aucune
dépendance (et neutralise l'injection de formule).

## API

```ts
grid.getState() / setState(patch) / resetState()
grid.addColumn(def, atIndex?) / removeColumn(id) / setColumns(defs)
grid.setColumnVisible(id, bool) / moveColumn(id, index) / pinColumn(id, 'start'|'end'|false)
grid.autoSizeColumn(id) / sizeColumnsToFit()
grid.setSort([...]) / setFilter(id, model|null) / clearFilters() / setQuickFilter(str)
grid.refresh() / reload() / setRows(rows) / getLoadedRows() / getDisplayedRowCount()
grid.exportExcel(opts) / exportCsv(opts)
grid.setLocale('de') / setTheme('dark') / destroy()
```

`addColumn`/`removeColumn` reconstruisent le modèle **en préservant** l'état
des colonnes conservées (ordre, épinglage, largeurs, filtres) et en purgeant
celui des colonnes disparues.

## Thème

Tout passe par des variables CSS sur `.isg-root` :

```css
.isg-root { --isg-accent: #16a34a; --isg-radius: 4px; --isg-font-size: 12px; }
```

Clair/sombre automatique (`prefers-color-scheme`), forçable via
`theme: 'light' | 'dark' | 'auto'`.

## Langues

`fr`, `en`, `de`, `es`, `it` — les cinq langues IsoMaps, complètes dès la
première version. Une clé absente d'une langue est un bug, pas un « à
compléter ». `messages` permet de surcharger n'importe quel libellé.

## Menu contextuel (clic droit)

Entrées standard, façon AG Grid, actives par défaut sur tout le corps de la
grille :

- **Copier la cellule**
- **Copier la ligne**
- **Copier la ligne avec les en-têtes**
- **Exporter en Excel** / **Exporter en CSV**

Les lignes sont copiées en **TSV** : elles se collent directement dans un
tableur, colonne par colonne. Le clic droit est écouté sur la cellule et non
sur la ligne — c'est le seul niveau où l'on sait quelle colonne est visée.

Le presse-papiers passe par `navigator.clipboard`, avec repli `execCommand`
pour les back-offices encore servis en HTTP simple. Une confirmation brève
s'affiche : sans retour visible, on ne sait pas si la copie a pris.

```ts
contextMenu: {
  copyItems: true,
  exportItems: true,
  // Réordonner, filtrer ou compléter les entrées par défaut
  items: (ctx, defaults) => [
    { label: `Ouvrir ${ctx.row.name}`, icon: 'eye', action: () => open(ctx.row) },
    { separator: true },
    ...defaults,
  ],
}
```

`contextMenu: false` rend la main au menu natif du navigateur.

## Icônes

Le jeu d'icônes est **embarqué en SVG** : aucune police externe à charger, la
grille s'affiche partout. Les pictogrammes filtre et colonnes reprennent la
géométrie des Heroicons solid employés par Filament, pour qu'une grille posée
dans ce back-office ne détonne pas.

```ts
import { fontAwesomeIconRenderer } from '@isomaps/isogrid'
new IsoGrid(el, { renderIcon: fontAwesomeIconRenderer })   // si l'hôte charge FA
```

> Le premier jet rendait des classes Font Awesome par convention maison. En
> production, le panneau Filament ne charge pas FA : les boutons étaient
> **invisibles tout en restant cliquables**. D'où le jeu embarqué par défaut.

## Intégration Laravel

Trois cibles, du socle au plus intégré.

### 1. Vanilla / Blade

```blade
<link rel="stylesheet" href="{{ url('/vendor/isogrid/isogrid.css') }}">
<div id="grid" style="height: 70vh"></div>
<script type="module">
  import { IsoGrid } from '{{ url('/vendor/isogrid/isogrid.js') }}';
  new IsoGrid(document.querySelector('#grid'), { /* … */ });
</script>
```

### 2. Alpine

`autoRegisterIsoGridAlpine()` déclare un composant `isogrid` :

```blade
<div x-data="isogrid({ columns: @js($columns), source: '/mon/endpoint' })"
     x-init="mount()" style="height: 70vh"></div>
```

`persistKey` sauvegarde l'état dans `localStorage`. Alpine appelle lui-même
`destroy()` au démontage.

### 3. Livewire / Filament

Le plus intégré : la grille appelle les méthodes du composant Livewire qui la
porte, donc **aucune route HTTP à déclarer ni à protéger** — session,
utilisateur, policies et panneau sont hérités.

```php
class ListUsers extends Page
{
    use InteractsWithIsoGrid;

    protected function isoGridQuery(): EloquentBuilder { return User::query(); }
    protected function isoGridColumns(): array { return ['name' => 'users.name']; }
    protected function isoGridSearchable(): array { return ['name']; }
}
```

```blade
<x-isogrid :columns="$this->gridColumns()" source="livewire" height="calc(100vh - 15rem)" />
```

### Installation dans une application

```bash
./install.sh /chemin/vers/app-laravel            # installe ou met à jour
./install.sh /chemin/vers/app-laravel --check    # vérifie la synchro, n'écrit rien
```

Le script construit le bundle, copie les six fichiers livrés (trois assets,
deux classes PHP dont il réécrit le namespace en `App\Support\IsoGrid`, et le
composant Blade), puis dépose un fichier `VERSION`. Il ne réécrit que ce qui a
réellement changé.

`--check` sort en code 1 dès qu'un fichier de l'hôte diverge de la
bibliothèque : c'est ce qui rend cette copie tenable dans le temps, et ça
s'accroche à une CI.

> **Pourquoi une copie et pas `composer require` / `npm i`.** Les déploiements
> du workspace IsoMaps ne lancent **ni `composer install` ni `npm install`**, et
> `vendor/` n'est pas versionné. Un paquet exigerait donc une intervention
> manuelle sur chaque serveur à chaque mise à jour. Les fichiers embarqués,
> eux, partent avec le `git pull` du déploiement.

## Embarquer le bundle (`npm run build:vendor`)

Quand l'hôte ne peut pas ajouter de dépendance npm — c'est le cas de Web/www,
dont le `deploy.sh` lance `npx vite build` mais **jamais `npm install`** —
`vite.vendor.config.ts` produit des fichiers autonomes à déposer dans
`public/vendor/isogrid/` et à servir en statique, hors chaîne Vite.

Deux pièges, tous deux rencontrés en production le 16/08/2026 :

1. **`url()` et non `asset()`.** Si l'application définit un `ASSET_URL` vers
   un CDN, `asset()` renvoie une URL CDN — or le CDN ne reçoit que
   `public/build/`, pas `public/vendor/`. Résultat : trois 404 et une grille
   muette, sans erreur explicite.
2. **`process.env.NODE_ENV` doit être défini au build.** En mode bibliothèque,
   Vite le laisse intact pour que le bundler du consommateur le remplace. Un
   bundle servi tel quel au navigateur n'a pas de bundler : table-core y accède
   à la construction de la table et la grille meurt sur « process is not
   defined ». D'où le bloc `define` de `vite.vendor.config.ts`.

## Développement

```bash
npm run dev        # démo sur http://127.0.0.1:5178/demo/index.html
npm run typecheck
npm run build      # dist/isogrid.js + dist/isogrid.css
```

La démo tourne sur 50 000 factures avec un faux serveur à 220 ms de latence :
elle exerce le vrai chemin serveur, y compris l'annulation des requêtes
périmées.

## Poids

| | gzip |
|---|---|
| Code IsoGrid | 24,7 ko |
| TanStack (table-core + store) | 17,4 ko |
| **Total JS** | **42,1 ko** |
| CSS | 4,3 ko |

À comparer aux ~500 ko–1 Mo d'AG Grid Community, avant Enterprise.

## Limites connues

- **Pas de virtualisation horizontale.** Les lignes sont virtualisées, pas les
  colonnes : au-delà de ~60 colonnes visibles simultanément, le rendu se
  charge. Les colonnes masquées ne coûtent rien.
- **Hauteur de ligne fixe.** Pas de lignes à hauteur variable ni de
  saut de ligne automatique dans les cellules.
- **Pas de pivot**, pas de groupement de lignes, pas d'édition en ligne,
  pas de sélection de plage — hors périmètre v1 assumé.
- **Deux conditions par filtre au maximum.** Au-delà, c'est un constructeur
  de requêtes, autre produit.
