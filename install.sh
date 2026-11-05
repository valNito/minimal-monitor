#!/usr/bin/env bash
# Instala (o con --uninstall, desinstala) Minimal Monitor para el usuario actual. Todo queda en ~/.local.
set -euo pipefail

UUID=minimal-overlay@local
SRC=$(cd "$(dirname "$0")" && pwd)
DATA=${XDG_DATA_HOME:-$HOME/.local/share}
EXT_DIR=$DATA/gnome-shell/extensions/$UUID
APP=$DATA/applications/minimal-monitor.desktop
ICON=$DATA/icons/hicolor/scalable/apps/minimal-monitor.svg

enabled() { gsettings get org.gnome.shell enabled-extensions; }

if [[ ${1:-} == --uninstall ]]; then
    gdbus call --session --dest org.gnome.Shell --object-path /local/MinimalOverlay \
        --method local.MinimalOverlay.Hide >/dev/null 2>&1 || true
    gnome-extensions disable "$UUID" 2>/dev/null || true
    # Quita el uuid de la lista sin tocar las demás extensiones.
    gsettings set org.gnome.shell enabled-extensions \
        "$(enabled | sed -E "s/, '$UUID'//; s/'$UUID', //; s/'$UUID'//")"
    rm -rf "$EXT_DIR" "${XDG_CACHE_HOME:-$HOME/.cache}/minimal-overlay"
    rm -f "$APP" "$ICON" "${XDG_CONFIG_HOME:-$HOME/.config}/minimal-overlay.json"
    update-desktop-database -q "$DATA/applications" 2>/dev/null || true
    echo "Minimal Monitor desinstalado."
    exit 0
fi

mkdir -p "$EXT_DIR" "$(dirname "$APP")" "$(dirname "$ICON")"
# Base (requiere cerrar sesión si cambia) + parte recargable (view.js, metrics.js, view.css).
cp "$SRC/$UUID"/{metadata.json,extension.js,view.js,metrics.js,view.css} "$EXT_DIR/"
rm -f "$EXT_DIR/stylesheet.css" # versión anterior: GNOME lo cargaría por su cuenta
cp "$SRC/launcher/minimal-monitor.svg" "$ICON"
cp "$SRC/launcher/minimal-monitor.desktop" "$APP"
update-desktop-database -q "$DATA/applications" 2>/dev/null || true
gtk-update-icon-cache -q -t "$DATA/icons/hicolor" 2>/dev/null || true

# La extensión queda habilitada (cargada pero oculta y sin muestreo hasta que se abre el lanzador).
if ! enabled | grep -q "'$UUID'"; then
    current=$(enabled)
    if [[ $current == "@as []" || $current == "[]" ]]; then
        gsettings set org.gnome.shell enabled-extensions "['$UUID']"
    else
        gsettings set org.gnome.shell enabled-extensions "${current%]}, '$UUID']"
    fi
fi
gsettings set org.gnome.shell disable-user-extensions false

# ¿La base cargada en esta sesión es la misma que la recién instalada?
# (gdbus introspect no sirve aquí: no falla con rutas inexistentes)
new_base=$(sed -nE "s/^const BASE_VERSION = '([^']*)';/\1/p" "$EXT_DIR/extension.js")
loaded_base=$(gdbus call --session --dest org.gnome.Shell --object-path /local/MinimalOverlay \
    --method org.freedesktop.DBus.Properties.Get local.MinimalOverlay BaseVersion 2>/dev/null \
    | sed -nE "s/^\(<'([^']*)'>,\)$/\1/p" || true) # sin extensión cargada gdbus falla: no es error
if [[ -n $loaded_base && $loaded_base == "$new_base" ]]; then
    echo "Instalado. Para ver los cambios, cierra y vuelve a abrir «Minimal Monitor» desde el menú."
elif gdbus call --session --dest org.gnome.Shell --object-path /local/MinimalOverlay \
    --method org.freedesktop.DBus.Properties.Get local.MinimalOverlay Visible >/dev/null 2>&1; then
    echo "Instalado, pero cambió la base de la extensión: cierra sesión y vuelve a entrar una vez."
else
    echo "Instalado. GNOME Shell carga extensiones nuevas al iniciar sesión:"
    echo "cierra sesión y vuelve a entrar UNA vez; después se abre y cierra desde «Minimal Monitor»."
fi
