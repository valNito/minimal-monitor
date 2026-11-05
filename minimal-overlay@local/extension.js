// BASE FIJA del overlay: capa sobre las ventanas, visibilidad (D-Bus), temporizador, arrastre y posición.
// Cambiar este archivo exige cerrar sesión (GNOME no recarga extensiones en Wayland), así que se mantiene
// mínimo. Lo que cambia seguido vive en view.js, metrics.js y view.css: se recargan solos al abrir el
// monitor desde el menú si sus archivos cambiaron.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Subirlo cada vez que cambie este archivo: install.sh lo compara con el cargado para saber si
// hace falta cerrar sesión.
const BASE_VERSION = '2';

const LIVE_FILES = ['view.js', 'metrics.js', 'view.css'];
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'minimal-overlay']);
const POSITION_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'minimal-overlay.json']);
const MARGIN = 8;

// Control desde el lanzador (gdbus). Se exporta sobre la conexión de sesión que GNOME Shell
// ya tiene abierta (nombre org.gnome.Shell): no agrega procesos ni nombres de bus.
// Los métodos no reciben argumentos y solo cambian la visibilidad.
const DBUS_PATH = '/local/MinimalOverlay';
const DBUS_IFACE = `
<node>
  <interface name="local.MinimalOverlay">
    <method name="Toggle"><arg type="b" direction="out" name="visible"/></method>
    <method name="Show"/>
    <method name="Hide"/>
    <property name="Visible" type="b" access="read"/>
    <property name="BaseVersion" type="s" access="read"/>
  </interface>
</node>`;

// Estado a nivel de módulo: sobrevive al disable/enable que GNOME hace al bloquear la pantalla,
// pero se reinicia en cada inicio de sesión.
let wantVisible = false;
let loaded = null; // {stamp, dir, mod}: última versión de view.js importada

function loadPosition() {
    try {
        const [, bytes] = GLib.file_get_contents(POSITION_FILE);
        const {x, y} = JSON.parse(new TextDecoder().decode(bytes));
        if (Number.isFinite(x) && Number.isFinite(y))
            return {x, y};
    } catch {}
    return null;
}

function savePosition(pos) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(POSITION_FILE), 0o700);
        GLib.file_set_contents(POSITION_FILE, JSON.stringify(pos));
    } catch (e) {
        console.error(`[minimal-overlay] no se pudo guardar la posición: ${e}`);
    }
}

function deleteTree(file) {
    const children = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    let info;
    while ((info = children.next_file(null)) !== null)
        file.get_child(info.get_name()).delete(null);
    children.close(null);
    file.delete(null);
}

export default class MinimalOverlayExtension extends Extension {
    enable() {
        this._errorLogged = false;
        this._userPos = loadPosition();
        this._startToken = 0;

        // Reactivo para poder arrastrarlo con el botón izquierdo; no enfocable: nunca toma el teclado.
        this._panel = new St.BoxLayout({
            vertical: true,
            style_class: 'mso-panel',
            reactive: true,
            can_focus: false,
        });
        // Capa "top chrome" (Main.layoutManager.uiGroup, por encima de global.window_group): sobre
        // cualquier ventana normal o maximizada y en todos los espacios de trabajo.
        Main.layoutManager.addTopChrome(this._panel, {
            affectsInputRegion: true,
            affectsStruts: false,
            trackFullscreen: false,
        });
        this._panel.hide();

        this._panel.connect('button-press-event', (a, e) => this._onPress(e));
        this._panel.connect('motion-event', (a, e) => this._onMotion(e));
        this._panel.connect('button-release-event', () => this._onRelease());
        this._panel.connect('enter-event', () => this._setCursor(Meta.Cursor.MOVE_OR_RESIZE_WINDOW));
        this._panel.connect('leave-event', () => {
            if (!this._grab)
                this._setCursor(Meta.Cursor.DEFAULT);
        });

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._reposition());
        this._workareasId = global.display.connect('workareas-changed', () => this._reposition());

        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_IFACE, {
            Toggle: () => this._setVisible(!wantVisible),
            Show: () => void this._setVisible(true),
            Hide: () => void this._setVisible(false),
            get Visible() {
                return wantVisible;
            },
            get BaseVersion() {
                return BASE_VERSION;
            },
        });
        this._dbus.export(Gio.DBus.session, DBUS_PATH);

        if (wantVisible)
            this._start();
    }

    disable() {
        if (this._dbus) {
            this._dbus.unexport();
            this._dbus = null;
        }
        this._stop();
        this._unloadCss();
        if (this._cursorChanged)
            this._setCursor(Meta.Cursor.DEFAULT);
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (this._workareasId) {
            global.display.disconnect(this._workareasId);
            this._workareasId = 0;
        }
        if (this._panel) {
            Main.layoutManager.removeChrome(this._panel);
            this._panel.destroy(); // también desconecta las señales del propio panel
            this._panel = null;
        }
        this._userPos = null;
    }

    _setVisible(visible) {
        if (visible === wantVisible)
            return visible;
        wantVisible = visible;
        if (visible)
            this._start();
        else
            this._stop();
        this._dbus?.emit_property_changed('Visible', GLib.Variant.new_boolean(visible));
        return visible;
    }

    // --- Mostrar / ocultar ------------------------------------------------------------------

    async _start() {
        if (this._timerId)
            return;
        const token = ++this._startToken;
        let version = null;
        try {
            version = await this._loadLiveFiles();
        } catch (e) {
            this._logOnce(`no se pudo cargar la vista nueva, se usa la anterior: ${e}`);
            version = loaded; // si el código nuevo falla, sigue la versión que ya funcionaba
        }
        // Mientras cargaba pudieron ocultarlo, volver a mostrarlo o desactivar la extensión.
        if (token !== this._startToken || !wantVisible || !this._panel || this._timerId)
            return;

        try {
            if (!version)
                throw new Error('no hay ninguna versión de view.js que funcione');
            this._loadCss(version.dir);
            this._view = version.mod.createView(this._panel);
        } catch (e) {
            this._view?.destroy();
            this._view = null;
            this._panel.destroy_all_children();
            this._panel.add_child(new St.Label({text: 'Minimal Monitor: error (ver journal)'}));
            this._logOnce(`${e}`);
        }
        this._panel.show();
        this._reposition();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            try {
                this._view?.update();
            } catch (e) {
                this._logOnce(`${e}`); // un solo log, nunca en cada ciclo
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Ocultar: sin temporizador ni muestreo; la vista se destruye y solo quedan el panel vacío y el objeto D-Bus.
    _stop() {
        this._startToken++;
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        this._endDrag(false);
        try {
            this._view?.destroy();
        } catch (e) {
            this._logOnce(`${e}`);
        }
        this._view = null;
        this._panel?.destroy_all_children();
        this._panel?.hide();
    }

    _logOnce(msg) {
        if (this._errorLogged)
            return;
        console.error(`[minimal-overlay] ${msg}`);
        this._errorLogged = true;
    }

    // --- Recarga en caliente ----------------------------------------------------------------

    // Si view.js, metrics.js o view.css cambiaron desde la última carga, los copia a una carpeta
    // nueva en ~/.cache/minimal-overlay/<marca> y los importa desde ahí: una URL nueva obliga a GJS
    // a leer el código otra vez (las importaciones se guardan por URL). Las versiones anteriores
    // quedan en memoria hasta cerrar sesión; son unos pocos KB por cambio.
    async _loadLiveFiles() {
        const src = this.dir;
        const stamp = LIVE_FILES.map(name => {
            const info = src.get_child(name).query_info('time::modified,time::modified-usec,standard::size',
                Gio.FileQueryInfoFlags.NONE, null);
            return `${info.get_attribute_uint64('time::modified')}.${info.get_attribute_uint32('time::modified-usec')}.${info.get_size()}`;
        }).join('-');
        if (loaded?.stamp === stamp)
            return loaded;

        const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, stamp, -1).slice(0, 12);
        const dir = Gio.File.new_for_path(GLib.build_filenamev([CACHE_DIR, key]));
        GLib.mkdir_with_parents(dir.get_path(), 0o700);
        for (const name of LIVE_FILES)
            src.get_child(name).copy(dir.get_child(name), Gio.FileCopyFlags.OVERWRITE, null, null);

        const mod = await import(dir.get_child('view.js').get_uri());
        if (typeof mod.createView !== 'function')
            throw new Error('view.js no exporta createView');
        loaded = {stamp, dir, mod};
        this._errorLogged = false;
        this._cleanCache(key);
        return loaded;
    }

    _cleanCache(keep) {
        try {
            const root = Gio.File.new_for_path(CACHE_DIR);
            const children = root.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let info;
            while ((info = children.next_file(null)) !== null) {
                if (info.get_name() !== keep)
                    deleteTree(root.get_child(info.get_name()));
            }
            children.close(null);
        } catch {}
    }

    _loadCss(dir) {
        const file = dir.get_child('view.css');
        if (this._cssFile?.equal(file))
            return;
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        theme.load_stylesheet(file);
        this._unloadCss();
        this._cssFile = file;
    }

    _unloadCss() {
        if (!this._cssFile)
            return;
        St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._cssFile);
        this._cssFile = null;
    }

    // --- Arrastre ---------------------------------------------------------------------------

    _onPress(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._dragDx = x - this._panel.x;
        this._dragDy = y - this._panel.y;
        this._grab = global.stage.grab(this._panel); // recibe el movimiento aunque el puntero salga
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._userPos = this._clamp(x - this._dragDx, y - this._dragDy);
        this._panel.set_position(this._userPos.x, this._userPos.y);
        return Clutter.EVENT_STOP;
    }

    _onRelease() {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;
        this._endDrag(true);
        return Clutter.EVENT_STOP;
    }

    _endDrag(save) {
        if (!this._grab)
            return;
        this._grab.dismiss();
        this._grab = null;
        if (!this._panel?.hover)
            this._setCursor(Meta.Cursor.DEFAULT);
        if (save && this._userPos)
            savePosition(this._userPos); // una escritura por arrastre, no por movimiento
    }

    _setCursor(cursor) {
        global.display.set_cursor(cursor);
        this._cursorChanged = cursor !== Meta.Cursor.DEFAULT;
    }

    // --- Posición ---------------------------------------------------------------------------

    _clamp(x, y) {
        const [w, h] = this._panel.get_size();
        const [sw, sh] = global.stage.get_size();
        return {
            x: Math.round(Math.min(Math.max(0, x), Math.max(0, sw - w))),
            y: Math.round(Math.min(Math.max(0, y), Math.max(0, sh - h))),
        };
    }

    // Posición guardada por el usuario (ajustada si cambió la pantalla) o, si no hay,
    // esquina superior derecha del área de trabajo del monitor principal.
    _reposition() {
        if (!wantVisible || !this._panel)
            return;
        if (this._userPos) {
            const p = this._clamp(this._userPos.x, this._userPos.y);
            this._panel.set_position(p.x, p.y);
            return;
        }
        const monitor = Main.layoutManager.primaryIndex;
        if (monitor < 0)
            return;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const [, width] = this._panel.get_preferred_width(-1);
        this._panel.set_position(area.x + area.width - width - MARGIN, area.y + MARGIN);
    }
}
