// Parte RECARGABLE: contenido del panel (título, filas, formato) y muestreo.
// Al abrir el monitor desde el menú, la base vuelve a cargar este archivo, metrics.js y view.css
// si cambiaron: no hace falta cerrar sesión.
//
// Contrato con la base (extension.js), que no debe cambiar:
//   createView(panel) -> { update(): void, destroy(): void }
//   - createView agrega sus actores dentro de `panel` y muestra la primera muestra.
//   - update() se llama una vez por segundo mientras el panel está visible.
//   - destroy() quita sus actores y suelta referencias (se llama al ocultar el panel).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {DockerSampler, Sampler} from './metrics.js';

const TITLE = 'STATE';
const NAMES = ['CPU', 'RAM', 'DISK', 'SWAP', 'TEMP'];
const [CPU, RAM, DISK, SWAP, TEMP] = [0, 1, 2, 3, 4];
const BAR_WIDTH = 64; // debe coincidir con .mso-track { width } en view.css
const GIB = 1024 * 1024; // kB -> GiB
const DOCKER_ROWS = 5;   // como máximo, los más ocupados
// Preferencias de la vista (hoy solo si DOCKER está colapsada). Se escribe solo al hacer clic.
const VIEW_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'minimal-overlay-view.json']);

function loadPrefs() {
    try {
        const [, bytes] = GLib.file_get_contents(VIEW_FILE);
        return JSON.parse(new TextDecoder().decode(bytes)) ?? {};
    } catch {
        return {};
    }
}

function savePrefs(prefs) {
    try {
        GLib.file_set_contents(VIEW_FILE, JSON.stringify(prefs));
    } catch {}
}

function fmtGiB(kb) {
    const g = kb / GIB;
    return g < 100 ? g.toFixed(1) : g.toFixed(0);
}

function fmtRate(bytesPerSec) {
    const mb = bytesPerSec / 1e6;
    if (mb < 10)
        return `${mb.toFixed(1)} MB/s`;
    if (mb < 1000)
        return `${mb.toFixed(0)} MB/s`;
    return `${(mb / 1000).toFixed(1)} GB/s`;
}

function fmtBytes(b) {
    const mib = b / 1048576;
    if (mib < 1000)
        return `${mib.toFixed(0)}M`;
    const gib = mib / 1024;
    return gib < 100 ? `${gib.toFixed(1)}G` : `${gib.toFixed(0)}G`;
}

export function createView(panel) {
    // Línea base nueva: CPU y DISK marcan 0 durante el primer segundo.
    // Crear el Sampler aquí también vuelve a detectar discos conectados mientras estaba oculto.
    let sampler = new Sampler();

    panel.add_child(new St.Label({text: TITLE, style_class: 'mso-title'}));
    let rows = NAMES.map(name => {
        const row = new St.BoxLayout({style_class: 'mso-row'});
        const track = new St.Widget({style_class: 'mso-track', y_align: Clutter.ActorAlign.CENTER});
        const fill = new St.Widget({style_class: 'mso-fill', width: 0});
        const value = new St.Label({text: '', style_class: 'mso-value', y_align: Clutter.ActorAlign.CENTER});
        const amount = new St.Label({text: '', style_class: 'mso-amount', y_align: Clutter.ActorAlign.CENTER});
        track.add_child(fill);
        row.add_child(new St.Label({text: name, style_class: 'mso-name', y_align: Clutter.ActorAlign.CENTER}));
        row.add_child(track);
        row.add_child(value);
        row.add_child(amount);
        panel.add_child(row);
        return {row, fill, value, amount, bar: -1};
    });
    rows[TEMP].row.visible = sampler.hasTemp;

    // Sección DOCKER: actores creados una vez y reutilizados; oculta si no hay contenedores.
    // Clic en el encabezado: colapsa o expande. Detiene el evento, así el clic no inicia el arrastre del
    // panel (la base escucha button-press-event en el panel, que recibe el evento después del encabezado).
    let docker = new DockerSampler(sampler.cpuCount);
    const prefs = loadPrefs();
    let collapsed = prefs.dockerCollapsed === true;
    let dockerCount = 0;
    const dockerTitle = new St.Label({
        text: '', style_class: 'mso-title mso-subtitle mso-toggle', visible: false, reactive: true,
    });
    dockerTitle.connect('button-press-event', () => Clutter.EVENT_STOP);
    dockerTitle.connect('button-release-event', (a, e) => {
        if (e.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;
        collapsed = !collapsed;
        prefs.dockerCollapsed = collapsed;
        savePrefs(prefs);
        sampleDocker();
        renderDocker();
        return Clutter.EVENT_STOP;
    });
    dockerTitle.connect('enter-event', () => global.display.set_cursor(Meta.Cursor.POINTING_HAND));
    dockerTitle.connect('leave-event', () => global.display.set_cursor(Meta.Cursor.MOVE_OR_RESIZE_WINDOW));
    panel.add_child(dockerTitle);
    let dockerRows = [];
    for (let i = 0; i < DOCKER_ROWS; i++) {
        const row = new St.BoxLayout({style_class: 'mso-row', visible: false});
        const name = new St.Label({text: '', style_class: 'mso-dname', y_align: Clutter.ActorAlign.CENTER});
        const value = new St.Label({text: '', style_class: 'mso-value', y_align: Clutter.ActorAlign.CENTER});
        const amount = new St.Label({text: '', style_class: 'mso-amount', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(name);
        row.add_child(value);
        row.add_child(amount);
        panel.add_child(row);
        dockerRows.push({row, name, value, amount});
    }

    // Solo toca un actor si su contenido visible cambió: sin relayout ni repintado innecesario.
    function set(i, pct, value, amount) {
        const row = rows[i];
        const bar = Math.round(BAR_WIDTH * Math.min(100, Math.max(0, pct)) / 100);
        if (bar !== row.bar) {
            row.bar = bar;
            row.fill.width = bar;
        }
        if (row.value.text !== value)
            row.value.text = value;
        if (row.amount.text !== amount)
            row.amount.text = amount;
    }

    function render() {
        const s = sampler;
        set(CPU, s.cpu, `${Math.round(s.cpu)}%`, `${s.cpuCores.toFixed(1)}/${s.cpuCount} núc`);
        set(RAM, s.ram, `${Math.round(s.ram)}%`, `${fmtGiB(s.memUsedKb)}/${fmtGiB(s.memTotalKb)}G`);
        set(DISK, s.disk, `${Math.round(s.disk)}%`, fmtRate(s.diskBytesPerSec));
        set(SWAP, s.swap, `${Math.round(s.swap)}%`,
            s.swapTotalKb > 0 ? `${fmtGiB(s.swapUsedKb)}/${fmtGiB(s.swapTotalKb)}G` : 'sin swap');
        if (s.hasTemp) {
            const t = s.tempC;
            set(TEMP, t === null ? 0 : 100 * t / s.tempCrit,
                t === null ? '–' : `${Math.round(t)}°C`, `máx ${Math.round(s.tempCrit)}°C`);
        }
        renderDocker();
    }

    function setText(label, text) {
        if (label.text !== text)
            label.text = text;
    }

    function setVisible(actor, v) {
        if (actor.visible !== v)
            actor.visible = v;
    }

    function renderDocker() {
        const list = docker.containers;
        setVisible(dockerTitle, dockerCount > 0);
        setText(dockerTitle, collapsed ? `DOCKER ▸ ${dockerCount}` : 'DOCKER ▾');
        for (let i = 0; i < DOCKER_ROWS; i++) {
            const r = dockerRows[i], c = collapsed ? undefined : list[i];
            setVisible(r.row, c !== undefined);
            if (!c)
                continue;
            setText(r.name, c.name);
            setText(r.value, `${c.cpu < 10 ? c.cpu.toFixed(1) : Math.round(c.cpu)}%`);
            setText(r.amount, fmtBytes(c.memBytes));
        }
    }

    function sampleDocker() {
        if (collapsed) {
            dockerCount = docker.count();
        } else if (docker.available) {
            docker.sample();
            dockerCount = docker.containers.length;
        }
    }

    function sampleAll() {
        sampler.sample();
        sampleDocker();
    }

    sampleAll();
    render();

    return {
        update() {
            sampleAll();
            render();
        },
        destroy() {
            docker.destroy(); // cancela la consulta de nombres pendiente
            panel.destroy_all_children();
            rows = null;
            dockerRows = null;
            docker = null;
            sampler = null;
        },
    };
}
