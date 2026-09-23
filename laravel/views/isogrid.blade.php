{{--
    Composant Blade IsoGrid.

    @param array  $columns    définitions de colonnes (tableau PHP -> JSON)
    @param string $source     'livewire' (défaut) ou une URL de point d'entrée
    @param string $height     hauteur CSS du conteneur ; la grille remplit son parent.
                              `fill` (ou `auto`) = s'etire jusqu'au bas de la fenetre et
                              suit les redimensionnements — raccourci vers l'option
                              `autoHeight` de la grille. Tout le reste est pris tel quel
                              comme hauteur CSS.
    @param string $persistKey clé localStorage pour l'état (facultatif)
    @param string $urlParam   paramètre d'URL où refléter filtres/tri/recherche,
                              pour une vue partageable (facultatif)
    @param string $locale     fr|en|de|es|it
    @param array  $options    options supplémentaires fusionnées telles quelles

    Exemple :
        <x-isogrid
            :columns="$this->gridColumns()"
            persist-key="admin.users2"
            height="calc(100vh - 18rem)"
        />
--}}
@props([
    'columns' => [],
    'source' => 'livewire',
    'height' => '70vh',
    'persistKey' => null,
    'urlParam' => null,
    'locale' => null,
    'options' => [],
])

@php
    /**
     * Empreinte du bundle, pour casser le cache du navigateur.
     *
     * Sans elle, un navigateur qui a déjà chargé `isogrid.js` continue de
     * l'exécuter après une mise à jour : le fichier est servi en statique,
     * sans hachage dans son nom. Le symptôme est trompeur — les anciennes
     * fonctions marchent, les nouvelles semblent absentes.
     *
     * `filemtime` plutôt que le numéro de version : il change dès que le
     * fichier change, y compris entre deux builds d'une même version.
     *
     * ⚠️ Le JS **et** la CSS entrent dans le calcul. N'y mettre que le JS
     * laissait un correctif de feuille de style invisible derrière le cache :
     * l'URL de la CSS ne changeait pas, le navigateur gardait l'ancienne, et
     * le bogue paraissait non corrigé — vécu le 23/09/2026 sur le panneau de
     * filtres écrasé en plein écran.
     */
    $isogridV = max(
        (int) @filemtime(public_path('vendor/isogrid/isogrid.js')),
        (int) @filemtime(public_path('vendor/isogrid/isogrid.css')),
    ) ?: 'dev';
@endphp

@once
    {{-- Bundle autonome (TanStack inclus) servi en statique : il ne passe pas
         par Vite, donc aucune dépendance npm à installer côté hôte.

         `url()` et NON `asset()` : quand l'application définit un ASSET_URL
         pointant sur un CDN (c'est le cas de Web/www en production), `asset()`
         renvoie une URL CDN — or le CDN ne reçoit que `public/build/`, pas
         `public/vendor/`. On obtenait donc trois 404 et une grille muette. --}}
    <link rel="stylesheet" href="{{ url('/vendor/isogrid/isogrid.css') }}?v={{ $isogridV }}">

    {{-- Volontairement inline et AVANT le conteneur, pas dans @push('scripts') :
         un panneau Filament n'expose pas forcément cette pile. Un script
         `type="module"` est différé, donc il s'exécute après l'analyse du HTML
         mais AVANT `DOMContentLoaded` — c'est-à-dire avant qu'Alpine ne démarre
         et ne rencontre le `x-data` ci-dessous. --}}
    <script type="module">
        import { autoRegisterIsoGridAlpine } from '{{ url('/vendor/isogrid/isogrid.js') }}?v={{ $isogridV }}';
        autoRegisterIsoGridAlpine();
    </script>
@endonce

{{-- `wire:ignore` : sans lui, le prochain rendu Livewire remplacerait le DOM
     construit par la grille et la ferait disparaître.

     `height=fill` n'est qu'un raccourci vers l'option `autoHeight` de la
     grille ; `$options` peut la porter directement, et la surcharge puisqu'il
     est fusionné en dernier.

     ⚠️ Aucun commentaire PHP à l'intérieur du `@js([...])` : il vit dans un
     attribut HTML entre guillemets doubles, et le moindre guillemet dans un
     commentaire referme l'attribut — la grille se retrouve alors montée avec
     une configuration tronquée. --}}
<div
    wire:ignore
    x-data="isogrid(@js(array_merge([
        'columns' => $columns,
        'source' => $source,
        'persistKey' => $persistKey,
        'urlParam' => $urlParam,
        'autoHeight' => in_array($height, ['fill', 'auto'], true),
        'locale' => $locale ?? app()->getLocale(),
        'excelJsUrl' => url('/vendor/isogrid/exceljs.js').'?v='.$isogridV,
    ], $options)))"
    {{-- L'etirement vers le bas de la fenetre est desormais tenu par la
         grille elle-meme (option `autoHeight`) : il y a sa place, avec le
         retrait de l'ecouteur au demontage et le respect du plein ecran, ce
         qu'un `x-init` de vue ne savait pas faire. --}}
    x-init="mount()"
    {{-- `min-width: 0` n'est pas decoratif : le conteneur est souvent
         l'enfant d'un flex (une page Filament, une carte), et un enfant flex
         refuse par defaut de descendre sous la largeur de son contenu. La
         grille, large de la somme de ses colonnes, poussait alors la page et
         debordait a droite de l'ecran au lieu de defiler a l'interieur.
         `width: 100%` et `max-width: 100%` ferment le meme piege dans une
         grille CSS ou un bloc a largeur automatique. --}}
    style="height: {{ in_array($height, ['fill', 'auto'], true) ? 'auto' : $height }}; width: 100%; max-width: 100%; min-width: 0;"
    {{ $attributes }}
></div>
{{-- Pas de `x-on:destroy` : Alpine appelle lui-même la méthode `destroy()`
     du composant quand l'élément quitte le DOM. --}}
