// aplicarSql.js - Ejecuta un archivo .sql contra la base del .env.
// Uso: node --env-file=.env src/aplicarSql.js sql/schema.sql
import { readFile } from 'node:fs/promises';
import { pool, cerrarPool } from './db.js';

const archivo = process.argv[2];
if (!archivo) {
  console.error('Uso: node --env-file=.env src/aplicarSql.js archivo.sql');
  process.exit(2);
}

try {
  const client = await pool.connect();
  // Muestra los mensajes RAISE NOTICE del script (ej: cuántas filas borró)
  // (sin los "ya existe, se saltea" de los CREATE ... IF NOT EXISTS)
  client.on('notice', (aviso) => {
    if (!aviso.message.endsWith(', skipping')) console.log(aviso.message);
  });
  try {
    await client.query(await readFile(archivo, 'utf8'));
  } finally {
    client.release();
  }
  console.log(`OK: ${archivo} aplicado`);
} catch (err) {
  console.error(`Error aplicando ${archivo}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await cerrarPool();
}
