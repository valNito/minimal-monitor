// Lectura de métricas desde las interfaces del kernel.
// Solo depende de GLib para poder probarse con `gjs -m` fuera de GNOME Shell.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const decoder = new TextDecoder();
const SECTOR_BYTES = 512; // /sys/block/*/stat siempre cuenta en sectores de 512 bytes

function readText(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return decoder.decode(bytes);
}

function readInt(path) {
    return parseInt(readText(path), 10);
}

// Discos completos con dispositivo físico detrás (nvme0n1, sda, vda, xvda, mmcblk0...).
// Se descartan loop, ram, zram, dm-*, md*, nbd y ópticos: así no se cuenta
// dos veces la misma E/S (partición + padre, o LUKS/LVM + disco subyacente).
export function findPhysicalDisks() {
    const disks = [];
    const dir = GLib.Dir.open('/sys/block', 0);
    let name;
    while ((name = dir.read_name()) !== null) {
        if (/^(loop|ram|zram|dm-|md|nbd|sr|fd)/.test(name))
            continue;
        if (GLib.file_test(`/sys/block/${name}/device`, GLib.FileTest.EXISTS))
            disks.push(name);
    }
    dir.close();
    return disks.sort();
}

// Sensor de temperatura del procesador, buscado una sola vez:
// Intel coretemp "Package id 0", AMD k10temp/zenpower "Tctl"/"Tdie", ARM cpu_thermal;
// si no hay, la zona térmica x86_pkg_temp. Devuelve {input, crit} o null.
export function findCpuTempSensor() {
    const wanted = {coretemp: /^Package id 0$/, k10temp: /^T(ctl|die)$/, zenpower: /^T(ctl|die)$/, cpu_thermal: null};
    const base = '/sys/class/hwmon';
    if (GLib.file_test(base, GLib.FileTest.IS_DIR)) {
        const dir = GLib.Dir.open(base, 0);
        let entry, found = null;
        while (!found && (entry = dir.read_name()) !== null) {
            const hw = `${base}/${entry}`;
            let name;
            try {
                name = readText(`${hw}/name`).trim();
            } catch {
                continue;
            }
            if (!(name in wanted))
                continue;
            for (let i = 1; i <= 64 && !found; i++) {
                const input = `${hw}/temp${i}_input`;
                if (!GLib.file_test(input, GLib.FileTest.EXISTS))
                    continue;
                let label = '';
                try {
                    label = readText(`${hw}/temp${i}_label`).trim();
                } catch {}
                if (wanted[name] === null || wanted[name].test(label))
                    found = {input, crit: `${hw}/temp${i}_crit`};
            }
        }
        dir.close();
        if (found)
            return withCrit(found);
    }
    for (let i = 0; i < 32; i++) {
        const zone = `/sys/class/thermal/thermal_zone${i}`;
        if (!GLib.file_test(zone, GLib.FileTest.IS_DIR))
            break;
        try {
            if (readText(`${zone}/type`).trim() === 'x86_pkg_temp')
                return withCrit({input: `${zone}/temp`, crit: null});
        } catch {}
    }
    return null;
}

function withCrit(sensor) {
    let crit = 100;
    try {
        if (sensor.crit)
            crit = readInt(sensor.crit) / 1000 || 100;
    } catch {}
    return {input: sensor.input, crit};
}

export class Sampler {
    constructor() {
        this._cpuTotal = 0;
        this._cpuIdle = 0;
        this.cpuCount = (readText('/proc/stat').match(/^cpu\d+ /gm) ?? []).length || 1;
        this._disks = findPhysicalDisks();
        this._diskStatPaths = this._disks.map(d => `/sys/block/${d}/stat`);
        this._diskTicks = this._disks.map(() => 0);
        this._diskSectors = this._disks.map(() => 0);
        this._diskTime = 0;
        this._temp = findCpuTempSensor();

        // Porcentajes (0–100)
        this.cpu = 0;
        this.ram = 0;
        this.swap = 0;
        this.disk = 0;
        // Cantidades
        this.cpuCores = 0;      // núcleos equivalentes ocupados
        this.memUsedKb = 0;
        this.memTotalKb = 0;
        this.swapUsedKb = 0;
        this.swapTotalKb = 0;
        this.diskBytesPerSec = 0; // lectura + escritura, suma de los discos físicos
        this.tempC = null;      // null si no hay sensor
        this.tempCrit = this._temp?.crit ?? 100;
    }

    get disks() {
        return this._disks;
    }

    get hasTemp() {
        return this._temp !== null;
    }

    // Toma una muestra. La primera llamada solo establece la línea base de CPU y disco.
    sample() {
        this._sampleCpu();
        this._sampleMem();
        this._sampleDisk();
        this._sampleTemp();
    }

    // /proc/stat, línea "cpu": user nice system idle iowait irq softirq steal guest guest_nice.
    // guest/guest_nice ya están incluidos en user/nice, por eso se suman solo los 8 primeros.
    _sampleCpu() {
        const text = readText('/proc/stat');
        const f = text.slice(0, text.indexOf('\n')).split(/\s+/);
        let total = 0;
        for (let i = 1; i <= 8; i++)
            total += Number(f[i]) || 0;
        const idle = Number(f[4]) + Number(f[5]); // idle + iowait

        const dTotal = total - this._cpuTotal;
        const dIdle = idle - this._cpuIdle;
        if (this._cpuTotal > 0 && dTotal > 0)
            this.cpu = clamp(100 * (dTotal - dIdle) / dTotal);
        this.cpuCores = this.cpu / 100 * this.cpuCount;
        this._cpuTotal = total;
        this._cpuIdle = idle;
    }

    // /proc/meminfo: RAM usada = MemTotal - MemAvailable; SWAP usada = SwapTotal - SwapFree (kB).
    _sampleMem() {
        const text = readText('/proc/meminfo');
        this.memTotalKb = field(text, 'MemTotal');
        this.memUsedKb = Math.max(0, this.memTotalKb - field(text, 'MemAvailable'));
        this.swapTotalKb = field(text, 'SwapTotal');
        this.swapUsedKb = Math.max(0, this.swapTotalKb - field(text, 'SwapFree'));
        this.ram = this.memTotalKb > 0 ? clamp(100 * this.memUsedKb / this.memTotalKb) : 0;
        this.swap = this.swapTotalKb > 0 ? clamp(100 * this.swapUsedKb / this.swapTotalKb) : 0;
    }

    // /sys/block/<disk>/stat: los mismos contadores que su línea de /proc/diskstats.
    // Campo 3 = sectores leídos, 7 = sectores escritos, 10 = io_ticks (ms con E/S en curso).
    // % ocupado: el disco más ocupado (no se suman: 2 discos al 100% no son 200%).
    // Bytes/s: suma de todos (solo discos completos, así que nada se cuenta dos veces).
    _sampleDisk() {
        const now = GLib.get_monotonic_time(); // µs
        const dtMs = (now - this._diskTime) / 1000;
        const valid = this._diskTime > 0 && dtMs > 0;
        let busiest = 0, bytes = 0;
        for (let i = 0; i < this._diskStatPaths.length; i++) {
            let f;
            try {
                f = readText(this._diskStatPaths[i]).trim().split(/\s+/);
            } catch {
                continue; // disco retirado (USB desconectado, etc.)
            }
            const ticks = Number(f[9]);
            const sectors = Number(f[2]) + Number(f[6]);
            const dTicks = ticks - this._diskTicks[i];
            const dSectors = sectors - this._diskSectors[i];
            if (valid && dTicks >= 0)
                busiest = Math.max(busiest, 100 * dTicks / dtMs);
            if (valid && dSectors >= 0)
                bytes += dSectors * SECTOR_BYTES;
            this._diskTicks[i] = ticks;
            this._diskSectors[i] = sectors;
        }
        this.disk = clamp(busiest);
        this.diskBytesPerSec = valid ? bytes * 1000 / dtMs : 0;
        this._diskTime = now;
    }

    // hwmon/thermal entregan miligrados Celsius.
    _sampleTemp() {
        if (!this._temp)
            return;
        try {
            this.tempC = readInt(this._temp.input) / 1000;
        } catch {
            this.tempC = null;
        }
    }
}

function field(text, key) {
    const i = text.indexOf(`${key}:`);
    return i < 0 ? 0 : parseInt(text.slice(i + key.length + 1), 10) || 0;
}

// Archivos de cgroup "clave valor" por línea.
const USAGE_USEC = /^usage_usec (\d+)$/m;
const INACTIVE_FILE = /^inactive_file (\d+)$/m;
function kv(text, re) {
    const m = re.exec(text);
    return m ? Number(m[1]) : 0;
}

function clamp(v) {
    return v < 0 ? 0 : v > 100 ? 100 : v;
}

// ---------------------------------------------------------------------------------------------
// Contenedores Docker en ejecución.
// El uso sale de los cgroups v2 de cada contenedor (los mismos contadores que usa `docker stats`):
//   cpu.stat usage_usec, memory.current y memory.stat inactive_file.
// Los nombres se piden al socket de Docker (GET /containers/json) solo cuando cambia el conjunto de
// contenedores, de forma asíncrona. Si no hay permiso sobre el socket, se muestra el id corto.
const DOCKER_SOCK = '/var/run/docker.sock';
const CGROUP_DIRS = [
    {dir: '/sys/fs/cgroup/system.slice', re: /^docker-([0-9a-f]{64})\.scope$/}, // driver systemd
    {dir: '/sys/fs/cgroup/docker', re: /^([0-9a-f]{64})$/},                     // driver cgroupfs
];

export class DockerSampler {
    constructor(cpuCount) {
        this._cpuCount = cpuCount || 1;
        this._dirs = CGROUP_DIRS.filter(d => GLib.file_test(d.dir, GLib.FileTest.IS_DIR));
        this._state = new Map();  // id -> {path, usec, time}
        this._names = new Map();  // id -> nombre
        this._fetching = false;
        this._pending = false;    // cambió el conjunto mientras se pedían los nombres
        this._cancel = new Gio.Cancellable();
        this.containers = [];     // [{id, name, cpu (% de la máquina), memBytes}], más ocupado primero
    }

    get available() {
        return this._dirs.length > 0;
    }

    sample() {
        const now = GLib.get_monotonic_time();
        const seen = new Map();
        for (const {dir, re} of this._dirs) {
            const d = GLib.Dir.open(dir, 0);
            let entry;
            while ((entry = d.read_name()) !== null) {
                const m = re.exec(entry);
                if (m)
                    seen.set(m[1], `${dir}/${entry}`);
            }
            d.close();
        }

        let unknown = false;
        const out = [];
        for (const [id, path] of seen) {
            let usec, mem;
            try {
                usec = kv(readText(`${path}/cpu.stat`), USAGE_USEC);
                const inactive = kv(readText(`${path}/memory.stat`), INACTIVE_FILE);
                mem = Math.max(0, readInt(`${path}/memory.current`) - inactive);
            } catch {
                continue; // el contenedor se detuvo entre el listado y la lectura
            }
            const prev = this._state.get(id);
            let cpu = 0;
            if (prev && now > prev.time && usec >= prev.usec)
                cpu = clamp(100 * (usec - prev.usec) / (now - prev.time) / this._cpuCount);
            this._state.set(id, {usec, time: now});
            if (!this._names.has(id))
                unknown = true;
            out.push({id, name: this._names.get(id) ?? id.slice(0, 12), cpu, memBytes: mem});
        }
        for (const id of this._state.keys()) {
            if (!seen.has(id)) {
                this._state.delete(id);
                this._names.delete(id);
            }
        }
        // Orden por la CPU tal como se muestra (un decimal) y, si empatan, por RAM: la lista no salta
        // por diferencias que no se ven.
        const shown = c => Math.round(c.cpu * 10);
        out.sort((a, b) => shown(b) - shown(a) || b.memBytes - a.memBytes);
        this.containers = out;
        if (unknown)
            this._fetchNames();
    }

    destroy() {
        this._cancel.cancel();
        this._state.clear();
        this._names.clear();
        this.containers = [];
    }

    _fetchNames() {
        if (this._fetching) {
            this._pending = true;
            return;
        }
        if (this._namesFailed)
            return; // sin acceso al socket: no reintentar cada segundo
        this._fetching = true;
        this._pending = false;
        const cancel = this._cancel;
        const done = (body, conn) => {
            try {
                conn?.close(null);
            } catch {}
            if (cancel.is_cancelled())
                return;
            this._fetching = false;
            if (body === null) {
                this._namesFailed = true;
                return;
            }
            try {
                for (const c of JSON.parse(body))
                    this._names.set(c.Id, (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''));
            } catch {
                this._namesFailed = true;
                return;
            }
            if (this._pending)
                this._fetchNames();
        };

        const client = new Gio.SocketClient();
        client.connect_async(Gio.UnixSocketAddress.new(DOCKER_SOCK), cancel, (c, res) => {
            let conn;
            try {
                conn = c.connect_finish(res);
            } catch {
                done(null);
                return;
            }
            const req = new TextEncoder().encode('GET /containers/json HTTP/1.0\r\nHost: docker\r\n\r\n');
            conn.get_output_stream().write_bytes_async(new GLib.Bytes(req), GLib.PRIORITY_DEFAULT, cancel,
                (o, r) => {
                    try {
                        if (o.write_bytes_finish(r) !== req.length)
                            throw new Error('escritura incompleta');
                    } catch {
                        done(null, conn);
                        return;
                    }
                    readAll(conn.get_input_stream(), cancel, raw => {
                        if (raw === null) {
                            done(null, conn);
                            return;
                        }
                        const text = decoder.decode(raw);
                        const sep = text.indexOf('\r\n\r\n');
                        const ok = sep > 0 && / 200 /.test(text.slice(0, text.indexOf('\r\n')));
                        done(ok ? text.slice(sep + 4) : null, conn);
                    });
                });
        });
    }
}

// Lee un stream hasta EOF (HTTP/1.0: Docker cierra la conexión al terminar la respuesta).
function readAll(stream, cancel, cb, chunks = [], size = 0) {
    stream.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, cancel, (s, res) => {
        let bytes;
        try {
            bytes = s.read_bytes_finish(res);
        } catch {
            cb(null);
            return;
        }
        const n = bytes.get_size();
        if (n === 0 || size + n > 4 * 1024 * 1024) {
            const all = new Uint8Array(size);
            let off = 0;
            for (const ch of chunks) {
                all.set(ch, off);
                off += ch.length;
            }
            cb(n === 0 ? all : null);
            return;
        }
        const arr = bytes.toArray();
        chunks.push(arr);
        readAll(stream, cancel, cb, chunks, size + arr.length);
    });
}
