{{--
    Composant Blade IsoGrid.

    @param array  $columns    définitions de colonnes (tableau PHP -> JSON)
    @param string $source     'livewire' (défaut) ou une URL de point d'entrée
    @param string $height     hauteur CSS du conteneur ; la grille remplit son parent
    @param string $persistKey clé localStorage pour l'état (facultatif)
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
    'locale' => null,
    'options' => [],
])

@once
    {{-- Bundle autonome (TanStack inclus) servi en statique : il ne passe pas
         par Vite, donc aucune dépendance npm à installer côté hôte.

         `url()` et NON `asset()` : quand l'application définit un ASSET_URL
         pointant sur un CDN (c'est le cas de Web/www en production), `asset()`
         renvoie une URL CDN — or le CDN ne reçoit que `public/build/`, pas
         `public/vendor/`. On obtenait donc trois 404 et une grille muette. --}}
    <link rel="stylesheet" href="{{ url('/vendor/isogrid/isogrid.css') }}">

    {{-- Volontairement inline et AVANT le conteneur, pas dans @push('scripts') :
         un panneau Filament n'expose pas forcément cette pile. Un script
         `type="module"` est différé, donc il s'exécute après l'analyse du HTML
         mais AVANT `DOMContentLoaded` — c'est-à-dire avant qu'Alpine ne démarre
         et ne rencontre le `x-data` ci-dessous. --}}
    <script type="module">
        import { autoRegisterIsoGridAlpine } from '{{ url('/vendor/isogrid/isogrid.js') }}';
        autoRegisterIsoGridAlpine();
    </script>
@endonce

{{-- `wire:ignore` : sans lui, le prochain rendu Livewire remplacerait le DOM
     construit par la grille et la ferait disparaître. --}}
<div
    wire:ignore
    x-data="isogrid(@js(array_merge([
        'columns' => $columns,
        'source' => $source,
        'persistKey' => $persistKey,
        'locale' => $locale ?? app()->getLocale(),
        'excelJsUrl' => url('/vendor/isogrid/exceljs.js'),
    ], $options)))"
    x-init="mount()"
    style="height: {{ $height }}"
    {{ $attributes }}
></div>
{{-- Pas de `x-on:destroy` : Alpine appelle lui-même la méthode `destroy()`
     du composant quand l'élément quitte le DOM. --}}
