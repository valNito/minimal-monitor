# Minimal System Overlay

Extensión de GNOME Shell (GJS) que muestra **CPU, RAM, DISK, SWAP, la temperatura del procesador y los
contenedores Docker en ejecución** en un panel pequeño, semitransparente, siempre encima de las ventanas. Cada fila
trae el porcentaje y la cantidad:

```
STATE
CPU   ▬▬▬▬   6%   0.9/16 núc     núcleos ocupados / núcleos
RAM   ▬▬▬▬  57%   8.7/15.3G      GiB usados / total
DISK  ▬▬▬▬   1%   0.6 MB/s       lectura + escritura por segundo
SWAP  ▬▬▬▬   0%   0.0/4.0G       GiB usados / total
TEMP  ▬▬▬▬  47°C  máx 100°C      la barra va de 0 al límite crítico del sensor
DOCKER
api          6.3%   2.4G         % de CPU de toda la máquina, RAM
rflex-mariadb 0.1%  315M         (máximo 5, el que más CPU usa primero; si empatan, el que más RAM)
```

La sección DOCKER solo aparece si hay contenedores en ejecución.

Aparece en la esquina superior derecha. **Se puede arrastrar** con el botón izquierdo y la posición se guarda en
`~/.config/minimal-overlay.json`.

Verificado en: Ubuntu 24.04.4, GNOME Shell 46.0, Wayland, GJS 1.80.

```
minimal-overlay@local/
├── metadata.json   # uuid, shell-version ["46"]
├── extension.js    # BASE FIJA: capa, visibilidad (D-Bus), temporizador, arrastre, posición
├── view.js         # RECARGABLE: título, filas, formato
├── metrics.js      # RECARGABLE: lectura de /proc y /sys (solo depende de GLib; se puede probar con gjs)
└── view.css        # RECARGABLE: estilos
launcher/           # minimal-monitor.desktop + ícono
install.sh          # instala / --uninstall
```

### Actualizar sin cerrar sesión

Después de modificar `view.js`, `metrics.js` o `view.css`: `./install.sh` y luego cerrar y abrir
**Minimal Monitor** desde el menú. Al abrirse, la base revisa si esos tres archivos cambiaron (fecha y tamaño).
Si cambiaron, los copia a `~/.cache/minimal-overlay/<marca>/` y los importa desde ahí: como la ruta es nueva,
GJS lee el código otra vez. `view.css` se carga y descarga con `St.Theme`.

- Si el código nuevo falla (por ejemplo, un error de sintaxis), el monitor sigue con la versión anterior y deja
  una línea en el journal.
- Cada versión cargada queda en la memoria de GNOME Shell hasta cerrar sesión: unos pocos KB por cambio.
- Si cambia `extension.js` (la base), sí hay que cerrar sesión. Cada cambio de la base sube su
  `BASE_VERSION`. `install.sh` la compara con la que está cargada y te dice cuál de los dos casos aplica.
- El contrato entre la base y la vista no debe cambiar: `createView(panel) → { update(), destroy() }`.

## Instalación

```bash
./install.sh
```

Copia todo a `~/.local/share`: la extensión, el lanzador `applications/minimal-monitor.desktop` y el ícono
`icons/hicolor/scalable/apps/minimal-monitor.svg`. Además agrega el uuid a `org.gnome.shell enabled-extensions`.

En **Wayland, GNOME Shell solo descubre extensiones nuevas al iniciar sesión**: después de la primera
instalación hay que cerrar sesión y volver a entrar **una vez**. Desde ahí no hace falta reiniciar nada.

## Uso

Abre **Minimal Monitor** desde el menú de aplicaciones: el overlay aparece. Vuelve a abrirlo: se oculta.

- Al iniciar sesión el overlay está **oculto**. Solo aparece cuando lo abres.
- Oculto, **no muestrea nada**: no hay temporizador ni lecturas de `/proc`. Solo quedan en memoria los actores
  ocultos y el objeto D-Bus.
- Si lo dejas abierto y bloqueas la pantalla, sigue abierto al desbloquear. Al cerrar sesión vuelve a quedar
  oculto.

El lanzador no deja procesos corriendo: ejecuta un `gdbus call` que termina enseguida. La extensión publica el
control sobre la conexión D-Bus que GNOME Shell ya tiene abierta (`org.gnome.Shell`, ruta
`/local/MinimalOverlay`). Los métodos no reciben argumentos y lo único que hacen es mostrar u ocultar el
overlay:

```bash
gdbus call --session --dest org.gnome.Shell --object-path /local/MinimalOverlay --method local.MinimalOverlay.Toggle
#   también: .Show  .Hide   y la propiedad de solo lectura Visible
```

Si la extensión no está cargada (todavía no cerraste sesión tras instalar, o la desactivaste), el lanzador
muestra una notificación explicándolo.

Para **actualizar el código** ver "Actualizar sin cerrar sesión" más arriba.

## Desinstalación

```bash
./install.sh --uninstall
```

Quita la extensión, el lanzador, el ícono y el uuid de `enabled-extensions`, sin tocar las demás extensiones.

## Depuración

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i minimal-overlay   # errores de la extensión
gnome-extensions info minimal-overlay@local                            # State: ERROR => ver journal
```

La extensión registra **como máximo una línea** (el primer error de lectura); nunca escribe logs periódicos.

Probar cambios sin cerrar tu sesión, en un GNOME Shell anidado en una ventana:

```bash
dbus-run-session -- gnome-shell --nested --wayland
# dentro de la ventana anidada:  gnome-extensions enable minimal-overlay@local
```

Probar solo las métricas (sin GNOME Shell):

```bash
cat > /tmp/mso-check.js <<EOF
import GLib from 'gi://GLib';
import {Sampler} from 'file://$PWD/minimal-overlay@local/metrics.js';
const s = new Sampler(); s.sample();
GLib.usleep(1000000); s.sample();
print(JSON.stringify({disks: s.disks, cpu: s.cpu, ram: s.ram, disk: s.disk, swap: s.swap}));
EOF
gjs -m /tmp/mso-check.js
```

Looking Glass (`Alt+F2` → `lg`) permite inspeccionar el actor `.mso-panel` en vivo.

## Cómo funciona

### Capa del overlay

Una ventana GTK normal no puede ponerse "siempre encima" en Wayland: el protocolo no deja que un cliente se
posicione ni se apile por sí mismo. Por eso el overlay no es una ventana: es un actor `St.BoxLayout` dentro del
propio compositor, agregado con `Main.layoutManager.addTopChrome()`. Eso lo pone en `uiGroup` por encima de
`global.window_group`, así que queda sobre todas las ventanas (también maximizadas) y en todos los escritorios
virtuales, porque no pertenece a ninguno.

- El panel es `reactive: true` para poder arrastrarlo, así que **los clics sobre su recuadro no llegan a la
  ventana de abajo**. Fuera del recuadro todo funciona normal. Nunca toma el teclado (`can_focus: false`) ni el
  foco de la ventana activa.
- Arrastre: `global.stage.grab()` mientras se mantiene el botón; la posición se limita a la pantalla y se
  escribe en disco una sola vez, al soltar. Si cambian los monitores, se ajusta para no quedar fuera.
- `affectsStruts: false`: no reserva espacio; las ventanas maximizadas no se achican.
- `trackFullscreen: false`: sigue visible aunque haya una aplicación a pantalla completa. Para ocultarlo en
  ese caso, cámbialo a `true` en `extension.js`.
- Se reposiciona en `monitors-changed` y `workareas-changed`, en el monitor principal.
- En la pantalla de bloqueo GNOME desactiva la extensión (no declara `session-modes`), así que el
  temporizador se detiene.

### Métricas

| Indicador | Fuente | Cálculo |
|---|---|---|
| CPU | `/proc/stat`, línea `cpu` | `1 − Δ(idle+iowait) / Δ(user+nice+system+idle+iowait+irq+softirq+steal)` entre dos muestras. `guest`/`guest_nice` no se suman porque ya están incluidos en `user`/`nice`. |
| RAM | `/proc/meminfo` | `(MemTotal − MemAvailable) / MemTotal` |
| SWAP | `/proc/meminfo` | `(SwapTotal − SwapFree) / SwapTotal`; si `SwapTotal = 0` muestra 0 %. |
| DISK | `/sys/block/<disco>/stat` | `Δio_ticks (ms) / Δtiempo (ms)` con reloj monotónico. Si hay varios discos, muestra **el más ocupado**. MB/s = Δ(sectores leídos + escritos) × 512 / Δtiempo, sumando todos los discos físicos. |
| TEMP | `/sys/class/hwmon` | Intel `coretemp` "Package id 0", AMD `k10temp`/`zenpower` "Tctl"/"Tdie", ARM `cpu_thermal`; si no hay ninguno, la zona térmica `x86_pkg_temp`. El máximo es el `temp*_crit` del sensor (100 °C si no lo informa). Sin sensor, la fila se oculta. |
| DOCKER | cgroups v2 de cada contenedor | CPU: `Δusage_usec` de `cpu.stat` / Δtiempo / núcleos, o sea % de **toda la máquina**, igual que la fila CPU: un contenedor que ocupa un núcleo completo en una máquina de 16 muestra 6,3 % (`docker stats` mostraría 100 %). RAM: `memory.current − inactive_file`, la misma fórmula de `docker stats`. Nombres: `GET /containers/json` al socket de Docker. |
| Núcleos | `/proc/stat` | `% CPU × número de líneas cpuN`: cuántos núcleos estarían al 100 % para producir esa carga. |

**Docker.** Los contenedores se encuentran listando `/sys/fs/cgroup/system.slice/docker-<id>.scope`
(driver systemd, el de Ubuntu) o `/sys/fs/cgroup/docker/<id>` (driver cgroupfs). El uso se lee de ahí, sin pasar
por Docker. Los nombres sí se piden a Docker, por el socket `/var/run/docker.sock`, con una petición HTTP
asíncrona que no lanza procesos y que solo se hace cuando aparece un contenedor nuevo. Si tu usuario no está en el
grupo `docker`, se muestra el id corto en vez del nombre. No cubre Docker en modo *rootless* ni Podman.
Medido contra un contenedor que ocupa exactamente un núcleo: 99,98 % de un núcleo; RAM igual a `docker stats`.

**Selección de discos.** Se toman los dispositivos de `/sys/block` que tienen un enlace `device` (hardware
real: `nvme0n1`, `sda`, `vda`, `xvda`, `mmcblk0`…) y se excluyen `loop`, `ram`, `zram`, `dm-*`, `md*`, `nbd`,
`sr` y `fd`. Como en `/sys/block` solo aparecen discos completos (las particiones son subdirectorios), nunca se
cuenta una partición junto con su disco padre, ni un volumen LUKS/LVM junto con el disco que lo soporta. La
lista se arma al activar la extensión: un disco USB conectado después no se mide hasta reactivarla.

**Por qué `/sys/block/<disco>/stat` y no `/proc/diskstats`.** Son los mismos contadores del kernel
(`part_stat`), con el mismo orden de campos. `/proc/diskstats` trae una línea por cada `loop` de snap (en esta
máquina, más de 35) que habría que leer y descartar cada segundo; el archivo de `/sys` trae solo la línea del
disco.

**Limitaciones de DISK (% de tiempo ocupado).** `io_ticks` cuenta el tiempo en que hubo *al menos una* E/S en
curso, igual que la columna `%util` de `iostat`. En un HDD con una sola cola, 100 % significa saturado. En un SSD
NVMe o SATA, con decenas de operaciones en paralelo, 100 % solo dice que el disco nunca estuvo inactivo; puede
tener todavía mucha capacidad libre. Sirve para ver *si* hay actividad sostenida, no *cuánta* capacidad queda.
Tampoco tiene nada que ver con el espacio ocupado del disco.

**CPU y RAM según la herramienta.** `htop` calcula la CPU con los mismos contadores, pero cuenta `iowait` como
tiempo inactivo y lo muestra aparte, así que los valores coinciden. `free` y `htop` muestran "used" como
`total − free − buff/cache`, que puede diferir de `MemTotal − MemAvailable`: `MemAvailable` además descuenta la
caché que no se puede liberar (shmem/tmpfs) y suma la memoria recuperable del kernel. Se usa `MemAvailable`
porque es lo que pidió el proyecto y la estimación que recomienda el kernel.

### Consumo

- Un solo temporizador `GLib.timeout_add_seconds(1)`. Usa segundos enteros para que GLib agrupe este despertar
  con los de otros procesos. Los porcentajes se calculan con tiempos reales medidos, así que el pequeño
  desfase no afecta la exactitud.
- Tres lecturas de archivo por segundo (`/proc/stat`, `/proc/meminfo` y el `stat` de cada disco), más un
  listado de directorio y tres lecturas por contenedor Docker en ejecución. Son
  archivos virtuales del kernel: se leen sin esperar al disco. No se lanza ningún proceso externo.
- Los actores de la vista se crean al abrir el monitor y se destruyen al cerrarlo, nunca durante la
  actualización por segundo. En cada ciclo solo se modifican el texto y el ancho de la barra
  **cuando el entero mostrado cambió**; si no cambió, no hay relayout ni repintado.
- No guarda historiales: solo los contadores de la muestra anterior.
- `disable()` quita el temporizador, desconecta las dos señales, saca y destruye el actor y suelta las
  referencias.

## Licencia

GPL-2.0-or-later. Ver [LICENSE](LICENSE).
