// servidor.js - Página web y API para los clientes.
//
// Cada cliente se registra con email y contraseña, carga las marcas que
// quiere vigilar (con límite según su plan) y ve sus alertas.
//
// Uso:  node --env-file=.env src/servidor.js      (o npm start)
//       Abre http://localhost:3100 (puerto configurable con PORT)
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import bcrypt from 'bcryptjs';

import { pool, query } from './db.js';
import { env, envNumero } from './config.js';
import { buscarMarcasSimilares } from './moduloAlertas.js';
import { registrarError } from './registro.js';

const CARPETA_PUBLICA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'sesion';
const DIAS_SESION = 30;

// Límite de marcas vigiladas por plan (null = sin límite)
export const LIMITES_PLAN = {
  FREE: envNumero('PLAN_FREE_MAXIMO', 3),
  PREMIUM: null,
};

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
class ErrorUsuario extends Error {
  constructor(estado, mensaje) {
    super(mensaje);
    this.estado = estado;
  }
}
const error = (estado, mensaje) => new ErrorUsuario(estado, mensaje);

const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ES_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function leerCookie(req, nombre) {
  for (const parte of (req.headers.cookie ?? '').split(';')) {
    const [clave, ...valor] = parte.trim().split('=');
    if (clave === nombre) return decodeURIComponent(valor.join('='));
  }
  return null;
}

function texto(valor, campo, { min = 1, max = 200 } = {}) {
  const limpio = String(valor ?? '').replace(/\s+/g, ' ').trim();
  if (limpio.length < min) throw error(400, `Falta ${campo}`);
  if (limpio.length > max) throw error(400, `${campo} es demasiado largo (máximo ${max} caracteres)`);
  return limpio;
}

function claseNiza(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero < 1 || numero > 45) {
    throw error(400, 'La clase de Niza tiene que ser un número del 1 al 45');
  }
  return numero;
}

// Freno simple contra adivinar contraseñas: 10 intentos fallidos cada 15 minutos
// por IP y email. En memoria: se reinicia si se reinicia el servidor.
const intentosFallidos = new Map();
const VENTANA_MS = 15 * 60_000;
function verificarIntentos(clave) {
  const ahora = Date.now();
  const lista = (intentosFallidos.get(clave) ?? []).filter((t) => ahora - t < VENTANA_MS);
  intentosFallidos.set(clave, lista);
  if (lista.length >= 10) throw error(429, 'Demasiados intentos. Probá de nuevo en 15 minutos.');
}
const anotarFallo = (clave) => intentosFallidos.get(clave)?.push(Date.now());

// ---------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------
async function iniciarSesion(req, res, usuarioId) {
  const token = randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sesiones (token_hash, usuario_id, expira_el)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hashToken(token), usuarioId, DIAS_SESION]
  );
  // De paso se borran las sesiones vencidas
  await query('DELETE FROM sesiones WHERE expira_el < now()');
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: DIAS_SESION * 24 * 3600 * 1000,
    path: '/',
  });
}

async function cargarUsuario(req, _res, next) {
  const token = leerCookie(req, COOKIE);
  if (token) {
    const { rows } = await query(
      `SELECT u.id, u.email, u.nombre, u.plan_pago, u.recibir_avisos
       FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.token_hash = $1 AND s.expira_el > now()`,
      [hashToken(token)]
    );
    req.usuario = rows[0] ?? null;
  }
  next();
}

function requiereSesion(req, _res, next) {
  if (!req.usuario) throw error(401, 'Tenés que iniciar sesión');
  next();
}

// ---------------------------------------------------------------------
// Aplicación
// ---------------------------------------------------------------------
export function crearApp() {
  const app = express();
  app.disable('x-powered-by');
  // Detrás de un proxy (Cloudflare Tunnel, nginx) para saber la IP real y si es HTTPS
  if (env('TRUST_PROXY') === 'true') app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.json({ limit: '20kb' }));
  app.use(
    express.static(CARPETA_PUBLICA, {
      index: 'index.html',
      // El service worker y la página siempre se revisan, así los cambios llegan enseguida
      setHeaders: (res, ruta) => {
        if (/(sw\.js|index\.html|\.webmanifest)$/.test(ruta)) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );
  app.use('/api', cargarUsuario);

  // La API solo acepta JSON en los pedidos con datos: un formulario de otro
  // sitio no puede enviar JSON, así que esto también frena CSRF. (DELETE no
  // puede venir de un formulario, y la cookie SameSite=Lax no viaja en él.)
  app.use('/api', (req, _res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      throw error(415, 'Se esperaba JSON');
    }
    next();
  });

  // --- Cuenta ---------------------------------------------------------
  app.post('/api/registro', async (req, res) => {
    const nombre = texto(req.body?.nombre, 'el nombre', { max: 100 });
    const email = texto(req.body?.email, 'el email', { max: 200 }).toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!ES_EMAIL.test(email)) throw error(400, 'El email no es válido');
    if (password.length < 8) throw error(400, 'La contraseña tiene que tener al menos 8 caracteres');
    if (password.length > 72) throw error(400, 'La contraseña es demasiado larga');

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      `INSERT INTO usuarios (email, nombre, plan_pago, password_hash)
       VALUES ($1, $2, 'FREE', $3)
       ON CONFLICT ((lower(email))) DO NOTHING
       RETURNING id`,
      [email, nombre, hash]
    );
    if (!rows.length) throw error(409, 'Ya existe una cuenta con ese email. Probá iniciar sesión.');
    await iniciarSesion(req, res, rows[0].id);
    res.status(201).json({ ok: true });
  });

  app.post('/api/ingreso', async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const clave = `${req.ip}|${email}`;
    verificarIntentos(clave);

    const { rows } = await query(
      'SELECT id, password_hash FROM usuarios WHERE lower(email) = $1',
      [email]
    );
    const usuario = rows[0];
    const valida = usuario?.password_hash && (await bcrypt.compare(password, usuario.password_hash));
    if (!valida) {
      anotarFallo(clave);
      throw error(401, 'Email o contraseña incorrectos');
    }
    intentosFallidos.delete(clave);
    await iniciarSesion(req, res, usuario.id);
    res.json({ ok: true });
  });

  app.post('/api/salir', async (req, res) => {
    const token = leerCookie(req, COOKIE);
    if (token) await query('DELETE FROM sesiones WHERE token_hash = $1', [hashToken(token)]);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/yo', requiereSesion, async (req, res) => {
    const { rows } = await query(
      'SELECT count(*)::int AS usados FROM terminos_monitoreados WHERE usuario_id = $1',
      [req.usuario.id]
    );
    res.json({
      nombre: req.usuario.nombre,
      email: req.usuario.email,
      plan: req.usuario.plan_pago,
      limite: LIMITES_PLAN[req.usuario.plan_pago] ?? null,
      usados: rows[0].usados,
      recibir_avisos: req.usuario.recibir_avisos,
    });
  });

  app.patch('/api/yo', requiereSesion, async (req, res) => {
    if (typeof req.body?.recibir_avisos !== 'boolean') throw error(400, 'Falta recibir_avisos (true o false)');
    await query('UPDATE usuarios SET recibir_avisos = $2 WHERE id = $1', [req.usuario.id, req.body.recibir_avisos]);
    res.json({ ok: true });
  });

  app.post('/api/cambiar-password', requiereSesion, async (req, res) => {
    const actual = String(req.body?.actual ?? '');
    const nueva = String(req.body?.nueva ?? '');
    if (nueva.length < 8 || nueva.length > 72) throw error(400, 'La contraseña nueva tiene que tener entre 8 y 72 caracteres');
    const { rows } = await query('SELECT password_hash FROM usuarios WHERE id = $1', [req.usuario.id]);
    if (!(await bcrypt.compare(actual, rows[0].password_hash ?? ''))) throw error(401, 'La contraseña actual no es correcta');
    await query('UPDATE usuarios SET password_hash = $2 WHERE id = $1', [req.usuario.id, await bcrypt.hash(nueva, 10)]);
    // Cierra las demás sesiones abiertas
    await query('DELETE FROM sesiones WHERE usuario_id = $1 AND token_hash <> $2', [
      req.usuario.id,
      hashToken(leerCookie(req, COOKIE)),
    ]);
    res.json({ ok: true });
  });

  // --- Marcas vigiladas --------------------------------------------------
  app.get('/api/terminos', requiereSesion, async (req, res) => {
    const { rows } = await query(
      `SELECT t.id, t.texto_buscar AS texto, t.clase_niza AS clase, t.creado_el,
              count(a.id) FILTER (WHERE NOT a.revisada)::int AS alertas_pendientes
       FROM terminos_monitoreados t
       LEFT JOIN alertas a ON a.termino_id = t.id
       WHERE t.usuario_id = $1
       GROUP BY t.id
       ORDER BY t.creado_el`,
      [req.usuario.id]
    );
    res.json(rows);
  });

  app.post('/api/terminos', requiereSesion, async (req, res) => {
    const textoBuscar = texto(req.body?.texto, 'el nombre de la marca', { min: 2, max: 100 });
    const clase = claseNiza(req.body?.clase);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Bloquea al usuario para que dos pedidos a la vez no pasen el límite
      const { rows: u } = await client.query(
        'SELECT plan_pago FROM usuarios WHERE id = $1 FOR UPDATE',
        [req.usuario.id]
      );
      const limite = LIMITES_PLAN[u[0].plan_pago] ?? null;
      const { rows: actuales } = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE normalizar_marca(texto_buscar) = normalizar_marca($2)
                                   AND clase_niza IS NOT DISTINCT FROM $3)::int AS repetidos
         FROM terminos_monitoreados WHERE usuario_id = $1`,
        [req.usuario.id, textoBuscar, clase]
      );
      if (actuales[0].repetidos > 0) throw error(409, 'Ya estás vigilando esa marca en esa clase');
      if (limite !== null && actuales[0].total >= limite) {
        throw error(403, `Tu plan ${u[0].plan_pago} permite vigilar hasta ${limite} marcas. Pasate a PREMIUM para agregar más.`);
      }
      const { rows } = await client.query(
        `INSERT INTO terminos_monitoreados (usuario_id, texto_buscar, clase_niza)
         VALUES ($1, $2, $3)
         RETURNING id, texto_buscar AS texto, clase_niza AS clase, creado_el`,
        [req.usuario.id, textoBuscar, clase]
      );
      await client.query('COMMIT');
      res.status(201).json({ ...rows[0], alertas_pendientes: 0 });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  app.delete('/api/terminos/:id', requiereSesion, async (req, res) => {
    if (!ES_UUID.test(req.params.id)) throw error(404, 'No encontrada');
    const { rowCount } = await query(
      'DELETE FROM terminos_monitoreados WHERE id = $1 AND usuario_id = $2',
      [req.params.id, req.usuario.id]
    );
    if (!rowCount) throw error(404, 'No encontrada');
    res.json({ ok: true });
  });

  // Marcas ya existentes en la DINAPI parecidas a una marca vigilada
  app.get('/api/terminos/:id/similares', requiereSesion, async (req, res) => {
    if (!ES_UUID.test(req.params.id)) throw error(404, 'No encontrada');
    const { rows } = await query(
      'SELECT texto_buscar, clase_niza FROM terminos_monitoreados WHERE id = $1 AND usuario_id = $2',
      [req.params.id, req.usuario.id]
    );
    if (!rows.length) throw error(404, 'No encontrada');
    res.json(await buscarMarcasSimilares(rows[0].texto_buscar, { clase: rows[0].clase_niza, limite: 30 }));
  });

  // --- Alertas -------------------------------------------------------------
  app.get('/api/alertas', requiereSesion, async (req, res) => {
    const soloPendientes = req.query.estado !== 'todas';
    const { rows } = await query(
      `SELECT a.id, a.tipo_coincidencia, round(a.similitud::numeric, 2)::float AS similitud,
              a.revisada, a.creado_el,
              t.texto_buscar AS tu_marca,
              m.nro_expediente, m.nombre_marca, m.clase_niza, m.fecha_ingreso,
              m.titular, m.pais_titular, m.agente, m.tipo_signo
       FROM alertas a
       JOIN terminos_monitoreados t ON t.id = a.termino_id
       JOIN marcas_dinapi m         ON m.id = a.marca_dinapi_id
       WHERE t.usuario_id = $1 AND ($2::bool = false OR NOT a.revisada)
       ORDER BY a.creado_el DESC, a.similitud DESC
       LIMIT 200`,
      [req.usuario.id, soloPendientes]
    );
    res.json(rows);
  });

  app.patch('/api/alertas/:id', requiereSesion, async (req, res) => {
    if (!ES_UUID.test(req.params.id)) throw error(404, 'No encontrada');
    if (typeof req.body?.revisada !== 'boolean') throw error(400, 'Falta revisada (true o false)');
    const { rowCount } = await query(
      `UPDATE alertas a SET revisada = $3
       FROM terminos_monitoreados t
       WHERE a.id = $1 AND t.id = a.termino_id AND t.usuario_id = $2`,
      [req.params.id, req.usuario.id, req.body.revisada]
    );
    if (!rowCount) throw error(404, 'No encontrada');
    res.json({ ok: true });
  });

  app.get('/api/salud', async (_req, res) => {
    await query('SELECT 1');
    res.json({ ok: true });
  });

  app.use('/api', (_req, _res) => {
    throw error(404, 'No existe');
  });

  // Errores: los del usuario se muestran tal cual; los demás se registran
  // y se responde un mensaje genérico (sin detalles internos).
  app.use((err, req, res, _next) => {
    if (err instanceof ErrorUsuario) return res.status(err.estado).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Pedido demasiado grande' });
    registrarError('Servidor web', err, { ruta: `${req.method} ${req.path}` });
    res.status(500).json({ error: 'Ocurrió un error. Probá de nuevo en un rato.' });
  });

  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const puerto = envNumero('PORT', 3100);
  const host = env('HOST', '127.0.0.1');
  crearApp().listen(puerto, host, () => {
    console.log(`[web] Alertas de Marcas en http://${host}:${puerto}`);
  });
}
