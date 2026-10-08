# Alertas de Marcas DINAPI: guía paso a paso

Backend en Node.js (ES Modules) + PostgreSQL con SQL puro y el driver `pg`.
Recibe los boletines de la DINAPI en CSV, guarda las marcas nuevas y crea
alertas cuando una se parece a un término que vigila un usuario.

## Archivos del proyecto

```
alertas-marcas/
├── package.json            proyecto con "type": "module" y los comandos npm run ...
├── .env.example            plantilla de configuración (copiar como .env)
├── sql/
│   ├── schema.sql          extensión, funciones, tablas e índices (pgAdmin/DBeaver)
│   └── datos-demo.sql      2 usuarios y 5 términos de prueba
├── src/
│   ├── db.js               pool de conexiones a PostgreSQL
│   ├── moduloAlertas.js    motor de alertas
│   ├── procesadorBoletin.js  lee el CSV o Excel, guarda marcas y llama al motor
│   ├── notificador.js      avisos por email de las alertas nuevas
│   ├── servidor.js         página web + API (registro, ingreso, marcas, alertas)
│   ├── hacerAdmin.js       da o quita permiso de administrador (npm run admin)
│   ├── config.js           lee la configuración del .env
│   ├── registro.js         registro de errores en logs/
│   └── aplicarSql.js       ejecuta un .sql desde la terminal
├── public/                 la página que ve el cliente (index.html, app.js, estilos.css),
│                           app instalable: manifest.webmanifest, sw.js e iconos/
├── ejemplos/
│   ├── boletin-real-23-27-febrero-2026.csv  boletín real de la DINAPI (661 marcas)
│   ├── boletin-real-24-31-agosto-2026.xlsx  boletín real en Excel (724 marcas)
│   ├── boletin-ejemplo.csv mismo formato, datos inventados (un duplicado y 2 filas con error a propósito)
│   └── ejemplo-aviso-email.html/.png  cómo se ve el email de aviso
└── logs/                   se crea solo; acá quedan los errores
```

SQL y código separados: el SQL lo puede abrir y revisar cualquiera en pgAdmin sin tocar el código.

Requisitos: Node.js 20.6 o superior (usa `--env-file`, sin `dotenv`) y PostgreSQL 13 o superior.

---

## 1. Configuración inicial del proyecto

Si arrancás desde cero (en lugar de copiar esta carpeta):

```bash
mkdir alertas-marcas && cd alertas-marcas
npm init -y
npm pkg set type=module
npm install pg csv-parse exceljs nodemailer express bcryptjs
```

- `pg`: driver nativo de PostgreSQL.
- `csv-parse`: lee el CSV fila por fila respetando comillas y comas dentro de los nombres (ej: `"Ñandutí, S.A."`). Leer "a mano" separando por comas rompe esos casos.
- `exceljs`: lee los boletines en Excel (.xlsx).
- `nodemailer`: envía los avisos por email.
- `express`: servidor de la página web y la API.
- `bcryptjs`: guarda las contraseñas de los clientes cifradas (nunca en texto plano).

Si copiaste esta carpeta, alcanza con:

```bash
cd alertas-marcas
npm install
cp .env.example .env
```

Luego abrí `.env` y completá los datos de tu base (`PGHOST`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`).

### Crear la base (una sola vez)

En pgAdmin: clic derecho en *Login/Group Roles* > Create, nombre `alertas`, con permiso de login y una contraseña.
Después clic derecho en *Databases* > Create, nombre `alertas_marcas`, dueño `alertas`.

---

## 2. Script SQL de la base de datos

Abrí `sql/schema.sql` en el Query Tool de pgAdmin (o DBeaver) conectado a `alertas_marcas` y ejecutalo.
También se puede desde la terminal:

```bash
npm run db:schema
```

Se puede ejecutar todas las veces que quieras: no borra nada.

Qué crea:

- Extensión `pg_trgm` (similitud por trigramas).
- Función `normalizar_marca(texto)`: minúsculas, sin tildes, ñ como n. Así "Kurupí" y "KURUPI" cuentan como idénticas.
- Función `fonetica_es(texto)`: código fonético con reglas del español, en lugar de `metaphone()` de `fuzzystrmatch` (ver nota abajo). Por eso esa extensión no hace falta.
- Tablas:
  - `usuarios` (id UUID, email único, nombre, plan_pago FREE/PREMIUM)
  - `terminos_monitoreados` (id UUID, texto_buscar, clase_niza, usuario_id). Si `clase_niza` queda vacía, el término se vigila en las 45 clases.
  - `marcas_dinapi` (id UUID, nro_expediente único, nombre_marca, clase_niza, estado_tramite, fecha_ingreso). Además guarda lo que trae el boletín real: tipo de signo, titular, país, agente, matrícula, tipo de trámite y referencia.
  - `alertas` (id UUID, termino_id, marca_dinapi_id, revisada, creado_el). Agregué dos columnas útiles: `tipo_coincidencia` (IDENTICA, PARCIAL, ORTOGRAFICA, FONETICA) y `similitud` (0 a 1) para mostrar y ordenar. Además no permite dos alertas iguales para el mismo término y marca.
- Índices GIN con trigramas en `nombre_marca` y en `texto_buscar` (ver nota sobre GIN y GIST), e índices fonéticos.

Para cargar datos de prueba:

```bash
npm run db:demo
```

---

## 3. Conexión (db.js)

- Lee todo de variables de entorno; si falta alguna obligatoria avisa con un mensaje claro.
- `pool.on('error')` evita que un corte de PostgreSQL tumbe Node.js.
- Exporta `query()`, `enTransaccion()` y `cerrarPool()`.
- Las fechas (`DATE`) se devuelven como texto `AAAA-MM-DD` para evitar el clásico corrimiento de un día por zona horaria.

Uso:

```js
import { query } from './src/db.js';
const { rows } = await query('SELECT * FROM usuarios WHERE email = $1', [email]);
```

Siempre con `$1, $2...`: nunca pegar valores dentro del texto SQL (evita inyección SQL).

---

## 4. Motor de alertas (moduloAlertas.js)

```js
import { generarAlertasParaMarca } from './src/moduloAlertas.js';

const alertas = await generarAlertasParaMarca({ id, nombre_marca: 'Kurupy Premium', clase_niza: 30 });
// [{ alerta_id, tipo_coincidencia: 'ORTOGRAFICA', similitud: 0.556, texto_buscar: 'Kurupí', email, plan_pago, ... }]
```

Una sola consulta SQL que, para la marca nueva:

1. Toma los términos de la misma clase de Niza (o sin clase).
2. Evalúa cada criterio:
   - **Idéntica**: mismo texto normalizado.
   - **Parcial**: uno contiene al otro como palabras completas ("Tigo" en "TIGO MONEY"). Pedí ILIKE '%texto%', pero en el boletín real de agosto eso hacía saltar "Tigo" con "...QUE VA CONTIGO"; comparar por palabras completas evita esas alertas falsas. Solo con 3 letras o más.
   - **Ortográfica**: `similarity() > 0.4` (configurable con `UMBRAL_SIMILITUD`). Sumé `strict_word_similarity() > 0.5` (`UMBRAL_PALABRA`) porque `similarity()` sola no ve "Kurupí" dentro de "Kurupy Premium" (da 0.29).
   - **Fonética**: mismo código `fonetica_es()` ("Tigo" y "Tygo", "Pilsen" y "Pilcen").
3. Inserta en `alertas` con `ON CONFLICT DO NOTHING` (reprocesar no duplica).
4. Devuelve las alertas nuevas con email y plan del usuario, listas para enviar un aviso.

Extra: `buscarMarcasSimilares('texto', { clase })` hace la búsqueda al revés (un término contra todas las marcas ya cargadas). Sirve para mostrarle al usuario antecedentes cuando registra un término, y es la que aprovecha los índices de `marcas_dinapi`.

---

## 5. Procesador de boletines (procesadorBoletin.js)

### De dónde salen los datos

La DINAPI publica cada semana el "Boletín de Marcas Recibidas" en PDF y en CSV y/o Excel (el último publicado, del 24 al 31 de agosto de 2026, vino solo en Excel), en su [página de boletines de marcas](https://www.dinapi.gov.py/portal/v3/propiedad-industrial/marcas/boletines-de-marcas/). Hay CSV al menos desde 2021, por ejemplo [Boletines-Marcas-Recibidas-23-27-Febrero-2026-CSV.csv](https://www.dinapi.gov.py/portal/v3/assets/boletines/pdf-boletines/Boletines-Marcas-Recibidas-23-27-Febrero-2026-CSV.csv).
Los nombres de archivo no siguen un patrón fijo (Boletin- o Boletines-, terminados en `-CSV.csv`, `.CSV.csv`, `-csv.csv` o `-XLSX.xlsx`), por eso el modo automático lee los enlaces de la página en vez de armar la URL.

Formato real del CSV (revisado con el boletín del 23 al 27 de febrero de 2026, 661 marcas):

- UTF-8, separado por comas. Las primeras 4 líneas son títulos ("BOLETIN DE INFORMACIONES AL...", aviso legal); el procesador las salta solo y busca la fila de encabezados.
- Columnas: Fecha Solicitud, Expediente, Clase Niza, Denominación, Signo, Titular, País, Agente, Matrícula, Trámite, Referencia.
- Signo: D (denominativa), M (mixta) o F (figurativa, solo logo, viene sin denominación).
- Trámite: "Registro de Marca" (515 en ese boletín) o "Renovación de Marca" (146, con el registro anterior en Referencia).
- Algunos nombres terminan en "(SLOGAN)"; eso se ignora al comparar.

El mismo boletín se publica también en Excel (.xlsx) con las mismas columnas; el procesador acepta los dos formatos y lo detecta solo (revisado con el de 24 al 31 de agosto de 2026: mismo formato que febrero, 724 marcas).

Qué hace con cada tipo: todas las marcas se guardan, pero solo las solicitudes nuevas con denominación se comparan contra los términos. Las renovaciones son marcas que ya existían (avisar sería ruido) y las figurativas no tienen texto que comparar; el resumen las cuenta en `sinComparar`.

Hay otras dos fuentes que no usa este sistema: el buscador [Joaju](https://joaju.dinapi.gov.py/marcas) (consulta de expedientes uno por uno) y el dataset [Marcas registradas en Paraguay](https://www.datos.gov.py/dataset/marcas-registradas-en-paraguay) de datos.gov.py (marcas ya registradas, útil para cargar historia).

### Modo automático (recomendado, para cron)

```bash
npm run procesar:pagina
```

Lee la página de boletines, toma solo los de **Marcas Recibidas** (la página también publica "Documentos Recibidos", que son escritos sobre expedientes existentes y no solicitudes nuevas), los agrupa por boletín (si está en CSV y Excel usa el CSV) y carga los que todavía no se procesaron, del más nuevo al más viejo. Cada boletín cargado sin errores queda anotado en la tabla `boletines_procesados`; si uno falla (portal caído), se reintenta en la próxima corrida. Por corrida carga como máximo 5 boletines nuevos (`BOLETINES_MAXIMO_POR_CORRIDA`).

### Primera vez: el histórico

La página tiene boletines desde hace años (unos 500 archivos). Con 5 por día tardaría meses, así que la primera vez conviene una de estas dos opciones:

- **Cargar todo el histórico de una vez** (recomendado): `npm run procesar:historico`. Carga todos los boletines pendientes **sin generar alertas ni emails**, porque son solicitudes viejas; sirven como base de antecedentes para la búsqueda de marcas parecidas. Tarda un rato largo (unos 10 segundos por boletín), conviene correrlo dentro de `screen` o `tmux`.
- **No cargar el histórico**: `node --env-file=.env src/procesadorBoletin.js --pagina --marcar-vistos`. Anota todos los boletines como vistos sin bajarlos; desde ahí el cron solo carga los nuevos.

Cada marca guarda en la columna `origen` de qué boletín salió.

Para correrlo todos los días a las 6:00 con cron (Linux), `crontab -e` y agregá una línea:

```
0 6 * * * cd /ruta/a/alertas-marcas && /usr/bin/node --env-file=.env src/procesadorBoletin.js --pagina >> logs/cron.log 2>&1
```

Al terminar de cargar, el mismo comando envía los avisos por email (sección 6). Para cargar sin avisar, agregá `--sin-avisos`.

### Modo manual (archivo descargado a mano, CSV o Excel)

```bash
npm run procesar:archivo -- ./boletin-octubre.csv
npm run procesar:archivo -- ./boletin-octubre.xlsx
```

### Limpieza de "Documentos Recibidos" cargados por error

Las versiones anteriores al 07/10/2026 también cargaban los boletines de Documentos Recibidos. Si eso pasó, con un respaldo hecho antes, correr una vez:

```bash
npm run db:limpiar-documentos
```

Borra solo las filas que cargó cada boletín de documentos (las identifica por el momento exacto de su carga) y únicamente si la cantidad coincide con la que ese boletín cargó; si no coincide, no borra nada y lo avisa.

### Un CSV puntual por URL

```bash
npm run procesar:url -- https://www.dinapi.gov.py/.../Boletines-Marcas-Recibidas-...-CSV.csv
```

### Desde tu propio código (ej: un endpoint donde subís el archivo)

```js
import { procesarBoletin } from './src/procesadorBoletin.js';

const resumen = await procesarBoletin(bufferOStream, {
  origen: 'subido-por-admin.csv',
  alNotificar: async (alerta, marca) => { /* enviar email al usuario */ },
});
// { ok: true, leidas: 14, nuevas: 11, duplicadas: 1, conError: 2, alertas: 8, ... }
```

### Cómo resiste las fallas

- **Nunca lanza errores hacia afuera**: siempre devuelve un resumen con `ok: true/false`. El servidor sigue en pie.
- **Fila con error** (fecha inválida, clase fuera de 1-45, nombre vacío): se registra y se sigue con la próxima.
- **Base caída o archivo ilegible**: se corta ese boletín, se registra y devuelve `ok: false`. Volver a correrlo después es seguro: lo ya cargado se salta.
- **Portal caído (error 5xx, sin red, demora)**: reintenta 4 veces esperando 5 s, 15 s y 45 s. Un 404 no se reintenta.
- **Cada fila va en una transacción** (guardar marca + crear alertas). Si el motor falla, la marca tampoco queda guardada, así al reprocesar no se pierde ninguna alerta.
- **Duplicados**: `ON CONFLICT (nro_expediente) DO NOTHING`.
- **Formato flexible**: salta las líneas de título del boletín; separador `,` `;` o tabulación; encabezados con o sin tildes ("Expediente", "Denominación", "Clase Niza"...). Si la DINAPI usa otro nombre, se agrega en `ALIAS_COLUMNAS`. Para archivos en latin1 poné `BOLETIN_ENCODING=latin1`.
- **Logs**: cada error queda como una línea en `logs/errores-AAAA-MM-DD.log` (qué pasó, archivo, número de línea y la fila).
- **Código de salida** 0 o 1, útil para que cron o un monitor avisen.

---

## 6. Avisos por email (notificador.js)

Cada usuario recibe **un solo email** con todas sus alertas nuevas, no uno por alerta. Muestra su marca, la solicitud parecida con titular y país, clase, expediente, fecha y el tipo de coincidencia en palabras simples ("Idéntica", "Contiene tu marca", "Se escribe parecido", "Suena parecido"). Así se ve: [ejemplo-aviso-email.png](ejemplos/ejemplo-aviso-email.png).

```bash
npm run avisos
```

También se ejecuta solo al final de cada carga de boletines.

- **Modo prueba** (`AVISOS_MODO=prueba`, el valor inicial): no envía nada, guarda cada email como `.html` en `logs/avisos/` para abrirlo en el navegador.
- **Envío real con Brevo** (`AVISOS_MODO=brevo`, elegido): usa la API web de Brevo por HTTPS, así funciona aunque el servidor bloquee los puertos de correo (Hetzner, por ejemplo). Pasos abajo.
- **Otro proveedor**: `AVISOS_MODO=smtp` y los datos del servidor de correo en `.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`).

### Conectar Brevo (una sola vez)

1. Entrá a [brevo.com](https://www.brevo.com), creá una cuenta gratis y confirmá tu email.
2. Verificá el remitente: menú **Senders, Domains & Dedicated IPs** > **Senders** > **Add a sender**. Poné el nombre ("Alertas de Marcas") y el correo desde el que van a salir los avisos; Brevo manda un código a ese correo para confirmarlo.
3. Creá la clave de API: arriba a la derecha, tu nombre > **SMTP & API** > pestaña **API Keys** > **Generate a new API key**, nombre `alertas-marcas`. Copiala: empieza con `xkeysib-` y Brevo la muestra una sola vez.
4. En la computadora o servidor donde corre el sistema, abrí el `.env` (`nano .env`) y completá:
   ```
   AVISOS_MODO=brevo
   AVISOS_REMITENTE="Alertas de Marcas <el-correo-que-verificaste>"
   BREVO_API_KEY=la-clave-que-copiaste
   ```
   La clave va solo en el `.env`: nunca en el código, en GitHub ni en mensajes.
5. Probá con un email a tu propio correo:
   ```bash
   npm run avisos:probar -- tu@correo.com
   ```
   Si dice "Email de prueba enviado", ya está. Si no, el mensaje dice qué falta (por ejemplo, clave incorrecta o remitente sin verificar).
6. Más adelante, para que no caigan en spam: en **Senders, Domains & Dedicated IPs** > **Domains**, autenticá tu dominio; Brevo te da 2 o 3 registros para agregar en el DNS.

El plan gratis permite 300 emails por día. Como cada usuario recibe un solo email por boletín, alcanza para unos 300 usuarios.
- **Sin repetidos ni perdidos**: cada alerta enviada queda marcada (`alertas.notificada_el`). Si el servidor de correo falla o rechaza un destinatario, esas alertas quedan pendientes y salen en la próxima corrida; los demás usuarios reciben el suyo igual.
- Un usuario con `recibir_avisos = false` no recibe emails, y las alertas marcadas como revisadas no se envían.

## 7. Página web para clientes (servidor.js)

Cada cliente crea su cuenta con email y contraseña, carga las marcas que quiere
vigilar (nombre + clase de Niza, o "todas las clases") y ve sus alertas.

```bash
npm run db:schema   # agrega lo nuevo a la base (no borra nada)
npm start           # abre la página en http://127.0.0.1:3100
```

En el `.env`: `PORT` (3100), `HOST` (127.0.0.1: solo se ve desde el propio
servidor; para publicarla se pone delante un túnel de Cloudflare o nginx),
`TRUST_PROXY=true` cuando hay un túnel o nginx delante, y `PLAN_FREE_MAXIMO` (3).

### Planes
- **FREE**: hasta 3 marcas (cambiable con `PLAN_FREE_MAXIMO`).
- **PREMIUM**: sin límite.

El plan se cambia desde la sección **Administración** de la página (ver abajo).

### Qué hay en la página
- Ingresar / Crear cuenta.
- **Mis marcas vigiladas**: agregar, quitar y "Ver parecidas ya registradas" (busca en todas las marcas cargadas de la DINAPI).
- **Alertas**: las coincidencias de los boletines nuevos; se marcan como revisadas.
- **Mi cuenta**: activar o desactivar avisos por email y cambiar la contraseña.

### Administración
Las cuentas con permiso de administrador ven arriba de todo la sección
**Administración** (los clientes no la ven, y la API se lo niega igual):

- Totales: clientes, FREE / PREMIUM, inhabilitados, marcas vigiladas, alertas y marcas de la DINAPI cargadas.
- Lista de clientes con buscador (nombre, email, plan, marcas, alertas, fecha de alta).
- Botones por cliente: **Pasar a PREMIUM / FREE**, **Inhabilitar / Reactivar** y **Borrar** (pide confirmación).

**Inhabilitar** no borra nada: el cliente no puede entrar (se cierran sus
sesiones), no se le generan alertas nuevas ni recibe avisos. Al reactivarlo
vuelve como estaba. **Borrar** elimina la cuenta con sus marcas y alertas, y
no se puede deshacer. Un administrador no puede inhabilitarse ni borrarse a sí mismo.

Dar permiso de administrador (la cuenta tiene que estar registrada en la página):

```bash
npm run admin -- kekoaranda@gmail.com
npm run admin -- otra@persona.com --quitar     # para quitarlo
```

### App instalable (PWA) en PC y celular
Es una sola página que se adapta a la pantalla y se puede instalar como app:
- **PC y Android (Chrome o Edge)**: aparece el botón "Instalar app" arriba (o el ícono de instalar en la barra de direcciones).
- **iPhone (Safari)**: Compartir > "Agregar a inicio".

Necesita HTTPS (el túnel de Cloudflare ya lo da). Si se corta internet, la app abre igual y avisa "Sin conexión"; al volver, se actualiza sola. Las alertas nunca se guardan en el teléfono: siempre se piden al servidor.

Al cambiar archivos de `public/`, subir el número de `VERSION` en `public/sw.js` para que los celulares tomen la versión nueva.

### API (todo en JSON)
| Ruta | Qué hace |
|---|---|
| `POST /api/registro` | crea la cuenta (nombre, email, password) y deja la sesión abierta |
| `POST /api/ingreso` / `POST /api/salir` | iniciar y cerrar sesión |
| `GET` / `PATCH /api/yo` | datos de la cuenta, plan y uso; activar o desactivar avisos |
| `POST /api/cambiar-password` | cambia la contraseña y cierra las otras sesiones |
| `GET` / `POST /api/terminos` | listar y agregar marcas vigiladas (respeta el límite del plan) |
| `DELETE /api/terminos/:id` | quitar una marca (y sus alertas) |
| `GET /api/terminos/:id/similares` | marcas parecidas ya presentadas |
| `GET /api/alertas?estado=pendientes\|todas` | alertas del cliente |
| `PATCH /api/alertas/:id` | marcar revisada o pendiente |
| `GET /api/admin/resumen` | totales (solo administradores) |
| `GET /api/admin/usuarios?buscar=` | lista de clientes (solo administradores) |
| `PATCH /api/admin/usuarios/:id` | cambiar `plan` o `habilitado` (solo administradores) |
| `DELETE /api/admin/usuarios/:id` | borrar una cuenta (solo administradores) |
| `GET /api/salud` | responde `{"ok":true}` |

### Seguridad
- Contraseñas con bcrypt; la sesión es una cookie `httpOnly` y en la base solo se guarda un hash del token (tabla `sesiones`, 30 días).
- Máximo 10 intentos de ingreso cada 15 minutos por IP y email.
- Cada cliente solo ve y toca sus propias marcas y alertas.
- La página no usa `innerHTML`: un nombre de marca raro no puede inyectar código.

### Pendiente
- Recuperar contraseña por email y verificar el email al registrarse.
- Pago del plan PREMIUM desde la página.

## Prueba realizada

### Con el boletín real (23 al 27 de febrero de 2026)

661 marcas cargadas en 1,5 segundos, ninguna con error. 148 sin comparar (146 renovaciones y 10 figurativas, algunas son ambas). Con términos de prueba elegidos a propósito saltaron exactamente las 11 alertas esperadas y ninguna falsa:

| Término vigilado | Marca del boletín | Resultado |
|---|---|---|
| Destructor (5) | DESTRUCTOR | IDENTICA |
| Chanel (todas) | CHANEL GRAND PARFUMEUR (clases 3, 16, 35 y 44) | PARCIAL, 4 alertas |
| Doña Rosa (35) | MINIMARKET DOÑA ROSA | PARCIAL |
| Durmax (1) | DURAMAX | ORTOGRAFICA 0.50 |
| Skynative (3) | SKINATIVE PROBIOTICS | ORTOGRAFICA 0.54 |
| Mozana (41) | MOSANA | FONETICA |
| Bespa (1) | VESPA | FONETICA |
| Kalm (20) | calm | FONETICA |

Procesarlo de nuevo: 661 duplicadas, 0 alertas repetidas.

Boletín de agosto en Excel: 724 marcas en 2 segundos, sin errores, 105 sin comparar. Ahí apareció la alerta falsa "Tigo" contra "...CONTIGO", que llevó a comparar por palabras completas.

### Avisos por email

Probado en modo prueba y contra un servidor de correo de prueba: 2 emails (uno por usuario) con las 11 alertas de febrero; una segunda corrida no reenvía nada. Con el servidor de correo apagado, y con un destinatario rechazado, las alertas de ese usuario quedaron pendientes y el otro usuario recibió el suyo.

### Con el archivo de ejemplo inventado

| Término vigilado | Marca del boletín | Resultado |
|---|---|---|
| Pilsen (clase 32) | PILSEN (32) | IDENTICA |
| Pilsen (clase 32) | Pilcen (32) | FONETICA |
| Pilsen (clase 32) | Pilsen (clase 9) | sin alerta, otra clase |
| Kurupí (30) | KURUPI (30) | IDENTICA |
| Kurupí (30) | Kurupy Premium (30) | ORTOGRAFICA 0.56 |
| Tigo (todas) | TIGO MONEY | PARCIAL |
| Tigo (todas) | Tygo | FONETICA |
| Mburucuyá (43) | Mburucuya Café | PARCIAL |
| Chipa Barrero (30) | Chipa Barreiro | ORTOGRAFICA 0.71 |

Segunda corrida del mismo archivo: 0 nuevas, 12 duplicadas, 0 alertas repetidas. Las 2 filas rotas quedaron en el log.
También probado: CSV en latin1 con comas dentro de comillas, portal que falla 2 veces y luego responde, error 404, base apagada y archivo inexistente; en ningún caso se cayó el proceso.

Volumen: con 300.000 marcas y 20.000 términos, `buscarMarcasSimilares` tarda entre 6 y 30 ms usando los índices, y un boletín de 2.000 marcas se procesa en unos 30 segundos.

---

## Notas de diseño (cambios respecto del pedido original)

- **Fonética en español en vez de metaphone.** `metaphone()` sigue reglas del inglés: "Vaca" y "Baca" o "Llave" y "Yave" le dan distintas, y como descarta las vocales, "Pala", "Pelo" y "Polo" le dan iguales (alertas falsas). `fonetica_es()` aplica las del español y algo de Guaraní: b=v, s=z=c(e,i), k=c=qu, y=ll, h muda, j=g(e,i), y como vocal (Tygo, Kurupy), letras dobles (rr=r) e ignora espacios (Pil Sen = Pilsen). Para nombres con otras reglas se agrega una línea en la función.
- **GIN en vez de GIST.** GIN busca más rápido, sobre todo con ILIKE, y ocupa algo más al insertar. Los boletines se cargan una vez y se consultan muchas, así que conviene GIN. Si algún día se quiere volver a GIST: `USING GIST (... gist_trgm_ops)`.
- **Carpetas `sql/` y `src/`**, en vez de todo suelto, para separar lo que se ejecuta en pgAdmin del código.
- El motor compara cada marca nueva contra los términos de su clase recorriendo la tabla de términos: la condición "la marca contiene al término" no puede usar índice. Con decenas de miles de términos tarda unos 15 ms por marca, más que suficiente para boletines.
