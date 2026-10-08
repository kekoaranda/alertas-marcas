// registro.js - Registro de errores (consola + archivo logs/errores-AAAA-MM-DD.log).
// Nunca lanza: si no puede escribir el archivo, lo avisa por consola y sigue.
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { env } from './config.js';

const LOG_DIR = env('LOG_DIR', './logs');

export async function registrarError(contexto, err, extra = {}) {
  const entrada = {
    fecha: new Date().toISOString(),
    contexto,
    mensaje: err?.message ?? String(err),
    codigo: err?.code,
    ...extra,
  };
  console.error(`[error] ${contexto}: ${entrada.mensaje}`);
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const archivo = path.join(LOG_DIR, `errores-${entrada.fecha.slice(0, 10)}.log`);
    await appendFile(archivo, JSON.stringify(entrada) + '\n', 'utf8');
  } catch (errLog) {
    console.error('[error] No se pudo escribir el log:', errLog.message);
  }
}

