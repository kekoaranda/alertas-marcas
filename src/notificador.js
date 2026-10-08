// notificador.js - Avisos por email de las alertas nuevas.
//
// Manda UN email por usuario con todas sus alertas pendientes (un resumen),
// no un email por alerta: después de un boletín puede haber varias.
// Cada alerta enviada queda marcada (alertas.notificada_el). Si el envío
// falla, las alertas siguen pendientes y salen en la próxima corrida.
//
// Uso:
//   node --env-file=.env src/notificador.js          (o npm run avisos)
//   import { enviarAvisosPendientes } from './src/notificador.js'
//
// Con AVISOS_MODO=prueba no se envía nada: cada email se guarda como .html
// en logs/avisos/ para revisarlo en el navegador.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nodemailer from 'nodemailer';

import { query, cerrarPool } from './db.js';
import { env, envNumero } from './config.js';
import { registrarError } from './registro.js';

const LOG_DIR = env('LOG_DIR', './logs');

// Máximo de alertas que se listan en un email (el resto se resume en una línea)
const MAXIMO_POR_EMAIL = 50;

const SQL_PENDIENTES = `
  SELECT a.id AS alerta_id, a.tipo_coincidencia, a.similitud, a.creado_el,
         t.texto_buscar, t.clase_niza AS clase_termino,
         m.nro_expediente, m.nombre_marca, m.clase_niza, m.fecha_ingreso,
         m.titular, m.pais_titular, m.agente,
         u.id AS usuario_id, u.email, u.nombre AS usuario_nombre, u.plan_pago
  FROM alertas a
  JOIN terminos_monitoreados t ON t.id = a.termino_id
  JOIN usuarios u              ON u.id = t.usuario_id
  JOIN marcas_dinapi m         ON m.id = a.marca_dinapi_id
  WHERE a.notificada_el IS NULL
    AND a.revisada = false
    AND u.recibir_avisos
    AND u.habilitado
  ORDER BY u.id, a.similitud DESC, m.fecha_ingreso DESC`;

const TIPOS = {
  IDENTICA: 'Idéntica',
  PARCIAL: 'Contiene tu marca',
  ORTOGRAFICA: 'Se escribe parecido',
  FONETICA: 'Suena parecido',
};

const escapar = (texto) =>
  String(texto ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fechaCorta = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

// ---------------------------------------------------------------------
// Contenido del email
// ---------------------------------------------------------------------
export function armarEmail(usuario, alertas) {
  const total = alertas.length;
  const visibles = alertas.slice(0, MAXIMO_POR_EMAIL);
  const asunto =
    total === 1
      ? `Alerta: "${alertas[0].nombre_marca}" se parece a tu marca ${alertas[0].texto_buscar}`
      : `${total} marcas nuevas en la DINAPI se parecen a las tuyas`;

  const filasHtml = visibles
    .map(
      (a) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5"><strong>${escapar(a.texto_buscar)}</strong></td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5"><strong>${escapar(a.nombre_marca)}</strong><br>
          <span style="color:#666;font-size:12px">${escapar(a.titular ?? '')}${a.pais_titular ? ` (${escapar(a.pais_titular)})` : ''}</span></td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:center">${a.clase_niza ?? '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5">${escapar(a.nro_expediente)}<br>
          <span style="color:#666;font-size:12px">${fechaCorta(a.fecha_ingreso)}</span></td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5">${TIPOS[a.tipo_coincidencia] ?? a.tipo_coincidencia}</td>
      </tr>`
    )
    .join('');

  const resto = total - visibles.length;
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>${escapar(asunto)}</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:760px;margin:auto;padding:16px">
  <h2 style="margin:0 0 8px">Alertas de Marcas</h2>
  <p>Hola ${escapar(usuario.usuario_nombre)}:</p>
  <p>En el último boletín de la DINAPI ${total === 1 ? 'apareció una solicitud que se parece' : `aparecieron ${total} solicitudes que se parecen`} a las marcas que vigilás.</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px">
    <thead><tr style="background:#f3f4f6;text-align:left">
      <th style="padding:8px">Tu marca</th><th style="padding:8px">Solicitud nueva</th>
      <th style="padding:8px">Clase</th><th style="padding:8px">Expediente</th><th style="padding:8px">Coincidencia</th>
    </tr></thead>
    <tbody>${filasHtml}</tbody>
  </table>
  ${resto > 0 ? `<p>Y ${resto} alertas más.</p>` : ''}
  <p style="color:#666;font-size:12px;margin-top:24px">El expediente se puede consultar en el sistema Joaju de la DINAPI (joaju.dinapi.gov.py).
  Este aviso es automático y no reemplaza el análisis de un profesional.</p>
</body></html>`;

  const texto = [
    `Hola ${usuario.usuario_nombre}:`,
    '',
    `En el último boletín de la DINAPI hay ${total} solicitud(es) parecida(s) a tus marcas:`,
    '',
    ...visibles.map(
      (a) =>
        `- ${a.texto_buscar} -> ${a.nombre_marca} (clase ${a.clase_niza ?? '-'}, expediente ${a.nro_expediente}, ` +
        `${fechaCorta(a.fecha_ingreso)}): ${TIPOS[a.tipo_coincidencia] ?? a.tipo_coincidencia}` +
        (a.titular ? `. Titular: ${a.titular}` : '')
    ),
    resto > 0 ? `Y ${resto} alertas más.` : '',
    '',
    'Consultá cada expediente en joaju.dinapi.gov.py. Este aviso es automático.',
  ].join('\n');

  return { asunto, html, texto };
}

// ---------------------------------------------------------------------
// Envío
// ---------------------------------------------------------------------
// "Alertas de Marcas <avisos@dominio.com.py>" -> { name, email }
function separarRemitente(texto) {
  const partes = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(texto ?? '');
  return partes ? { name: partes[1] || undefined, email: partes[2].trim() } : { email: String(texto).trim() };
}

// Brevo por su API web (HTTPS): no depende de los puertos de correo, que
// algunos servidores (Hetzner, por ejemplo) bloquean.
function crearTransporteBrevo() {
  const faltan = ['BREVO_API_KEY', 'AVISOS_REMITENTE'].filter((v) => !env(v));
  if (faltan.length) throw new Error(`Faltan variables para enviar con Brevo: ${faltan.join(', ')}`);
  const url = env('BREVO_API_URL', 'https://api.brevo.com/v3/smtp/email');
  return {
    async sendMail({ from, to, subject, text, html }) {
      const respuesta = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender: separarRemitente(from),
          to: [{ email: to }],
          subject,
          htmlContent: html,
          textContent: text,
        }),
      });
      if (!respuesta.ok) {
        const detalle = await respuesta.text().catch(() => '');
        throw new Error(`Brevo respondió HTTP ${respuesta.status}: ${detalle.slice(0, 300)}`);
      }
    },
  };
}

function crearTransporte() {
  const modo = env('AVISOS_MODO', 'prueba');
  if (modo === 'prueba') return null;
  if (modo === 'brevo') return crearTransporteBrevo();
  if (modo !== 'smtp') throw new Error(`AVISOS_MODO="${modo}" no existe: usá prueba, brevo o smtp`);
  const faltan = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'AVISOS_REMITENTE'].filter((v) => !env(v));
  if (faltan.length) throw new Error(`Faltan variables para enviar emails: ${faltan.join(', ')}`);
  const puerto = envNumero('SMTP_PORT', 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: puerto,
    secure: puerto === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function guardarEnArchivo(usuario, email) {
  const carpeta = path.join(LOG_DIR, 'avisos');
  await mkdir(carpeta, { recursive: true });
  const nombre = `${new Date().toISOString().replace(/[:.]/g, '-')}-${usuario.email.replace(/[^a-z0-9@.]+/gi, '_')}.html`;
  const archivo = path.join(carpeta, nombre);
  await writeFile(archivo, email.html, 'utf8');
  return archivo;
}

/**
 * Envía un email por usuario con sus alertas pendientes y las marca como
 * notificadas. Nunca lanza: devuelve un resumen { ok, usuarios, enviados, fallidos, alertas }.
 */
export async function enviarAvisosPendientes() {
  const resumen = { ok: true, modo: env('AVISOS_MODO', 'prueba'), usuarios: 0, enviados: 0, fallidos: 0, alertas: 0 };
  try {
    const transporte = crearTransporte();
    const { rows } = await query(SQL_PENDIENTES);

    const porUsuario = new Map();
    for (const fila of rows) {
      if (!porUsuario.has(fila.usuario_id)) porUsuario.set(fila.usuario_id, []);
      porUsuario.get(fila.usuario_id).push(fila);
    }
    resumen.usuarios = porUsuario.size;

    for (const alertas of porUsuario.values()) {
      const usuario = alertas[0];
      try {
        const email = armarEmail(usuario, alertas);
        if (transporte) {
          await transporte.sendMail({
            from: process.env.AVISOS_REMITENTE,
            to: usuario.email,
            subject: email.asunto,
            text: email.texto,
            html: email.html,
          });
        } else {
          const archivo = await guardarEnArchivo(usuario, email);
          console.log(`[avisos] (prueba) ${usuario.email}: ${email.asunto} -> ${archivo}`);
        }
        await query('UPDATE alertas SET notificada_el = now() WHERE id = ANY($1::uuid[])', [
          alertas.map((a) => a.alerta_id),
        ]);
        resumen.enviados++;
        resumen.alertas += alertas.length;
      } catch (err) {
        // Un email que falla no frena a los demás; sus alertas quedan pendientes
        resumen.fallidos++;
        resumen.ok = false;
        await registrarError('Aviso por email', err, { email: usuario.email, alertas: alertas.length });
      }
    }
  } catch (err) {
    resumen.ok = false;
    resumen.error = err.message;
    await registrarError('Avisos', err);
  }
  console.log('[avisos] Resumen:', JSON.stringify(resumen));
  return resumen;
}

/** Envía un email de prueba para comprobar que el servicio de correo está bien configurado. */
export async function enviarEmailDePrueba(destino) {
  const transporte = crearTransporte();
  if (!transporte) throw new Error('AVISOS_MODO=prueba no envía emails: poné brevo o smtp en el .env');
  await transporte.sendMail({
    from: process.env.AVISOS_REMITENTE,
    to: destino,
    subject: 'Prueba de Alertas de Marcas',
    text: 'Si recibiste este email, los avisos están bien configurados.',
    html: '<p>Si recibiste este email, los avisos están bien configurados.</p>',
  });
}

// Uso:  node --env-file=.env src/notificador.js                    envía los avisos pendientes
//       node --env-file=.env src/notificador.js --probar tu@email   envía un email de prueba
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [opcion, destino] = process.argv.slice(2);
  const tarea =
    opcion === '--probar'
      ? enviarEmailDePrueba(destino).then(
          () => console.log(`[avisos] Email de prueba enviado a ${destino}`),
          (err) => {
            console.error(`[avisos] No se pudo enviar: ${err.message}`);
            process.exitCode = 1;
          }
        )
      : enviarAvisosPendientes().then((r) => (process.exitCode = r.ok ? 0 : 1));
  tarea.finally(() => cerrarPool());
}
