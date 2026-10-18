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
//   node --env-file=.env src/joaju.js --expedientes 2681702 2692763 [--sin-avisos]
//       trae ese rango de expedientes: las nuevas pasan por el motor y a las
//       que ya estaban se les completan concesión, vencimiento y registro
//   node --env-file=.env src/joaju.js --completar
//       vuelve a consultar las marcas ya cargadas que no tienen vencimiento
//   node --env-file=.env src/joaju.js --solicitudes / --vencen AAAA-MM-DD AAAA-MM-DD
//       por fecha: solo si --probar encontró un formato de fecha que filtra
//   --maximo N   corta después de N consultas (por defecto JOAJU_MAXIMO_CONSULTAS o 200)
//   --hasta-terminar  sin tope de consultas; si el sitio se cae, espera
//       JOAJU_ESPERA_ERROR_MS (5 min, después 10, 15... hasta 30) y reintenta
//       hasta JOAJU_REINTENTOS_ERROR veces (24, unas 10 horas). Si se corta, volver a correr lo mismo: --completar sigue
//       donde quedó porque saltea lo ya consultado.
//   Si un solo día trae más marcas de las que Joaju lista, ese día se pide
//   junto con rangos de expedientes, partidos a la mitad hasta que listen.
//   --probar-dia AAAA-MM-DD comprueba que eso funcione, sin guardar nada.
//   Si Joaju falla siempre con un expediente puntual ("Multiple rows were
//   found..."), se parte el tramo hasta aislarlo, se saltea y queda en
//   conErrorJoaju del resumen; el resto sigue normal.
//
// Probado contra el servicio real (15/10/2026): la búsqueda por número de
// expediente funciona; la búsqueda por fecha no filtra con ningún formato
// probado (devuelve la base entera), por eso el camino es --expedientes.
//
// Se consulta despacio (una consulta cada JOAJU_PAUSA_MS, 3 s por defecto)
// para no cargar el sitio de la DINAPI.
import { pathToFileURL } from 'node:url';

import { query, cerrarPool } from './db.js';
import { env, envNumero } from './config.js';
import { procesarFila } from './procesadorBoletin.js';
import { registrarError } from './registro.js';
import { enviarAvisosPendientes } from './notificador.js';

// 7 dígitos, u 8 desde que un año pasó las 99.999 solicitudes (ver expedienteDe)
const ES_EXPEDIENTE = /^\d{7,8}$/;

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
  expedientes(desde, hasta) {
    const c = criteriosVacios();
    c.criteriaFileId.fileNbrFrom.doubleValue = String(desde);
    c.criteriaFileId.fileNbrTo.doubleValue = String(hasta);
    return c;
  },
  // Una fecha con demasiadas marcas se pide de a pedazos: fecha + rango de expedientes.
  diaYExpedientes(tipo, dia, desde, hasta, formato) {
    const c = criterios[tipo](dia, dia, formato);
    c.criteriaFileId.fileNbrFrom.doubleValue = String(desde);
    c.criteriaFileId.fileNbrTo.doubleValue = String(hasta);
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
const hora = () => new Date().toLocaleString('es-PY', { timeZone: 'America/Asuncion' });
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

// Joaju a veces falla con un error de su propia base para ciertos expedientes
// (p. ej. uno con registros duplicados del lado de la DINAPI). Ese tramo falla
// siempre igual, así que no es una caída del sitio: no sirve reintentar.
const ERROR_DE_DATOS = /Multiple rows were found|more than one row|query did not return a unique result/i;

function errorDeDatos(texto) {
  const err = new Error(`Joaju no puede devolver este tramo: ${texto.slice(0, 200)}`);
  err.reintentable = false;
  err.deDatos = true;
  return err;
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
    if (ERROR_DE_DATOS.test(datos)) throw errorDeDatos(datos);
    throw new Error(`Respuesta de Joaju que no se entiende: ${datos.slice(0, 200)}`);
  }
  if (!Array.isArray(datos)) {
    if (ERROR_DE_DATOS.test(texto)) throw errorDeDatos(texto);
    throw new Error(`Respuesta de Joaju que no se entiende: ${texto.slice(0, 200)}`);
  }
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
 * Número de expediente con el formato del boletín: los 2 primeros dígitos son
 * el año y el resto el número (2692764 = 2026, nº 92764). Son 7 dígitos, u 8
 * cuando el año pasó las 99.999 solicitudes (25113013 = 2025, nº 113013). Si
 * Joaju lo da partido (serie 2026, número 92764) se arma. Devuelve null si no queda con ese formato: mejor
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
  if (!ES_EXPEDIENTE.test(exp)) return null;
  if (fechaSolicitud && exp.slice(0, 2) !== fechaSolicitud.slice(2, 4)) return null;
  return exp;
}

const SIGNOS = { denominativa: 'D', mixta: 'M', figurativa: 'F', tridimensional: 'T' };
const TRAMITES = { REG: 'Registro de Marca', REN: 'Renovación de Marca' };

// "SUPERVALE VERDE LTDA. [BR]" -> ["SUPERVALE VERDE LTDA.", "BR"]
function separarPais(valor) {
  const t = texto(valor);
  const m = t?.match(/^(.*?)\s*\[([A-Z]{2})\]$/);
  return m ? [texto(m[1]), m[2]] : [t, null];
}

export function aMarca(item) {
  const fecha_ingreso = leerFecha(item.fecha);
  const [titular, pais_titular] = separarPais(item.titular);
  const [agente] = separarPais(item.agent);
  const clase = String(item.clase ?? '').match(/(\d{1,2})\s*$/) ?? String(item.clase ?? '').match(/\b(\d{1,2})\b/);
  const signo = texto(item.signo);
  const tramite = texto(item.typ);
  return {
    nro_expediente: expedienteDe({ fileSeries: item.FILE_SER, ...item }, fecha_ingreso),
    nombre_marca: texto(item.titulo),
    clase_niza: clase && +clase[1] >= 1 && +clase[1] <= 45 ? +clase[1] : null,
    estado_tramite: texto(item.estado),
    fecha_ingreso,
    tipo_signo: signo ? (SIGNOS[signo.toLowerCase()] ?? signo) : null,
    titular,
    pais_titular: texto(item.pais) ?? pais_titular,
    agente,
    matricula_agente: enteroComoTexto(item.agentNbr),
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
// Joaju trae la matrícula en agentNbr. Si falta, se toma la que ya figura
// para ese nombre en los boletines (hace falta para el acceso de agentes).
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
         estado_tramite    = COALESCE($5, estado_tramite),
         joaju_consultado_el = now()
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
    marca.matricula_agente ??= await matriculaDe(marca.agente);
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
// Recorrer tramos (de fechas o de números de expediente). Si un tramo trae
// demasiados resultados (el servicio responde solo la cantidad), se parte a
// la mitad hasta llegar a una fecha o a un número.
// ---------------------------------------------------------------------
const sumarDias = (f, n) => new Date(Date.parse(`${f}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const diasEntre = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

// Cómo se arma, se parte y se muestra cada tipo de tramo
const TRAMOS = {
  fechas: {
    tamano: 7,
    siguiente: (a, n) => sumarDias(a, n),
    largo: (a, b) => diasEntre(a, b),
  },
  numeros: {
    tamano: envNumero('JOAJU_TRAMO_EXPEDIENTES', 100),
    siguiente: (a, n) => a + n,
    largo: (a, b) => b - a,
  },
};

function partirEnTramos(desde, hasta, t) {
  const tramos = [];
  for (let a = desde; a <= hasta; a = t.siguiente(a, t.tamano)) {
    const fin = t.siguiente(a, t.tamano - 1);
    tramos.push([a, fin < hasta ? fin : hasta]);
  }
  return tramos;
}

function nuevoResumen(tipo, desde, hasta) {
  return {
    ok: true, tipo, desde, hasta, consultas: 0, recibidas: 0, nuevas: 0, yaEstaban: 0,
    conVencimiento: 0, alertas: 0, sinExpediente: 0, conError: 0, sinListar: [], conErrorJoaju: [],
  };
}

// Al terminar un tramo de expedientes, todas las marcas de la base dentro del
// tramo quedan como consultadas, también las que Joaju no devolvió: así
// --completar no las vuelve a pedir en cada vuelta.
const SQL_TRAMO_CONSULTADO = `
  UPDATE marcas_dinapi SET joaju_consultado_el = now()
   WHERE nro_expediente ~ '^[0-9]{7,8}$' AND nro_expediente::bigint BETWEEN $1 AND $2`;

async function recorrerTramos(tipo, tramos, unidad, resumen, opciones) {
  const { hastaTerminar = false, sinAlertas = false } = opciones;
  // --hasta-terminar no tiene tope de consultas y, si el sitio no responde,
  // espera y reintenta el mismo tramo en vez de cortar.
  const maximo = opciones.maximo ?? (hastaTerminar ? Infinity : envNumero('JOAJU_MAXIMO_CONSULTAS', 200));
  const esperaError = envNumero('JOAJU_ESPERA_ERROR_MS', 5 * 60_000);
  const reintentosError = hastaTerminar ? envNumero('JOAJU_REINTENTOS_ERROR', 24) : 0;
  const t = TRAMOS[unidad];
  const pendientes = [...tramos];
  const total = tramos.length;
  let fallosSeguidos = 0;
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
      if (err.deDatos) {
        // Se parte el tramo en mitades hasta aislar el expediente (o la fecha)
        // que hace fallar a Joaju; ese se anota y se saltea.
        fallosSeguidos = 0;
        const largo = t.largo(a, b);
        if (largo > 0) {
          const mitad = t.siguiente(a, Math.floor(largo / 2));
          pendientes.unshift([a, mitad], [t.siguiente(mitad, 1), b]);
          continue;
        }
        resumen.conErrorJoaju.push(String(a));
        console.log(`[joaju] ${hora()} ${a}: Joaju da error con este y se saltea (${err.message.slice(0, 120)})`);
        await registrarError('Joaju', err, { tipo, desde: a, hasta: b });
        if (tipo === 'expedientes') await query(SQL_TRAMO_CONSULTADO, [a, b]);
        continue;
      }
      if (fallosSeguidos < reintentosError) {
        fallosSeguidos++;
        // Espera cada vez más (5, 10, 15... hasta 30 min): con 24 reintentos
        // aguanta unas 10 horas de caída de la DINAPI.
        const espera = Math.min(esperaError * fallosSeguidos, 6 * esperaError);
        const motivo = err.message.split('\n')[0].slice(0, 80);
        console.log(`[joaju] ${hora()} El sitio no respondió (${motivo}); reintento ${fallosSeguidos}/${reintentosError} en ${Math.round(espera / 1000)} s`);
        pendientes.unshift([a, b]);
        await esperar(espera);
        continue;
      }
      resumen.ok = false;
      resumen.error = `${a} a ${b}: ${err.message}`;
      resumen.cortado = `El sitio no respondió; falta desde ${a}`;
      await registrarError('Joaju', err, { tipo, desde: a, hasta: b });
      break;
    }
    if (respuesta.demasiados !== undefined) {
      const largo = t.largo(a, b);
      if (largo === 0) {
        if (tipo === 'expedientes') resumen.sinListar.push(`${a} (${respuesta.demasiados})`);
        else await recorrerDiaPorExpedientes(tipo, a, respuesta.demasiados, resumen, { sinAlertas });
        continue;
      }
      const mitad = t.siguiente(a, Math.floor(largo / 2));
      pendientes.unshift([a, mitad], [t.siguiente(mitad, 1), b]);
      continue;
    }
    fallosSeguidos = 0;
    resumen.recibidas += respuesta.registros.length;
    for (const item of respuesta.registros) await guardar(item, resumen, { sinAlertas });
    if (tipo === 'expedientes') await query(SQL_TRAMO_CONSULTADO, [a, b]);
    console.log(`[joaju] ${a} a ${b}: ${respuesta.registros.length} marcas`);
    if (hastaTerminar && resumen.consultas % 50 === 0) {
      console.log(`[joaju] ${hora()} Avance: ${resumen.consultas} consultas, ${total - pendientes.length} de ${total} tramos, ` +
        `${resumen.nuevas} nuevas, ${resumen.conVencimiento} con vencimiento; falta desde ${pendientes[0]?.[0] ?? '-'}`);
    }
  }
  if (resumen.sinListar.length) resumen.ok = false;
  return resumen;
}

// Todos los expedientes posibles (7 u 8 dígitos)
const EXPEDIENTE_MIN = 0;
const EXPEDIENTE_MAX = 99_999_999;

/**
 * Un solo día con más marcas de las que Joaju lista (p. ej. 776 que vencen el
 * 2027-03-09): se pide ese día junto con un rango de expedientes, y el rango
 * se parte a la mitad hasta que cada pedazo se pueda listar.
 */
async function recorrerDiaPorExpedientes(tipo, dia, total, resumen, { sinAlertas }) {
  const pendientes = [[EXPEDIENTE_MIN, EXPEDIENTE_MAX]];
  let recibidas = 0;
  while (pendientes.length) {
    const [a, b] = pendientes.shift();
    resumen.consultas++;
    let respuesta;
    try {
      respuesta = await consultar(criterios.diaYExpedientes(tipo, dia, a, b));
    } catch (err) {
      if (err.deDatos && a < b) {
        const mitad = a + Math.floor((b - a) / 2);
        pendientes.unshift([a, mitad], [mitad + 1, b]);
        continue;
      }
      if (err.deDatos) {
        resumen.conErrorJoaju.push(`${dia} expediente ${a}`);
        await registrarError('Joaju', err, { tipo, dia, expediente: a });
        continue;
      }
      resumen.sinListar.push(`${dia} (${total}; error desde el expediente ${a}: ${err.message.slice(0, 80)})`);
      await registrarError('Joaju', err, { tipo, dia, desde: a, hasta: b });
      return;
    }
    if (respuesta.demasiados !== undefined) {
      // Si un pedazo cuenta más que el día entero, Joaju no está combinando la
      // fecha con el rango de expedientes: no tiene sentido seguir partiendo.
      if (respuesta.demasiados > total || a === b) {
        resumen.sinListar.push(`${dia} (${total}; no se pudo partir por expediente)`);
        return;
      }
      const mitad = a + Math.floor((b - a) / 2);
      pendientes.unshift([a, mitad], [mitad + 1, b]);
      continue;
    }
    recibidas += respuesta.registros.length;
    resumen.recibidas += respuesta.registros.length;
    for (const item of respuesta.registros) await guardar(item, resumen, { sinAlertas });
    if (respuesta.registros.length) {
      console.log(`[joaju] ${dia}, expedientes ${a} a ${b}: ${respuesta.registros.length} marcas`);
    }
  }
  console.log(`[joaju] ${dia}: ${recibidas} de ${total} marcas (partido por expediente)`);
  if (recibidas < total) resumen.sinListar.push(`${dia} (${total}; llegaron ${recibidas})`);
}

/** Por fecha de solicitud ('solicitadas') o de vencimiento ('vencen'). */
export async function recorrer(tipo, desde, hasta, opciones = {}) {
  const resumen = nuevoResumen(tipo, desde, hasta);
  await recorrerTramos(tipo, partirEnTramos(desde, hasta, TRAMOS.fechas), 'fechas', resumen, opciones);
  console.log('[joaju] Resumen:', JSON.stringify(resumen));
  return resumen;
}

/** Un rango de números de expediente (ej: 2681702 a 2692763). */
export async function recorrerExpedientes(desde, hasta, opciones = {}) {
  const resumen = nuevoResumen('expedientes', desde, hasta);
  await recorrerTramos('expedientes', partirEnTramos(desde, hasta, TRAMOS.numeros), 'numeros', resumen, opciones);
  console.log('[joaju] Resumen:', JSON.stringify(resumen));
  return resumen;
}

/**
 * Vuelve a consultar las marcas ya cargadas que no tienen vencimiento y no se
 * consultaron en los últimos JOAJU_DIAS_ENTRE_CONSULTAS días (30). Agrupa
 * expedientes cercanos en un mismo tramo para hacer pocas consultas.
 */
export async function completarVencimientos(opciones = {}) {
  const { rows } = await query(
    `SELECT nro_expediente::bigint AS n FROM marcas_dinapi
      WHERE fecha_vencimiento IS NULL AND nro_expediente ~ '^[0-9]{7,8}$'
        AND (joaju_consultado_el IS NULL OR joaju_consultado_el < now() - make_interval(days => $1))
      ORDER BY 1`,
    [envNumero('JOAJU_DIAS_ENTRE_CONSULTAS', 30)]
  );
  const tamano = TRAMOS.numeros.tamano;
  const tramos = [];
  for (const { n } of rows) {
    const num = Number(n);
    const ultimo = tramos.at(-1);
    if (ultimo && num - ultimo[0] < tamano) ultimo[1] = num;
    else tramos.push([num, num]);
  }
  const resumen = nuevoResumen('completar', rows[0]?.n ?? null, rows.at(-1)?.n ?? null);
  resumen.pendientes = rows.length;
  // Son marcas ya cargadas: no generan alertas nuevas
  await recorrerTramos('expedientes', tramos, 'numeros', resumen, { ...opciones, sinAlertas: true });
  console.log('[joaju] Resumen:', JSON.stringify(resumen));
  return resumen;
}

// ---------------------------------------------------------------------
// --probar: averigua cómo responde el servicio, sin guardar nada.
// ---------------------------------------------------------------------
// Una sola fecha no puede traer tantas marcas: si pasa, el filtro se ignoró
// y el servicio está contando la base entera.
const MAXIMO_CREIBLE_POR_DIA = 5000;

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
  const sinLogo = ({ logo, ...resto }) => (logo ? { ...resto, logo: `(imagen, ${String(logo).length} caracteres)` } : resto);

  const { rows } = await query('SELECT fecha_ingreso FROM marcas_dinapi WHERE nro_expediente = $1', [expediente]);
  const dia = rows[0]?.fecha_ingreso ?? '2026-10-01';

  console.log(`\n1) Buscar el expediente ${expediente}`);
  const r1 = await intentar('número entero', criterios.expediente(expediente));
  const item = r1?.registros?.[0];
  if (item) {
    console.log('\nRespuesta tal cual vino:');
    console.log(JSON.stringify(sinLogo(item), null, 2));
    const marca = aMarca(item);
    console.log('\nCómo se guardaría:');
    console.log(JSON.stringify(marca, null, 2));
    console.log(marca.nro_expediente === expediente
      ? `\nOK: el expediente coincide con el del boletín (${expediente}).`
      : `\nATENCIÓN: el expediente quedó "${marca.nro_expediente}" y no ${expediente}. No cargues nada todavía.`);
  }

  const n = Number(expediente);
  console.log(`\n2) Buscar un rango de 50 expedientes (${n} a ${n + 49})`);
  const r2 = await intentar('rango de expedientes', criterios.expedientes(n, n + 49));
  if (r2?.registros?.length) {
    const exps = r2.registros.map((i) => aMarca(i).nro_expediente).filter(Boolean);
    const fuera = exps.filter((e) => +e < n || +e > n + 49).length;
    console.log(fuera
      ? `ATENCIÓN: ${fuera} expedientes fuera del rango pedido. No uses --expedientes todavía.`
      : `OK: los ${exps.length} expedientes están dentro del rango. Se puede usar --expedientes.`);
  }

  console.log(`\n3) Buscar por fecha (${dia}) con cada formato`);
  const sirven = [];
  for (const formato of Object.keys(FORMATOS_FECHA)) {
    for (const tipo of ['solicitadas', 'vencen']) {
      const r = await intentar(`${tipo === 'vencen' ? 'vencimiento' : 'solicitud'}, formato ${formato}`, criterios[tipo](dia, dia, formato));
      if (!r) continue;
      if (r.demasiados > MAXIMO_CREIBLE_POR_DIA) console.log('  (no filtra: cuenta la base entera)');
      else if (r.registros.length || r.demasiados) sirven.push(`${tipo} con ${formato}`);
    }
  }
  console.log(sirven.length
    ? `\nLa búsqueda por fecha funciona: ${sirven.join(', ')}. Pasale esta salida a Claude.`
    : '\nLa búsqueda por fecha no funciona: usá --expedientes y --completar.');
}

// --probar-dia: un día con demasiadas marcas, ¿se puede partir por expediente?
// No guarda nada.
async function probarDia(dia, tipo = 'vencen') {
  const contar = async (titulo, arg0) => {
    try {
      const r = await consultar(arg0, { intentos: 1 });
      const n = r.demasiados ?? r.registros.length;
      console.log(`- ${titulo}: ${r.demasiados !== undefined ? `demasiados para listar (${n})` : `${n} marcas`}`);
      return r;
    } catch (err) {
      console.log(`- ${titulo}: ERROR ${err.message}`);
      return null;
    }
  };
  const cuantas = (r) => r.demasiados ?? r.registros.length;
  console.log(`\nMarcas que ${tipo === 'vencen' ? 'vencen' : 'se solicitaron'} el ${dia}`);
  const todo = await contar('el día entero', criterios[tipo](dia, dia));
  if (!todo) return;
  const corte = 1_700_000;
  const r1 = await contar(`el día, expedientes 0 a ${corte - 1}`, criterios.diaYExpedientes(tipo, dia, 0, corte - 1));
  const r2 = await contar(`el día, expedientes ${corte} a ${EXPEDIENTE_MAX}`, criterios.diaYExpedientes(tipo, dia, corte, EXPEDIENTE_MAX));
  if (!r1 || !r2) return;
  const listadas = [...r1.registros, ...r2.registros].map(aMarca);
  const fueraDelDia = listadas.filter((m) => (tipo === 'vencen' ? m.fecha_vencimiento : m.fecha_ingreso) !== dia).length;
  const suma = cuantas(r1) + cuantas(r2);
  if (suma === cuantas(todo) && !fueraDelDia) {
    console.log(`\nOK: las dos mitades suman ${suma}, lo mismo que el día entero. Se puede partir por expediente.`);
  } else {
    console.log(`\nATENCIÓN: las mitades suman ${suma} (el día entero da ${cuantas(todo)})` +
      `${fueraDelDia ? ` y ${fueraDelDia} marcas no son de ese día` : ''}. Pasale esta salida a Claude.`);
  }
}

// ---------------------------------------------------------------------
// Línea de comandos
// ---------------------------------------------------------------------
const USO = `Uso (empezar siempre por --probar):
  node --env-file=.env src/joaju.js --probar [expediente]
  node --env-file=.env src/joaju.js --probar-dia AAAA-MM-DD   (día con demasiadas marcas que vencen)
  node --env-file=.env src/joaju.js --expedientes 2681702 2692763 [--sin-avisos]
  node --env-file=.env src/joaju.js --completar
  node --env-file=.env src/joaju.js --solicitudes AAAA-MM-DD AAAA-MM-DD [--sin-avisos]
  node --env-file=.env src/joaju.js --vencen AAAA-MM-DD AAAA-MM-DD
  --maximo N        corta después de N consultas
  --hasta-terminar  sigue sin tope hasta el final (para dejarlo corriendo con nohup)`;

const ES_FECHA = /^\d{4}-\d{2}-\d{2}$/;

// Antes de recorrer por fecha, se prueba con un día en el que ya sabemos que
// hay marcas: tiene que traer algunas, pero no la base entera.
async function fechaFiltra(tipo) {
  const columna = tipo === 'vencen' ? 'fecha_vencimiento' : 'fecha_ingreso';
  const { rows } = await query(
    `SELECT ${columna} AS dia FROM marcas_dinapi WHERE ${columna} IS NOT NULL ORDER BY ${columna} DESC LIMIT 1`
  );
  if (!rows.length) return false;
  const r = await consultar(criterios[tipo](rows[0].dia, rows[0].dia));
  return r.demasiados !== undefined ? r.demasiados <= MAXIMO_CREIBLE_POR_DIA : r.registros.length > 0;
}

async function main() {
  const args = process.argv.slice(2);
  const banderas = new Set(args.filter((a) => a.startsWith('--')));
  const valores = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--maximo');
  const iMax = args.indexOf('--maximo');
  const maximo = iMax >= 0 ? Number(args[iMax + 1]) : undefined;
  const hastaTerminar = banderas.has('--hasta-terminar');
  const [desde, hasta] = valores;

  if (banderas.has('--probar-dia')) {
    if (!ES_FECHA.test(desde ?? '')) return uso();
    await probarDia(desde, banderas.has('--solicitudes') ? 'solicitadas' : 'vencen');
    return;
  }
  if (banderas.has('--probar')) {
    await probar(valores[0] ?? '2692764');
    return;
  }

  let resumen;
  let sinAlertas = false;
  if (banderas.has('--expedientes')) {
    if (!ES_EXPEDIENTE.test(desde ?? '') || !ES_EXPEDIENTE.test(hasta ?? '') || +desde > +hasta) return uso();
    resumen = await recorrerExpedientes(+desde, +hasta, { maximo, hastaTerminar });
  } else if (banderas.has('--completar')) {
    sinAlertas = true;
    resumen = await completarVencimientos({ maximo, hastaTerminar });
  } else if (banderas.has('--solicitudes') || banderas.has('--vencen')) {
    const tipo = banderas.has('--solicitudes') ? 'solicitadas' : 'vencen';
    if (!ES_FECHA.test(desde ?? '') || !ES_FECHA.test(hasta ?? '') || desde > hasta) return uso();
    if (!(await fechaFiltra(tipo))) {
      console.log('La búsqueda por fecha no funciona en Joaju con JOAJU_FORMATO_FECHA. Usá --expedientes o --completar.');
      process.exitCode = 1;
      return;
    }
    // Las marcas que vencen son viejas: se guardan como antecedentes, sin alertas.
    sinAlertas = tipo === 'vencen';
    resumen = await recorrer(tipo, desde, hasta, { maximo, sinAlertas, hastaTerminar });
  } else {
    return uso();
  }

  let avisos = { ok: true };
  if (!sinAlertas && !banderas.has('--sin-avisos')) avisos = await enviarAvisosPendientes();
  process.exitCode = resumen.ok && avisos.ok ? 0 : 1;
}

function uso() {
  console.log(USO);
  process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.on('unhandledRejection', (err) => registrarError('Promesa sin capturar', err));
  main()
    .catch((err) => registrarError('main', err).then(() => (process.exitCode = 1)))
    .finally(() => cerrarPool());
}
