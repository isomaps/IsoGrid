#!/usr/bin/env bash
#
# Installe IsoGrid dans une application Laravel.
#
#   ./install.sh /chemin/vers/app-laravel            # installe ou met à jour
#   ./install.sh /chemin/vers/app-laravel --check    # vérifie la synchro, n'écrit rien
#
# Pourquoi une copie et pas `composer require` / `npm i` : les déploiements du
# workspace IsoMaps ne lancent NI `composer install` NI `npm install`, et
# `vendor/` n'est pas versionné. Un paquet exigerait donc une intervention
# manuelle sur chaque serveur à chaque mise à jour. Les fichiers embarqués,
# eux, partent avec le `git pull` du déploiement.
#
# Le script écrit un fichier VERSION côté hôte : c'est lui qui rend la dérive
# détectable, et donc cette copie tenable dans le temps.

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-}"
MODE="${2:-install}"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'

usage() {
  echo "Usage : $0 <chemin-app-laravel> [--check]" >&2
  exit 2
}

[ -n "$TARGET" ] || usage
[ -d "$TARGET" ] || { echo "${RED}Répertoire introuvable : $TARGET${RESET}" >&2; exit 1; }
[ -f "$TARGET/artisan" ] || { echo "${RED}$TARGET ne ressemble pas à une application Laravel (pas d'artisan).${RESET}" >&2; exit 1; }

CHECK_ONLY=false
[ "$MODE" = "--check" ] && CHECK_ONLY=true

VERSION="$(node -p "require('$SOURCE_DIR/package.json').version")"

# --- 1. Construire le bundle autonome -------------------------------------
if [ "$CHECK_ONLY" = false ]; then
  echo "→ Construction du bundle embarquable…"
  (cd "$SOURCE_DIR" && npm run --silent build:vendor >/dev/null)
fi

for f in isogrid.js isogrid.css exceljs.js; do
  [ -f "$SOURCE_DIR/dist-vendor/$f" ] || {
    echo "${RED}dist-vendor/$f manquant — lancer d'abord : npm run build:vendor${RESET}" >&2
    exit 1
  }
done

# --- 2. Table des fichiers livrés ------------------------------------------
# Format : <source relative>|<destination relative>|<rewrite-namespace ?>
MANIFEST=(
  "dist-vendor/isogrid.js|public/vendor/isogrid/isogrid.js|no"
  "dist-vendor/isogrid.css|public/vendor/isogrid/isogrid.css|no"
  "dist-vendor/exceljs.js|public/vendor/isogrid/exceljs.js|no"
  "laravel/IsoGridQuery.php|app/Support/IsoGrid/IsoGridQuery.php|yes"
  "laravel/InteractsWithIsoGrid.php|app/Support/IsoGrid/InteractsWithIsoGrid.php|yes"
  "laravel/views/isogrid.blade.php|resources/views/components/isogrid.blade.php|no"
)

# Le namespace PSR-4 de l'hôte : App\Support\IsoGrid, pour que l'autoload
# standard de Laravel trouve les classes sans configuration.
rewrite() {
  sed 's/^namespace IsoMaps\\IsoGrid;$/namespace App\\Support\\IsoGrid;/'
}

render() {  # <source> <rewrite?>
  if [ "$2" = "yes" ]; then rewrite < "$1"; else cat "$1"; fi
}

# --- 3. Vérification ou installation ---------------------------------------
drift=0
changed=0

for entry in "${MANIFEST[@]}"; do
  IFS='|' read -r src dst rw <<< "$entry"
  src_path="$SOURCE_DIR/$src"
  dst_path="$TARGET/$dst"

  if [ "$CHECK_ONLY" = true ]; then
    if [ ! -f "$dst_path" ]; then
      echo "${RED}✗${RESET} $dst ${DIM}absent${RESET}"
      drift=1
    elif ! render "$src_path" "$rw" | diff -q - "$dst_path" >/dev/null 2>&1; then
      echo "${YELLOW}≠${RESET} $dst ${DIM}diverge de la bibliothèque${RESET}"
      drift=1
    else
      echo "${GREEN}✓${RESET} $dst"
    fi
    continue
  fi

  mkdir -p "$(dirname "$dst_path")"
  if [ -f "$dst_path" ] && render "$src_path" "$rw" | diff -q - "$dst_path" >/dev/null 2>&1; then
    echo "${DIM}= $dst (inchangé)${RESET}"
  else
    render "$src_path" "$rw" > "$dst_path"
    echo "${GREEN}→${RESET} $dst"
    changed=$((changed + 1))
  fi
done

STAMP_FILE="$TARGET/public/vendor/isogrid/VERSION"

if [ "$CHECK_ONLY" = true ]; then
  if [ -f "$STAMP_FILE" ]; then
    echo "${DIM}Version installée : $(head -1 "$STAMP_FILE")${RESET}"
  else
    echo "${YELLOW}Aucun fichier VERSION — installation antérieure au script.${RESET}"
  fi
  if [ "$drift" -ne 0 ]; then
    echo
    echo "${YELLOW}Des fichiers divergent. Relancer sans --check pour resynchroniser.${RESET}"
    exit 1
  fi
  echo
  echo "${GREEN}Hôte synchronisé avec IsoGrid $VERSION.${RESET}"
  exit 0
fi

printf '%s\n' "$VERSION" > "$STAMP_FILE"

echo
echo "${GREEN}IsoGrid $VERSION installé dans $TARGET${RESET} ${DIM}($changed fichier(s) mis à jour)${RESET}"
cat <<EOF

Étapes restantes, côté application :

  1. Committer les fichiers copiés — ils partent avec le déploiement
     (public/vendor/ n'est pas gitignoré, contrairement à public/build/).

  2. Dans une page Livewire ou Filament :

       use App\\Support\\IsoGrid\\InteractsWithIsoGrid;

       class MaPage extends Page
       {
           use InteractsWithIsoGrid;

           protected function isoGridQuery(): EloquentBuilder { return Facture::query(); }
           protected function isoGridColumns(): array { return ['numero' => 'factures.numero']; }
       }

  3. Dans la vue :

       <x-isogrid :columns="\$this->gridColumns()" source="livewire" height="70vh" />

  4. Contrôler la synchro plus tard :  $0 $TARGET --check
EOF
