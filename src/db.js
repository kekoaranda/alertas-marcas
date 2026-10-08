// db.js - Pool de conexiones a PostgreSQL con el driver nativo 'pg'.
// Los datos de conexión vienen SOLO de variables de entorno (.env),
// nunca escritos en el código.
import pg from 'pg';
import { env, envNumero } from './config.js';

const { Pool, types } = pg;

// Las columnas DATE se devuelven como texto 'YYYY-MM-DD' para evitar
// corrimientos de un día por zona horaria (Paraguay, UTC-3/UTC-4).
types.setTypeParser(types.builtins.DATE, (valor) => valor);

const requeridas = ['PGHOST', 'PGDATABASE', 'PGUSER'];
const faltantes = requeridas.filter((nombre) => !env(nombre));
if (faltantes.length > 0) {
  throw new Error(
    `Faltan variables de entorno: ${faltantes.join(', ')}. ` +
      'Copiá .env.example como .env y completalo.'
  );
}

export const pool = new Pool({
  host: process.env.PGHOST,
  port: envNumero('PGPORT', 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: env('PGSSL') === 'true' ? { rejectUnauthorized: false } : false,
  max: envNumero('PGPOOL_MAX', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'alertas-marcas',
});

// Un error en una conexión inactiva (ej: reinicio de PostgreSQL) no debe
// tumbar el proceso de Node.js. El pool descarta esa conexión y crea otra.
pool.on('error', (err) => {
  console.error('[db] Error en una conexión inactiva del pool:', err.message);
});

/** Consulta simple con parámetros ($1, $2...). Nunca concatenar valores en el SQL. */
export function query(texto, parametros = []) {
  return pool.query(texto, parametros);
}

/**
 * Ejecuta `trabajo(client)` dentro de una transacción.
 * Si algo falla hace ROLLBACK y relanza el error; siempre libera la conexión.
 */
export async function enTransaccion(trabajo) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await trabajo(client);
    await client.query('COMMIT');
    return resultado;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Cierra el pool (usar al final de scripts de línea de comandos). */
export function cerrarPool() {
  return pool.end();
}
