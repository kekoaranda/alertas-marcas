// joaju.js - Consulta el buscador público de marcas de la DINAPI (Joaju).
//
// Joaju (https://joaju.dinapi.gov.py/marcas) consulta por detrás un servicio
// que no pide usuario y que trae, por cada marca, la fecha de solicitud, la
// de concesión, la de vencimiento, el número de registro y el estado. Sirve
// para dos cosas que los boletines no dan:
//   - Las solicitudes de las semanas cuyo boletín todavía no salió.
//   - El vencimiento real de las marcas concedidas (no el estimado).
//
// Uso (siempre empezar por --probar):
//   node --env-file=.env src/joaju.js --probar [expediente]
//   node --env-file=.env src/joaju.js --solicitudes 2026-09-01 2026-09-30 [--sin-avisos]
//   node --env-file=.env src/joaju.js --vencen 2026-10-01 2026-12-31
//   --maximo N   corta después de N consultas (por defecto JOAJU_MAXIMO_CONSULTAS o 200)
//
// Se consulta despacio (una consulta cada JOAJU_PAUSA_MS, 3 s por defecto)
// para no cargar el sitio de la DINAPI.
import { pathToFileURL } from 'node:url';

import { query, cerrarPool } from './db.js';
import { env, envNumero } from './config.js';
import { procesarFila } from './procesadorBoletin.js';
import { registrarError } from './registro.js';
import { enviarAvisosPendientes } from './notificador.js';

const URL_JOAJU = () => env('JOAJU_URL', 'https://joaju.dinapi.gov.py/api/api/markMarkGetList-json/');
const ORIGEN = 'joaju';

// ---------------------------------------------------------------------
// Pedido: el servicio espera todos los criterios, vacíos los que no se usan.
// Estructura tomada del cliente público github.com/marcosferr/marcacheck-py.
// ---------------------------------------------------------------------
const fechaVacia = () => ({ dateValue: '' });
const numeroVacio = () => ({ doubleValue: '' });

function criteriosVacios() {
  const extra = {};
  for (let i = 1; i <= 5; i++) {
    Object.assign(extra, {
      [`dataCodeId${i}`]: '', [`dataCodeTyp${i}`]: '', [`dataFlag${i}`]: '', [`dataText${i}`]: '',
      [`dataDate${i}From`]: fechaVacia(), [`dataDate${i}To`]: fechaVacia(), [`dataNbr${i}`]: numeroVacio(),
    });
  }
  return {
    criteriaExtraData: extra,
    criteriaFileId: {
      fileIdList: { fileNbr: numeroVacio(), fileSeq: '', fileSeries: numeroVacio(), fileType: '' },
      fileNbrFrom: numeroVacio(), fileNbrTo: numeroVacio(),
      fileSeq: '', fileSeries: numeroVacio(), fileType: '',
      madridInternationalRegNo: '', officeDocumentNbr: numeroVacio(), publicationNbr: numeroVacio(),
    },
    criteriaFilingData: {
      applicationSubtype: '', applicationType: '', externalOffice: '', externalSystemId: '',
      filingDateFrom: fechaVacia(), filingDateTo: fechaVacia(),
      indManualInterpretationRequired: '', isValidationPending: '',
      noveltyDateFrom: fechaVacia(), noveltyDateTo: fechaVacia(),
      receptionDateFrom: fechaVacia(), receptionDateTo: fechaVacia(),
    },
    criteriaMadridData: { docType: '', tranType: '' },
    criteriaOwnershipData: {
      individualIdNbr: '', individualIdType: '', legalIdNbr: '', legalIdType: '',
      nationalityCountryCode: '', ownerNameContainsWords: '',
      ownerNameInOtherLangContainsWords: '', personGroupNbr: '', residenceCountryCode: '', stateCode: '',
    },
    criteriaProtectionData: {
      criteriaNiceClassList: { niceClassEdition: numeroVacio(), niceClassNbr: numeroVacio() },
      indIgnoreNotRegisteredNiceClasses: '', indIncludeReclassifiedNiceClasses: '', indIncludeRelatedNiceClasses: '',
      searchClassList: { searchClassNbr: numeroVacio() },
    },
    criteriaReceipt: { receiptNbr: '' },
    criteriaRegistrationData: {
      entitlementDateFrom: fechaVacia(), entitlementDateTo: fechaVacia(),
      expirationDateFrom: fechaVacia(), expirationDateTo: fechaVacia(),
      registrationDateFrom: fechaVacia(), registrationDateTo: fechaVacia(),
      registrationDup: '', registrationNbrFrom: numeroVacio(), registrationNbrTo: numeroVacio(),
      registrationSeries: numeroVacio(), registrationType: '',
    },
    criteriaRepresentationData: {
      agentCode: numeroVacio(), indNoRepresentative: '', individualIdNbr: '', individualIdType: '',
      legalIdNbr: '', legalIdType: '', representativeNameContainsWords: '',
      representativeNameInOtherLangContainsWords: '', representativeType: '',
    },
    criteriaSignData: {
      markNameContainsWords: '', markNameEquals: '', markNameInOtherLangContainsWords: '', markNameSoundsLike: '',
      markTranslationContainsWords: '', markTranslationInOtherLangContainsWords: '',
      markTransliterationContainsWords: '', markTransliterationInOtherLangContainsWords: '', signType: '',
    },
    criteriaStatus: {
      expirationDateFrom: fechaVacia(), expirationDateIsDue: '', expirationDateTo: fechaVacia(),
      indApplyStatusSimilarityIgnore: '', indStatusInactive: '', indStatusPending: '', indStatusRegistered: '',
      processResultType: '', processType: '', statusCode: '', statusGroupCode: '', substatusCode: '',
    },
  };
}

// No se sabe todavía en qué formato espera las fechas: --probar prueba los
// tres y dice cuál poner en JOAJU_FORMATO_FECHA.
const FORMATOS_FECHA = {
  iso: (f) => f,                                    // 2026-09-01
  'iso-hora': (f) => `${f}T00:00:00`,               // 2026-09-01T00:00:00
  dmy: (f) => f.split('-').reverse().join('/'),     // 01/09/2026
};

function formatearFecha(fecha, formato = env('JOAJU_FORMATO_FECHA', 'iso')) {
  const f = FORMATOS_FECHA[formato];
  if (!f) throw new Error(`JOAJU_FORMATO_FECHA inválido: "${formato}" (iso, iso-hora o dmy)`);
  return f(fecha);
}

export const criterios = {
  solicitadas(desde, hasta, formato) {
    const c = criteriosVacios();
    c.criteriaFilingData.filingDateFrom.dateValue = formatearFecha(desde, formato);
    c.criteriaFilingData.filingDateTo.dateValue = formatearFecha(hasta, formato);
    return c;
  },
  vencen(desde, hasta, formato) {
    const c = criteriosVacios();
    c.criteriaRegistrationData.expirationDateFrom.dateValue = formatearFecha(desde, formato);
    c.criteriaRegistrationData.expirationDateTo.dateValue = formatearFecha(hasta, formato);
    return c;
  },
  // "completo": fileNbr = 2692764. "serie": fileSeries = 2026 y fileNbr = 92764.
  expediente(nro, variante = 'completo') {
    const c = criteriosVacios();
    const ids = c.criteriaFileId;
    if (variante === 'serie') {
      ids.fileSeries.doubleValue = `20${nro.slice(0, 2)}`;
      ids.fileNbrFrom.doubleValue = ids.fileNbrTo.doubleValue = String(Number(nro.slice(2)));
    } else {
      ids.fileNbrFrom.doubleValue = ids.fileNbrTo.doubleValue = nro;
    }
    return c;
  },
};

// ---------------------------------------------------------------------
// Consulta: una a la vez, con pausa, y reintentos si el sitio falla.
// ---------------------------------------------------------------------
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
let ultimaConsulta = 0;

/**
 * Devuelve { registros: [...] } o, si el servicio no lista porque hay
 * demasiados resultados (responde solo un número), { demasiados: n }.
 */
export async function consultar(arg0, { intentos = 3 } = {}) {
  for (let intento = 1; ; intento++) {
    const espera = ultimaConsulta + envNumero('JOAJU_PAUSA_MS', 3000) - Date.now();
    if (espera > 0) await esperar(espera);
    ultimaConsulta = Date.now();
    try {
      const respuesta = await fetch(URL_JOAJU(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'alertas-marcas/1.0' },
        body: JSON.stringify({ arg0 }),
        signal: AbortSignal.timeout(60_000),
      });
      const texto = await respuesta.text();
      if (!respuesta.ok) {
        const err = new Error(`Joaju respondió HTTP ${respuesta.status}: ${texto.slice(0, 200)}`);
        err.reintentable = respuesta.status >= 500 || respuesta.status === 429;
        throw err;
      }
      return interpretarRespuesta(texto);
    } catch (err) {
      if (err.reintentable === false || intento >= intentos) throw err;
      await registrarError('Joaju', err, { intento, de: intentos });
      await esperar(10_000 * intento);
    }
  }
}

export function interpretarRespuesta(texto) {
  let datos;
  try {
    datos = JSON.parse(texto);
  } catch {
    datos = texto;
  }
  if (typeof datos === 'number') return { demasiados: datos, registros: [] };
  if (typeof datos === 'string') {
    if (/^\s*\d+\s*$/.test(datos)) return { demasiados: Number(datos), registros: [] };
    if (datos.includes('<return>')) return { registros: leerXml(datos) };
    throw new Error(`Respuesta de Joaju que no se entiende: ${datos.slice(0, 200)}`);
  }
  if (!Array.isArray(datos)) throw new Error(`Respuesta de Joaju que no se entiende: ${texto.slice(0, 200)}`);
  // El primer elemento suele ser un resumen { total, criterios }
  return { registros: datos.filter((d) => d && typeof d === 'object' && !('criterios' in d && !('titulo' in d))) };
}

function leerXml(xml) {
  const tag = (bloque, ...rutas) => {
    for (const ruta of rutas) {
      const m = bloque.match(new RegExp(`<${ruta}>(?:<\\w+>)?([^<]*)`));
      if (m) return m[1].trim();
    }
    return '';
  };
  return (xml.match(/<return>[\s\S]*?<\/return>/g) ?? []).map((b) => ({
    titulo: tag(b, 'fileSummaryDescription'),
    titular: tag(b, 'fileSummaryOwner'),
    estado: tag(b, 'fileSummaryStatus'),
    clase: tag(b, 'fileSummaryClasses'),
    fileNbr: tag(b, 'fileNbr'),
    fileSeries: tag(b, 'fileSeries'),
    regNbr: tag(b, 'registrationNbr'),
    fecha: tag(b, 'filingDate'),
    regDate: tag(b, 'registrationDate'),
    vence: tag(b, 'expirationDate'),
    signo: tag(b, 'signType'),
    agent: tag(b, 'representativeName', 'fileSummaryRepresentative'),
  }));
}

// ---------------------------------------------------------------------
// De registro de Joaju a fila de marcas_dinapi
// ---------------------------------------------------------------------
const texto = (v) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
};

// Acepta 2026-09-01, 2026-09-01T03:00:00..., 01/09/2026 y milisegundos.
export function leerFecha(valor) {
  if (typeof valor === 'number' && valor > 0) return new Date(valor).toISOString().slice(0, 10);
  const t = texto(valor);
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

const enteroComoTexto = (v) => {
  const t = texto(v);
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? String(Math.trunc(n)) : t.replace(/\D/g, '') || null;
};

/**
 * Número de expediente con el formato del boletín: 7 dígitos, los 2 primeros
 * son el año (2692764 = 2026, nº 92764). Si Joaju lo da partido (serie 2026,
 * número 92764) se arma. Devuelve null si no queda con ese formato: mejor
 * saltear la marca que guardarla con otro número y que después se duplique.
 */
export function expedienteDe(item, fechaSolicitud) {
  const nro = enteroComoTexto(item.fileNbr ?? item.FILE_NBR ?? item.noSolicitud);
  if (!nro) return null;
  let exp = nro;
  if (nro.length < 7) {
    const serie = enteroComoTexto(item.fileSeries) ?? fechaSolicitud?.slice(0, 4);
    if (!serie) return null;
    exp = serie.slice(-2) + nro.padStart(5, '0');
  }
  if (!/^\d{7}$/.test(exp)) return null;
  if (fechaSolicitud && exp.slice(0, 2) !== fechaSolicitud.slice(2, 4)) return null;
  return exp;
}

const SIGNOS = { denominativa: 'D', mixta: 'M', figurativa: 'F', tridimensional: 'T' };
const TRAMITES = { REG: 'Registro de Marca', REN: 'Renovación de Marca' };

export function aMarca(item) {
  const fecha_ingreso = leerFecha(item.fecha);
  const clase = String(item.clase ?? '').match(/(\d{1,2})\s*$/) ?? String(item.clase ?? '').match(/\b(\d{1,2})\b/);
  const signo = texto(item.signo);
  const tramite = texto(item.typ);
  return {
    nro_expediente: expedienteDe(item, fecha_ingreso),
    nombre_marca: texto(item.titulo),
    clase_niza: clase && +clase[1] >= 1 && +clase[1] <= 45 ? +clase[1] : null,
    estado_tramite: texto(item.estado),
    fecha_ingreso,
    tipo_signo: signo ? (SIGNOS[signo.toLowerCase()] ?? signo) : null,
    titular: texto(item.titular),
    pais_titular: null,
    agente: texto(item.agent),
    matricula_agente: null,
    tipo_tramite: tramite ? (TRAMITES[tramite.toUpperCase()] ?? tramite) : null,
    referencia: null,
    nro_registro: enteroComoTexto(item.regNbr ?? item.noRegistro),
    fecha_concesion: leerFecha(item.regDate),
    fecha_vencimiento: leerFecha(item.vence),
  };
}

// ---------------------------------------------------------------------
// Guardar
// ---------------------------------------------------------------------
// Joaju da el nombre del agente pero no su matrícula: se toma la que ya
// figura para ese nombre en los boletines (hace falta para el acceso de agentes).
const matriculas = new Map();
async function matriculaDe(agente) {
  if (!agente) return null;
  const clave = agente.toUpperCase();
  if (!matriculas.has(clave)) {
    const { rows } = await query(
      `SELECT mode() WITHIN GROUP (ORDER BY matricula_agente) AS m
       FROM marcas_dinapi WHERE upper(agente) = $1 AND matricula_agente IS NOT NULL`,
      [clave]
    );
    matriculas.set(clave, rows[0]?.m ?? null);
  }
  return matriculas.get(clave);
}

const SQL_COMPLETAR = `
  UPDATE marcas_dinapi
     SET fecha_concesion   = COALESCE($2, fecha_concesion),
         fecha_vencimiento = COALESCE($3, fecha_vencimiento),
         nro_registro      = COALESCE($4, nro_registro),
         estado_tramite    = COALESCE($5, estado_tramite)
   WHERE nro_expediente = $1`;

async function guardar(item, resumen, opciones) {
  const marca = aMarca(item);
  if (!marca.nro_expediente) {
    resumen.sinExpediente++;
    if (resumen.sinExpediente <= 5) {
      await registrarError('Joaju', new Error('Expediente sin el formato del boletín, no se guarda'), { item });
    }
    return;
  }
  try {
    marca.matricula_agente = await matriculaDe(marca.agente);
    const r = await procesarFila(marca, { origen: ORIGEN, sinAlertas: opciones.sinAlertas });
    if (r.nueva) {
      resumen.nuevas++;
      resumen.alertas += r.alertas.length;
    } else {
      resumen.yaEstaban++;
    }
    const { rowCount } = await query(SQL_COMPLETAR, [
      marca.nro_expediente, marca.fecha_concesion, marca.fecha_vencimiento, marca.nro_registro, marca.estado_tramite,
    ]);
    if (rowCount && (marca.fecha_concesion || marca.fecha_vencimiento)) resumen.conVencimiento++;
  } catch (err) {
    resumen.conError++;
    await registrarError('Joaju', err, { nro_expediente: marca.nro_expediente });
  }
}

// ---------------------------------------------------------------------
// Recorrer un rango de fechas: tramos de 7 días; si un tramo trae
// demasiados resultados, se parte a la mitad hasta llegar a un día.
// ---------------------------------------------------------------------
const sumarDias = (f, n) => new Date(Date.parse(`${f}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const diasEntre = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export async function recorrer(tipo, desde, hasta, opciones = {}) {
  const { maximo = envNumero('JOAJU_MAXIMO_CONSULTAS', 200), sinAlertas = false } = opciones;
  const resumen = {
    ok: true, tipo, desde, hasta, consultas: 0, recibidas: 0, nuevas: 0, yaEstaban: 0,
    conVencimiento: 0, alertas: 0, sinExpediente: 0, conError: 0, diasSinListar: [],
  };
  const pendientes = [];
  for (let d = desde; d <= hasta; d = sumarDias(d, 7)) {
    const fin = sumarDias(d, 6);
    pendientes.push([d, fin < hasta ? fin : hasta]);
  }

  while (pendientes.length) {
    if (resumen.consultas >= maximo) {
      resumen.ok = false;
      resumen.cortado = `Se llegó al máximo de ${maximo} consultas; falta desde ${pendientes[0][0]}`;
      break;
    }
    const [a, b] = pendientes.shift();
    resumen.consultas++;
    let respuesta;
    try {
      respuesta = await consultar(criterios[tipo](a, b));
    } catch (err) {
      resumen.ok = false;
      resumen.error = `${a} a ${b}: ${err.message}`;
      await registrarError('Joaju', err, { tipo, desde: a, hasta: b });
      break; // el sitio no responde: se corta y se puede retomar desde esa fecha
    }
    if (respuesta.demasiados !== undefined) {
      const dias = diasEntre(a, b);
      if (dias === 0) {
        resumen.diasSinListar.push(`${a} (${respuesta.demasiados})`);
        continue;
      }
      const mitad = sumarDias(a, Math.floor(dias / 2));
      pendientes.unshift([a, mitad], [sumarDias(mitad, 1), b]);
      continue;
    }
    resumen.recibidas += respuesta.registros.length;
    for (const item of respuesta.registros) await guardar(item, resumen, { sinAlertas });
    console.log(`[joaju] ${a} a ${b}: ${respuesta.registros.length} marcas`);
  }
  if (resumen.diasSinListar.length) resumen.ok = false;
  console.log('[joaju] Resumen:', JSON.stringify(resumen));
  return resumen;
}

// ---------------------------------------------------------------------
// --probar: averigua cómo responde el servicio, sin guardar nada.
// ---------------------------------------------------------------------
async function probar(expediente) {
  const resumir = (r) =>
    r.demasiados !== undefined ? `demasiados para listar (${r.demasiados})` : `${r.registros.length} marcas`;
  const intentar = async (titulo, arg0) => {
    try {
      const r = await consultar(arg0, { intentos: 1 });
      console.log(`- ${titulo}: ${resumir(r)}`);
      return r;
    } catch (err) {
      console.log(`- ${titulo}: ERROR ${err.message}`);
      return null;
    }
  };

  const { rows } = await query('SELECT fecha_ingreso FROM marcas_dinapi WHERE nro_expediente = $1', [expediente]);
  const dia = rows[0]?.fecha_ingreso ?? '2026-10-01';

  console.log(`\n1) Buscar el expediente ${expediente}`);
  let encontrado = null;
  for (const variante of ['completo', 'serie']) {
    const r = await intentar(`número ${variante === 'completo' ? 'entero' : 'partido en año y número'}`, criterios.expediente(expediente, variante));
    if (r?.registros?.length && !encontrado) encontrado = { variante, item: r.registros[0] };
  }
  if (encontrado) {
    console.log('\nRespuesta tal cual vino (primera marca):');
    console.log(JSON.stringify(encontrado.item, null, 2));
    const marca = aMarca(encontrado.item);
    console.log('\nCómo se guardaría:');
    console.log(JSON.stringify(marca, null, 2));
    console.log(marca.nro_expediente === expediente
      ? `\nOK: el expediente coincide con el del boletín (${expediente}).`
      : `\nATENCIÓN: el expediente quedó "${marca.nro_expediente}" y no ${expediente}. No cargues nada todavía.`);
  }

  console.log(`\n2) Buscar las solicitudes del ${dia} con cada formato de fecha`);
  const funcionan = [];
  for (const formato of Object.keys(FORMATOS_FECHA)) {
    const r = await intentar(`formato ${formato} (${formatearFecha(dia, formato)})`, criterios.solicitadas(dia, dia, formato));
    if (r && (r.registros.length || r.demasiados)) funcionan.push(formato);
  }
  console.log(funcionan.length
    ? `\nPoné en el .env: JOAJU_FORMATO_FECHA=${funcionan[0]}`
    : '\nNingún formato de fecha trajo marcas: pasale esta salida a Claude.');
}

// ---------------------------------------------------------------------
// Línea de comandos
// ---------------------------------------------------------------------
const USO = `Uso (empezar siempre por --probar):
  node --env-file=.env src/joaju.js --probar [expediente]
  node --env-file=.env src/joaju.js --solicitudes AAAA-MM-DD AAAA-MM-DD [--sin-avisos]
  node --env-file=.env src/joaju.js --vencen AAAA-MM-DD AAAA-MM-DD
  --maximo N   corta después de N consultas`;

const ES_FECHA = /^\d{4}-\d{2}-\d{2}$/;

async function main() {
  const args = process.argv.slice(2);
  const banderas = new Set(args.filter((a) => a.startsWith('--')));
  const valores = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--maximo');
  const iMax = args.indexOf('--maximo');
  const maximo = iMax >= 0 ? Number(args[iMax + 1]) : undefined;

  if (banderas.has('--probar')) {
    await probar(valores[0] ?? '2692764');
    return;
  }
  const tipo = banderas.has('--solicitudes') ? 'solicitadas' : banderas.has('--vencen') ? 'vencen' : null;
  const [desde, hasta] = valores;
  if (!tipo || !ES_FECHA.test(desde ?? '') || !ES_FECHA.test(hasta ?? '') || desde > hasta) {
    console.log(USO);
    process.exitCode = 2;
    return;
  }
  // Las marcas que vencen son viejas: se guardan como antecedentes, sin alertas.
  const sinAlertas = tipo === 'vencen';
  const resumen = await recorrer(tipo, desde, hasta, { maximo, sinAlertas });
  let avisos = { ok: true };
  if (!sinAlertas && !banderas.has('--sin-avisos')) avisos = await enviarAvisosPendientes();
  process.exitCode = resumen.ok && avisos.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.on('unhandledRejection', (err) => registrarError('Promesa sin capturar', err));
  main()
    .catch((err) => registrarError('main', err).then(() => (process.exitCode = 1)))
    .finally(() => cerrarPool());
}
