// procesadorBoletin.js - Carga de boletines DINAPI (CSV), tolerante a fallos.
//
// Formas de usarlo:
//   - Automática (cron): node --env-file=.env src/procesadorBoletin.js --pagina
//                        lee la página de boletines de la DINAPI y carga los CSV/XLSX nuevos
//   - Manual:      node --env-file=.env src/procesadorBoletin.js --archivo ./boletin.csv
//   - Una URL:     node --env-file=.env src/procesadorBoletin.js --url https://.../boletin.csv
//   - Desde código: import { procesarBoletin } from './src/procesadorBoletin.js'
//                   await procesarBoletin(bufferOStream)
//
// Ninguna de estas funciones lanza errores hacia afuera: devuelven un resumen
// con ok: true/false, y todo lo que falla queda en logs/errores-AAAA-MM-DD.log.
import { createReadStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parse } from 'csv-parse';

import { enTransaccion, query, cerrarPool } from './db.js';
import { env, envNumero } from './config.js';
import { generarAlertasParaMarca } from './moduloAlertas.js';
import { registrarError } from './registro.js';
import { enviarAvisosPendientes } from './notificador.js';

export { registrarError };

// ---------------------------------------------------------------------
// Lectura de columnas: acepta varios nombres posibles por columna, sin
// importar mayúsculas, tildes ni espacios. Si la DINAPI cambia el
// encabezado, solo hay que agregar el nombre nuevo aquí.
//
// Formato real del "Boletín de Marcas Recibidas" (CSV, UTF-8, coma), visto en
// Boletines-Marcas-Recibidas-23-27-Febrero-2026-CSV.csv:
//   4 líneas de título ("BOLETIN DE INFORMACIONES AL ...", aviso legal) y luego
//   Fecha Solicitud,Expediente,Clase Niza,Denominación,Signo,Titular,País,
//   Agente,Matrícula,Trámite,Referencia
//   Signo: D (denominativa), M (mixta), F (figurativa, sin denominación).
//   Trámite: "Registro de Marca" o "Renovación de Marca" (Referencia = registro anterior).
// ---------------------------------------------------------------------
const ALIAS_COLUMNAS = {
  nro_expediente: ['nro_expediente', 'expediente', 'numero_expediente', 'nro_exp', 'n_expediente', 'nro_solicitud'],
  nombre_marca: ['nombre_marca', 'denominacion', 'marca', 'nombre'],
  clase_niza: ['clase_niza', 'clase', 'clase_internacional', 'clase_nro'],
  estado_tramite: ['estado_tramite', 'estado', 'situacion'],
  fecha_ingreso: ['fecha_solicitud', 'fecha_ingreso', 'fecha', 'fecha_presentacion'],
  tipo_signo: ['signo', 'tipo_signo', 'tipo'],
  titular: ['titular', 'solicitante'],
  pais_titular: ['pais', 'pais_titular'],
  agente: ['agente', 'apoderado'],
  matricula_agente: ['matricula', 'matricula_agente'],
  tipo_tramite: ['tramite', 'tipo_tramite'],
  referencia: ['referencia', 'registro_anterior'],
};

// Filas que se miran buscando el encabezado (el boletín trae títulos arriba).
const MAX_FILAS_ANTES_DEL_ENCABEZADO = 30;

const normalizarClave = (texto) =>
  String(texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

function crearMapeador(encabezados) {
  const normalizados = encabezados.map(normalizarClave);
  const indices = {};
  for (const [campo, alias] of Object.entries(ALIAS_COLUMNAS)) {
    // Respeta el orden de preferencia de los alias
    indices[campo] = alias.map((a) => normalizados.indexOf(a)).find((i) => i >= 0) ?? -1;
  }
  const faltan = ['nro_expediente', 'nombre_marca'].filter((c) => indices[c] === -1);
  if (faltan.length) {
    throw new Error(
      `El CSV no tiene las columnas obligatorias: ${faltan.join(', ')}. ` +
        `Encabezados recibidos: ${encabezados.join(' | ')}`
    );
  }
  return (registro) => {
    const valor = (campo) => (indices[campo] >= 0 ? registro[indices[campo]] : undefined);
    return {
      nro_expediente: limpiarTexto(valor('nro_expediente')),
      nombre_marca: limpiarTexto(valor('nombre_marca')),
      clase_niza: convertirClase(valor('clase_niza')),
      estado_tramite: limpiarTexto(valor('estado_tramite')),
      fecha_ingreso: convertirFecha(valor('fecha_ingreso')),
      tipo_signo: limpiarTexto(valor('tipo_signo')),
      titular: limpiarTexto(valor('titular')),
      pais_titular: limpiarTexto(valor('pais_titular')),
      agente: limpiarTexto(valor('agente')),
      matricula_agente: limpiarTexto(valor('matricula_agente')),
      tipo_tramite: limpiarTexto(valor('tipo_tramite')),
      referencia: limpiarTexto(valor('referencia')),
    };
  };
}

function limpiarTexto(valor) {
  if (valor == null) return null;
  const texto = String(valor).replace(/\s+/g, ' ').trim();
  return texto === '' ? null : texto;
}

function convertirClase(valor) {
  const texto = limpiarTexto(valor);
  if (!texto) return null;
  const numero = Number.parseInt(texto.replace(/\D/g, ''), 10);
  if (!Number.isInteger(numero) || numero < 1 || numero > 45) {
    throw new Error(`Clase de Niza inválida: "${texto}"`);
  }
  return numero;
}

// Acepta DD/MM/AAAA, DD-MM-AAAA y AAAA-MM-DD. Devuelve 'AAAA-MM-DD' o null.
function convertirFecha(valor) {
  const texto = limpiarTexto(valor);
  if (!texto) return null;
  let a, m, d;
  let partes = texto.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (partes) [, a, m, d] = partes;
  else if ((partes = texto.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/))) [, d, m, a] = partes;
  else throw new Error(`Fecha con formato desconocido: "${texto}"`);

  const fecha = new Date(Date.UTC(+a, +m - 1, +d));
  if (fecha.getUTCFullYear() !== +a || fecha.getUTCMonth() !== +m - 1 || fecha.getUTCDate() !== +d) {
    throw new Error(`Fecha inexistente: "${texto}"`);
  }
  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------
// Entrada: Buffer, string o Stream -> Stream de texto UTF-8
// ---------------------------------------------------------------------
function aStreamDeTexto(entrada, encoding) {
  let fuente;
  if (Buffer.isBuffer(entrada) || entrada instanceof Uint8Array || typeof entrada === 'string') {
    fuente = Readable.from([entrada]);
  } else if (entrada && typeof entrada.pipe === 'function') {
    fuente = entrada;
  } else {
    throw new Error('procesarBoletin espera un Buffer o un Stream legible');
  }
  if (typeof entrada === 'string' || /^utf-?8$/i.test(encoding)) return fuente;

  // Otras codificaciones (latin1 / windows-1252) se convierten a UTF-8.
  const decoder = new TextDecoder(encoding);
  const conversor = new Transform({
    transform(chunk, _enc, cb) {
      cb(null, decoder.decode(chunk, { stream: true }));
    },
    flush(cb) {
      cb(null, decoder.decode());
    },
  });
  fuente.on('error', (err) => conversor.destroy(err));
  return fuente.pipe(conversor);
}

// ---------------------------------------------------------------------
// Lectores: CSV (por streaming) y XLSX. Los dos entregan filas como arrays
// de texto, así el resto del procesador no distingue el formato.
// La DINAPI publica cada boletín en PDF, CSV y XLSX con las mismas columnas.
// ---------------------------------------------------------------------
function filasDeCsv(entrada, encoding) {
  const texto = aStreamDeTexto(entrada, encoding);
  const parser = texto.pipe(
    parse({
      bom: true,
      delimiter: [',', ';', '\t'],
      relax_quotes: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    })
  );
  // .pipe() no pasa los errores de lectura (archivo inexistente, corte de
  // red) al parser; se reenvían para que los capture el try/catch.
  texto.on('error', (err) => parser.destroy(err));
  return parser;
}

// Un .xlsx es un ZIP: empieza con los bytes "PK\x03\x04".
const esXlsx = (entrada) =>
  (Buffer.isBuffer(entrada) || entrada instanceof Uint8Array) &&
  entrada[0] === 0x50 && entrada[1] === 0x4b && entrada[2] === 0x03 && entrada[3] === 0x04;

// Excel guarda números y fechas con tipo; se pasan a texto como en el CSV.
function celdaATexto(valor) {
  if (valor == null) return '';
  if (valor instanceof Date) return valor.toISOString().slice(0, 10); // AAAA-MM-DD
  if (typeof valor === 'number') return String(valor);                // 2678835, 37
  if (typeof valor === 'object') {
    if ('result' in valor) return celdaATexto(valor.result);          // fórmula
    if (Array.isArray(valor.richText)) return valor.richText.map((t) => t.text).join('');
    if ('text' in valor) return String(valor.text);                   // hipervínculo
    if ('error' in valor) return '';
  }
  return String(valor);
}

async function filasDeXlsx(entrada) {
  let buffer = entrada;
  if (!Buffer.isBuffer(buffer)) {
    const partes = [];
    for await (const parte of entrada) partes.push(parte);
    buffer = Buffer.concat(partes);
  }
  const { default: ExcelJS } = await import('exceljs');
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(buffer);
  const hoja = libro.worksheets[0];
  if (!hoja) throw new Error('El Excel no tiene hojas');

  const filas = [];
  hoja.eachRow({ includeEmpty: false }, (fila) => {
    // fila.values empieza en el índice 1
    const valores = Array.from({ length: Math.max(fila.cellCount, 1) }, (_, i) =>
      celdaATexto(fila.getCell(i + 1).value).trim()
    );
    if (valores.some((v) => v !== '')) filas.push(valores);
  });
  return filas;
}

// ---------------------------------------------------------------------
// Una fila: inserta la marca y genera sus alertas en UNA transacción.
// Si el motor falla, la marca tampoco queda guardada, así al reprocesar
// el boletín se vuelve a intentar y no se pierde ninguna alerta.
// ---------------------------------------------------------------------
const SQL_INSERTAR_MARCA = `
  INSERT INTO marcas_dinapi (nro_expediente, nombre_marca, clase_niza, estado_tramite, fecha_ingreso,
                             tipo_signo, titular, pais_titular, agente, matricula_agente,
                             tipo_tramite, referencia, origen)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  ON CONFLICT (nro_expediente) DO NOTHING
  RETURNING id, nro_expediente, nombre_marca, clase_niza, tipo_tramite`;

// Las renovaciones son marcas que ya existían: no generan alertas nuevas.
// Las marcas figurativas (sin denominación) no tienen texto que comparar.
const generaAlertas = (marca) =>
  Boolean(marca.nombre_marca) && !/renovaci/i.test(marca.tipo_tramite ?? '');

// Errores que afectan a todo el archivo, no a una fila puntual
// (base caída, sin permisos, tabla inexistente, etc.).
function esErrorDeConexion(err) {
  const codigo = String(err?.code ?? '');
  return (
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '42P01', '3D000'].includes(codigo) ||
    /^(08|28|53|57)/.test(codigo) ||
    /timeout|terminated|Connection terminated/i.test(err?.message ?? '')
  );
}

async function procesarFila(marca, opciones) {
  return enTransaccion(async (client) => {
    const { rows } = await client.query(SQL_INSERTAR_MARCA, [
      marca.nro_expediente,
      marca.nombre_marca,
      marca.clase_niza,
      marca.estado_tramite,
      marca.fecha_ingreso,
      marca.tipo_signo,
      marca.titular,
      marca.pais_titular,
      marca.agente,
      marca.matricula_agente,
      marca.tipo_tramite,
      marca.referencia,
      opciones.origen ?? null,
    ]);
    if (rows.length === 0) return { nueva: false, alertas: [] }; // duplicada
    // sinAlertas: carga del histórico, solo para tener la base de antecedentes
    if (opciones.sinAlertas || !generaAlertas(rows[0])) return { nueva: true, alertas: [], sinMotor: true, marca: rows[0] };
    const alertas = await generarAlertasParaMarca(rows[0], { client, umbral: opciones.umbral });
    return { nueva: true, alertas, marca: rows[0] };
  });
}

// ---------------------------------------------------------------------
// Función principal
// ---------------------------------------------------------------------
/**
 * Procesa un boletín de la DINAPI en CSV o XLSX (se detecta solo si es un Buffer).
 *
 * @param {Buffer|string|import('node:stream').Readable} entrada
 * @param {object} [opciones]
 * @param {string} [opciones.origen]     Nombre del archivo o URL (para los logs).
 * @param {string} [opciones.encoding]   CSV: 'utf-8' (defecto) o 'latin1'.
 * @param {string} [opciones.formato]    'auto' (defecto), 'csv' o 'xlsx'.
 * @param {number} [opciones.umbral]     Similitud mínima para el motor de alertas.
 * @param {(alerta: object, marca: object) => any} [opciones.alNotificar]
 *        Se llama por cada alerta nueva (ej: enviar email). Sus errores se registran
 *        pero no detienen el boletín.
 * @returns {Promise<object>} Resumen: { ok, leidas, nuevas, duplicadas, conError, alertas, ... }
 */
export async function procesarBoletin(entrada, opciones = {}) {
  const {
    origen = 'entrada en memoria',
    encoding = env('BOLETIN_ENCODING', 'utf-8'),
    formato = 'auto',
    alNotificar,
  } = opciones;

  const resumen = {
    ok: true,
    origen,
    inicio: new Date().toISOString(),
    leidas: 0,
    nuevas: 0,
    duplicadas: 0,
    sinComparar: 0, // renovaciones y figurativas: se guardan pero no se comparan
    conError: 0,
    alertas: 0,
  };

  try {
    const parser =
      formato === 'xlsx' || (formato === 'auto' && esXlsx(entrada))
        ? await filasDeXlsx(entrada)
        : filasDeCsv(entrada, encoding);

    let mapear = null;
    let linea = 0;
    let errorEncabezado = null;
    for await (const registro of parser) {
      linea++;
      if (!mapear) {
        // Busca la fila de encabezados (puede haber títulos antes)
        try {
          mapear = crearMapeador(registro);
        } catch (err) {
          errorEncabezado ??= err;
          if (linea >= MAX_FILAS_ANTES_DEL_ENCABEZADO) throw errorEncabezado;
        }
        continue;
      }
      if (registro.every((c) => !String(c).trim())) continue; // fila vacía
      resumen.leidas++;

      try {
        const marca = mapear(registro);
        if (!marca.nro_expediente) throw new Error('Fila sin nro_expediente');

        const resultado = await procesarFila(marca, opciones);
        if (!resultado.nueva) {
          resumen.duplicadas++;
          continue;
        }
        resumen.nuevas++;
        if (resultado.sinMotor) resumen.sinComparar++;
        resumen.alertas += resultado.alertas.length;

        if (alNotificar) {
          for (const alerta of resultado.alertas) {
            try {
              await alNotificar(alerta, resultado.marca);
            } catch (err) {
              await registrarError('Notificación', err, { origen, linea, alerta_id: alerta.alerta_id });
            }
          }
        }
      } catch (err) {
        // Si se cayó la base no tiene sentido seguir fila por fila:
        // se corta el archivo y se reintenta completo la próxima vez.
        if (esErrorDeConexion(err)) throw err;
        resumen.conError++;
        await registrarError('Fila', err, { origen, linea, fila: registro });
      }
    }

    if (!mapear) throw errorEncabezado ?? new Error('El CSV está vacío');
  } catch (err) {
    // Error del archivo completo (no se pudo leer, formato roto, base caída...)
    resumen.ok = false;
    resumen.error = err.message;
    await registrarError('Archivo', err, { origen });
  }

  resumen.fin = new Date().toISOString();
  console.log('[boletin] Resumen:', JSON.stringify(resumen));
  return resumen;
}

// ---------------------------------------------------------------------
// Fuentes de datos
// ---------------------------------------------------------------------

/** Modo manual: procesa un CSV descargado a mano. */
export async function procesarDesdeArchivo(ruta, opciones = {}) {
  try {
    const formato = /\.xlsx$/i.test(ruta) ? 'xlsx' : 'auto';
    return await procesarBoletin(createReadStream(ruta), { origen: ruta, formato, ...opciones });
  } catch (err) {
    await registrarError('Archivo', err, { origen: ruta });
    return { ok: false, origen: ruta, error: err.message };
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Descarga una URL completa a memoria. Si el portal está caído reintenta con
 * espera creciente (5s, 15s, 45s...). Un 404 u otro 4xx no se reintenta.
 * Lanza el último error si no lo logra.
 */
async function descargar(url, { intentos = 4, esperaInicialMs = 5_000, timeoutMs = 60_000 } = {}) {
  // Una URL mal escrita no se arregla reintentando
  try {
    new URL(url);
  } catch {
    throw new Error(`URL inválida: "${url ?? ''}"`);
  }
  for (let intento = 1; ; intento++) {
    try {
      const respuesta = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'alertas-marcas/1.0' },
      });
      if (!respuesta.ok) {
        const err = new Error(`El portal respondió HTTP ${respuesta.status}`);
        err.reintentable = respuesta.status >= 500 || respuesta.status === 429;
        throw err;
      }
      return Buffer.from(await respuesta.arrayBuffer());
    } catch (err) {
      const reintentable = err.reintentable !== false; // red caída, timeout, 5xx
      await registrarError('Descarga', err, { origen: url, intento, de: intentos });
      if (!reintentable || intento >= intentos) throw err;
      await esperar(esperaInicialMs * 3 ** (intento - 1));
    }
  }
}

/**
 * Modo automático con URL fija: descarga un CSV y lo procesa.
 * El archivo se baja completo antes de procesar, así un corte a mitad
 * de la descarga no deja un boletín cargado a medias.
 */
export async function procesarDesdeUrl(url, opciones = {}) {
  const { intentos, esperaInicialMs, timeoutMs, ...resto } = opciones;
  try {
    const buffer = await descargar(url, { intentos, esperaInicialMs, timeoutMs });
    return await procesarBoletin(buffer, { origen: url, ...resto });
  } catch (err) {
    return { ok: false, origen: url, error: err.message };
  }
}

// ---------------------------------------------------------------------
// Modo automático recomendado: leer la página de boletines de la DINAPI
// ---------------------------------------------------------------------
// La DINAPI publica cada semana el boletín en PDF y en CSV y/o XLSX (el más
// reciente, agosto 2026, vino solo en XLSX). Los nombres de archivo no siguen
// un patrón fijo (Boletin-/Boletines-, "-CSV.csv", ".CSV.csv", "-XLSX.xlsx"...),
// así que en vez de adivinar la URL se leen los enlaces .csv y .xlsx de la
// página, se agrupan por boletín (prefiriendo el CSV si están los dos) y se
// procesan los que todavía no se cargaron.
export const PAGINA_BOLETINES_DINAPI =
  'https://www.dinapi.gov.py/portal/v3/propiedad-industrial/marcas/boletines-de-marcas/';

const ES_BOLETIN_DE_MARCAS = /marcas[-_. ]*recibidas/i;

// Nombre del boletín sin formato: ".../Boletines-...-Agosto-2026-XLSX.xlsx"
// y ".../Boletines-...-Agosto-2026-CSV.csv" dan la misma clave.
function claveBoletin(url) {
  const archivo = decodeURIComponent(new URL(url).pathname.split('/').pop()).toLowerCase();
  return archivo
    .replace(/\.(csv|xlsx)$/, '')
    .replace(/[-_. ]*(csv|xlsx)$/, '')
    .replace(/[-_. ]+$/, '');
}

/**
 * Devuelve los boletines enlazados en una página HTML: un enlace por boletín,
 * el .csv si existe y si no el .xlsx. [{ clave, url, urls }]
 */
export function extraerEnlacesBoletines(html, urlBase) {
  const porClave = new Map();
  for (const [, href] of html.matchAll(/href\s*=\s*["']([^"']+\.(?:csv|xlsx))(?:[?#][^"']*)?["']/gi)) {
    let url;
    try {
      url = new URL(href.trim(), urlBase).href;
    } catch {
      continue; // enlace roto: se ignora
    }
    const clave = claveBoletin(url);
    const grupo = porClave.get(clave) ?? { clave, urls: [] };
    if (!grupo.urls.includes(url)) grupo.urls.push(url);
    porClave.set(clave, grupo);
  }
  return [...porClave.values()]
    // Solo "Marcas Recibidas": la página también publica "Documentos Recibidos"
    // (escritos sobre expedientes ya existentes), que no son solicitudes nuevas.
    .filter((g) => ES_BOLETIN_DE_MARCAS.test(g.clave))
    .map((g) => ({
    ...g,
    url: g.urls.find((u) => /\.csv$/i.test(u)) ?? g.urls[0],
  }));
}

/**
 * Lee la página de boletines y procesa los CSV nuevos.
 * Cada boletín procesado sin error queda anotado en la tabla
 * boletines_procesados; si falló, se reintenta en la próxima corrida.
 *
 * @param {string} [urlPagina]
 * @param {object} [opciones]
 * @param {number} [opciones.maximo=5]  Máximo de boletines nuevos por corrida
 *        (la primera vez evita bajar años de historia de golpe).
 */
export async function procesarNuevosDesdePagina(urlPagina = PAGINA_BOLETINES_DINAPI, opciones = {}) {
  const { maximo = 5, soloMarcar = false, ...resto } = opciones;
  const resultado = { ok: true, pagina: urlPagina, encontrados: 0, pendientes: 0, boletines: [] };
  try {
    const html = (await descargar(urlPagina, resto)).toString('utf8');
    const boletines = extraerEnlacesBoletines(html, urlPagina);
    resultado.encontrados = boletines.length;
    if (boletines.length === 0) {
      throw new Error('La página no tiene enlaces .csv ni .xlsx (¿cambió el sitio de la DINAPI?)');
    }

    // Un boletín cuenta como hecho si se cargó cualquiera de sus formatos
    const { rows } = await query(
      'SELECT url FROM boletines_procesados WHERE ok AND url = ANY($1::text[])',
      [boletines.flatMap((b) => b.urls)]
    );
    const yaHechos = new Set(rows.map((r) => r.url));
    const pendientes = boletines.filter((b) => !b.urls.some((u) => yaHechos.has(u)));
    resultado.pendientes = pendientes.length;

    // La página lista los boletines del más nuevo al más viejo, y se respeta
    // ese orden: lo más reciente se carga primero.
    for (const { url } of pendientes.slice(0, maximo)) {
      const resumen = soloMarcar
        ? { ok: true, origen: url, omitido: 'marcado como visto sin cargar' }
        : await procesarDesdeUrl(url, resto);
      resultado.boletines.push(resumen);
      if (!resumen.ok) resultado.ok = false;
      await query(
        `INSERT INTO boletines_procesados (url, ok, resumen) VALUES ($1, $2, $3)
         ON CONFLICT (url) DO UPDATE SET ok = EXCLUDED.ok, resumen = EXCLUDED.resumen, procesado_el = now()`,
        [url, resumen.ok, resumen]
      ).catch((err) => registrarError('Registro de boletín', err, { origen: url }));
    }
  } catch (err) {
    resultado.ok = false;
    resultado.error = err.message;
    await registrarError('Página de boletines', err, { origen: urlPagina });
  }
  console.log('[boletin] Página:', JSON.stringify({ ...resultado, boletines: resultado.boletines.length }));
  return resultado;
}

// ---------------------------------------------------------------------
// Uso por línea de comandos (manual o desde cron)
// ---------------------------------------------------------------------
const USO = `Uso:
  node --env-file=.env src/procesadorBoletin.js --pagina [URL]   (recomendado para cron)
      --historico       carga TODOS los boletines pendientes, sin generar alertas ni avisos
      --marcar-vistos   anota todos los pendientes como vistos, sin cargarlos
  node --env-file=.env src/procesadorBoletin.js --archivo ./boletin.csv
  node --env-file=.env src/procesadorBoletin.js --url https://.../boletin.csv   (o .xlsx)
Al terminar envía los avisos por email pendientes; agregar --sin-avisos para no enviarlos.`;

async function main() {
  const args = process.argv.slice(2);
  const banderas = new Set(args.filter((a) => a.startsWith('--')));
  const valor = args.find((a) => !a.startsWith('--')); // archivo o URL, en cualquier posición
  const opcion = ['--archivo', '--url', '--pagina'].find((b) => banderas.has(b)) ?? '--pagina';
  let resumen;

  if (opcion === '--archivo' && valor) {
    resumen = await procesarDesdeArchivo(valor);
  } else if (opcion === '--url' && valor) {
    resumen = await procesarDesdeUrl(valor);
  } else if (opcion === '--pagina') {
    const historico = banderas.has('--historico');
    const soloMarcar = banderas.has('--marcar-vistos');
    const maximo = historico || soloMarcar ? Infinity : envNumero('BOLETINES_MAXIMO_POR_CORRIDA', 5);
    resumen = await procesarNuevosDesdePagina(
      valor ?? env('BOLETINES_PAGINA_URL', PAGINA_BOLETINES_DINAPI),
      { maximo, soloMarcar, sinAlertas: historico }
    );
    if (historico || soloMarcar) banderas.add('--sin-avisos');
  } else {
    console.log(USO);
    process.exitCode = 2;
    return;
  }

  // Avisos por email de las alertas nuevas (y de las que hayan quedado
  // pendientes de una corrida anterior). Se saltea con --sin-avisos.
  let avisos = { ok: true };
  if (!banderas.has('--sin-avisos')) avisos = await enviarAvisosPendientes();

  // Código de salida útil para cron: 0 = todo bien, 1 = algo falló
  process.exitCode = resumen.ok && avisos.ok ? 0 : 1;
}

// Solo corre main() si se ejecuta directo (no al importarlo desde otro módulo)
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Último salvavidas: nada debe terminar el proceso con un error sin registrar
  process.on('unhandledRejection', (err) => registrarError('Promesa sin capturar', err));
  main()
    .catch((err) => registrarError('main', err).then(() => (process.exitCode = 1)))
    .finally(() => cerrarPool());
}
