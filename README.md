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

**8 langues complètes** : `fr`, `en`, `de`, `es`, `it`, `nl`, `pl`, `ru` —
81 clés chacune. Une clé absente d'une langue est un bug, pas un « à
compléter ». `messages` permet de surcharger n'importe quel libellé.

## Actions de ligne

```ts
new IsoGrid(el, {
  rowActions: {
    items: (row) => [
      { label: 'Voir',     icon: 'eye',  action: () => location.assign(`/users/${row.id}`) },
      { label: 'Modifier', icon: 'grip', action: () => modifier(row) },
      { separator: true },
      { label: 'Supprimer', icon: 'close', disabled: !row.deletable, action: () => supprimer(row) },
    ],
  },
})
```

Une colonne « ⋮ » apparaît, épinglée à droite. Le menu s'ancre sous le bouton,
se ferme au clic extérieur et à Échap, et prend le focus au clavier. Retourner
un tableau vide masque le bouton : une ligne sans action possible n'affiche
pas de bouton mort.

Sans cela, une grille n'est qu'une consultation — c'est ce qui manque pour
remplacer une table d'administration, où chaque ligne s'ouvre, se modifie ou
déclenche un traitement.

## Lignes de détail (master-detail)

```ts
new IsoGrid(el, {
  masterDetail: {
    height: 'auto',                          // défaut : mesure le contenu réel
    isRowMaster: (row) => row.hasLines,      // défaut : toutes les lignes
    renderer: ({ row, invalidateHeight }) => {
      const box = document.createElement('div')
      box.textContent = 'Chargement…'
      fetch(`/factures/${row.id}/lignes`)
        .then(r => r.json())
        .then(data => { box.innerHTML = rendu(data); invalidateHeight() })
      return box
    },
  },
})
```

Une colonne de chevron apparaît en tête. Le panneau se place **sous** sa ligne
maître, occupe toute la largeur et ne défile pas horizontalement — c'est une
fiche, pas une continuation du tableau.

**Fonctionne en mode client comme en mode serveur** : contrairement au
groupage, le détail n'a besoin que de la ligne concernée.

### Hauteur automatique

C'est le point délicat. Le contenu vient souvent du réseau : sa hauteur est
inconnue au montage et change quand la réponse arrive. Trois mécanismes se
complètent :

1. **Mesure synchrone** juste après l'insertion — un contenu déjà complet est
   au bon format dès le premier rendu, sans passer par une hauteur provisoire.
2. **`ResizeObserver`** sur le panneau — suit les changements ultérieurs sans
   rien demander à l'hôte.
3. **`invalidateHeight()`**, fourni au renderer — la voie explicite, qui ne
   dépend d'aucune API. À appeler dès que le contenu a fini de changer.

Passer `height: 240` fige la hauteur et court-circuite tout ça.

> **Sous le capot.** La virtualisation suppose des lignes de hauteur égale
> (`offset = index × hauteur`). Un panneau la rompt. `DetailLayout` ne stocke
> que les exceptions — les quelques lignes dépliées — et recalcule les
> décalages à partir d'elles. Un panneau **s'ajoute** sous sa ligne, il ne la
> remplace pas : le traiter comme une hauteur substituée ferait chevaucher la
> ligne suivante.

```ts
grid.toggleDetail(rowId) / isDetailOpen(rowId) / closeAllDetails()
```

L'état (`openDetails`) fait partie de `GridState`.

## Groupage de lignes

```ts
new IsoGrid(el, {
  rowModel: 'client',              // OBLIGATOIRE : voir la limite ci-dessous
  rowGroup: ['city', 'status'],    // niveaux initiaux, dans l'ordre
  groupDefaultExpanded: 0,         // 0 = tout replié, -1 = tout déplié
  groupPanel: true,                // zone de dépôt ; 'whenGrouping' pour la masquer à vide
  columns: [
    { id: 'city',     header: 'Ville' },
    { id: 'amountHt', header: 'Montant HT', type: 'number', aggFunc: 'sum' },
  ],
})
```

Les colonnes servant au groupage sont masquées automatiquement — leur valeur
est déjà portée par la ligne de groupe. Une colonne d'arborescence apparaît,
épinglée à gauche, avec chevron, libellé et effectif.

**Zone de dépôt.** On y fait glisser un en-tête de colonne pour grouper. Les
niveaux s'affichent en jetons réordonnables par glisser, chacun avec une croix
pour le retirer. Le menu de chaque colonne propose aussi « Grouper par cette
colonne ». Sans cette zone, le groupage n'est pas découvrable.

**Agrégats.** `aggFunc` accepte `'sum'`, `'avg'`, `'min'`, `'max'`, `'count'`,
`'first'`, `'last'`, ou une fonction `(values: unknown[]) => unknown`. Les
valeurs non numériques sont ignorées plutôt que comptées comme zéro : une
cellule vide ne doit pas tirer une moyenne vers le bas.

```ts
grid.getRowGroup() / setRowGroup([...]) / addRowGroup(id) / removeRowGroup(id)
grid.expandAllGroups() / collapseAllGroups()
```

L'état (`rowGroup`, `expandedGroups`) fait partie de `GridState` : il se
persiste et se restaure comme le reste.

> ⚠️ **Mode client uniquement.** Le groupage exige l'ensemble des lignes en
> mémoire : construire un arbre à partir des seuls blocs chargés produirait
> des groupes faux. En mode serveur, l'option est ignorée et un avertissement
> est émis. Le groupage serveur suppose un protocole distinct — le serveur
> renvoie les groupes d'un niveau (`GROUP BY`), puis les enfants d'un groupe
> déplié, avec un cache par branche.

## Sélection de lignes

```ts
new IsoGrid(el, {
  rowSelection: 'multiple',          // ou 'single', ou false (défaut)
  getRowId: (row) => String(row.id), // OBLIGATOIRE en mode serveur
  onSelectionChanged: (sel) => console.log(sel.count),
})
```

Une colonne de cases apparaît en tête, épinglée et verrouillée. La case
d'en-tête est à trois états (aucune / partielle / toutes), le Maj-clic étend
la sélection depuis la dernière ligne cochée, et la barre d'état affiche le
compte avec un bouton pour tout désélectionner.

### Le point difficile : « tout sélectionner » sur 50 000 lignes

Quand la grille n'a chargé que 100 lignes sur 50 000, cocher « tout
sélectionner » ne peut pas énumérer des identifiants jamais vus. La sélection
a donc **deux modes symétriques** :

```ts
{ mode: 'include', ids: ['12', '47'] }   // seules ces lignes
{ mode: 'exclude', ids: ['12'] }         // TOUT le jeu filtré, sauf celle-ci
```

`selectAll()` bascule en `exclude` avec une liste vide : 50 000 lignes
sélectionnées, **zéro identifiant transmis, aucune ligne chargée**. Décocher
ensuite trois lignes ajoute trois identifiants à la liste d'exclusion.

`getSelection()` renvoie cet état tel quel — c'est exactement ce qu'une action
de masse doit poster au serveur, à charge pour lui de retraduire `exclude` en
« la requête filtrée courante, moins ces identifiants ».

```ts
grid.getSelectedRows()   // lignes sélectionnées ET chargées
grid.getSelection()      // état complet, sérialisable, + count / isAll / isEmpty
grid.setSelection(state) / setRowSelected(id, bool) / isRowSelected(id)
grid.selectAll() / deselectAll()
```

### Ce qui efface la sélection, et ce qui ne l'efface pas

Un **tri** la conserve : l'ensemble des lignes ne change pas, seulement leur
ordre. Un **changement de filtre** l'efface : en mode `exclude`, « tout sauf
ces trois-là » désignerait sinon silencieusement d'autres lignes.

> ⚠️ En mode serveur, fournir un `getRowId` **stable** (une clé métier). À
> défaut, la sélection retombe sur l'index de ligne, qui change à chaque tri —
> la grille émet un avertissement en console dans ce cas.

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

### Déclarer des fonctions depuis Blade

PHP ne sérialise pas de fonction. Tout point d'extension accepte donc un **nom
de fonction globale**, résolu sur `window` et appelé avec `$wire` en dernier
argument — ce qui lui permet d'appeler une méthode du composant Livewire
porteur sans route dédiée :

```php
'columns' => [
    ['id' => 'os', 'header' => 'OS', 'cellRenderer' => 'monRenduOs'],
],
'rowActions' => ['items' => 'mesActions', 'urls' => $this->urls()],
'masterDetail' => ['renderer' => 'monDetail'],
```

```js
window.monRenduOs = (ctx, wire) => { /* … */ }
```

Concerné : `cellRenderer`, `valueFormatter` et `cellClass` sur une colonne,
`rowActions.items`, `masterDetail.renderer`. Un nom introuvable lève une
erreur explicite au montage plutôt que d'échouer silencieusement.

#### Rappels d'événement désignables par nom

Comme les rendus de colonne, les rappels acceptent un **nom de fonction
globale** — `onSelectionChanged`, `onStateChange`, `onError`. Chacun reçoit
ses arguments habituels, suivis de `$wire`. C'est ce qui permet à une page
Blade de renvoyer la sélection courante vers son composant Livewire, donc d'y
brancher des actions de masse, sans écrire de JavaScript applicatif :

```blade
<x-isogrid :columns="[...]" source="livewire"
           :config="['onSelectionChanged' => 'maSelection']" />
```

```js
window.maSelection = (selection, grid, wire) => {
    const etat = grid.getState()
    wire.call('selectionChangee', {
        mode: selection.mode, ids: selection.ids,
        filters: etat.filters, quickFilter: etat.quickFilter,
    })
}
```

Envoyer aussi les filtres n'est pas superflu : en mode `exclude`, la sélection
dit « tout sauf ces trois-là », et « tout » n'a de sens que rapporté au jeu
filtré du moment.

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

#### Déclencher une modale Filament depuis la grille

Une action de ligne peut monter une action Filament de la page hôte, ce qui
réutilise **la même modale, le même formulaire et le même traitement** que la
table d'origine — rien n'est réimplémenté en JavaScript :

```js
window.mesActions = (row, wire) => [
    { label: 'Modifier le plan', action: () => wire.mountAction('changerPlan', { record: row.id }) },
]
```

Côté page, l'action lit sa cible dans `$arguments` plutôt que dans `$record` :

```php
public function changerPlanAction(): Action
{
    return Action::make('changerPlan')
        ->form([...])
        ->action(fn (array $arguments, array $data) => /* ... */);
}
```

**Deux pièges, tous deux silencieux.**

1. `<x-filament-actions::modals />` produit bien le balisage de la modale,
   mais ne suffit pas à l'ouvrir : Filament n'enregistre le déclencheur que si
   **l'objet d'action est lui-même rendu**. Sans cela, `mountAction()`
   fonctionne côté serveur, le HTML de la modale est dans le DOM… et rien ne
   s'affiche. Il faut donc rendre les actions, même sans se servir de leurs
   boutons :

   ```blade
   <div class="hidden" aria-hidden="true">
       {{ $this->changerPlanAction }}
   </div>

   <x-filament-actions::modals />
   ```

   Le symptôme est trompeur : une action à `->modalContent()` s'ouvre malgré
   tout, seules celles à `->form()` restent invisibles.

2. Les icônes de police éventuellement utilisées dans vos rendus de cellule
   doivent être chargées **sur cette page**. Un panneau Filament n'embarque
   pas Font Awesome par défaut, et beaucoup d'applications l'enregistrent page
   par page : une cellule qui ne contient qu'un `<i class="fa-…">` sort alors
   parfaitement vide.

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

Le composant Blade ajoute une empreinte (`?v=…`, le `filemtime` du bundle) aux
trois URLs. **Sans elle, un navigateur qui a déjà chargé `isogrid.js` continue
de l'exécuter après une mise à jour** : le fichier est servi en statique, sans
hachage dans son nom. Le symptôme est trompeur — les anciennes fonctions
marchent, les nouvelles semblent absentes.

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
