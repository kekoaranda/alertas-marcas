// agentes.js - Agentes de marcas: sus marcas se vigilan solas.
//
// Cada marca del boletín trae la matrícula del agente que la presentó.
// Cuando un admin verifica la matrícula de una cuenta, todas las marcas de
// la DINAPI con esa matrícula pasan a ser "marcas vigiladas" de esa cuenta.
// Después, cada marca nueva que el agente presenta se agrega sola al cargar
// el boletín (src/procesadorBoletin.js).
import { pool } from './db.js';

/** Solo los dígitos, sin ceros adelante ("7.152" y 7152 dan "7152"). Igual que normalizar_matricula() en SQL. */
export function normalizarMatricula(valor) {
  const digitos = String(valor ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return digitos || null;
}

// Agrega como vigiladas las marcas del agente que todavía no lo están.
// - Una marca con el mismo nombre y clase (ej: la original y su renovación)
//   entra una sola vez, y no entra si el usuario ya la vigilaba a mano.
// - Las figurativas (sin denominación) no tienen texto que comparar.
// - $2 NULL = todas las marcas del agente; si no, solo esa marca.
const SQL_VIGILAR_MARCAS_AGENTE = `
  INSERT INTO terminos_monitoreados (usuario_id, texto_buscar, clase_niza, marca_dinapi_id)
  SELECT DISTINCT ON (normalizar_marca(m.nombre_marca), m.clase_niza)
         u.id, m.nombre_marca, m.clase_niza, m.id
  FROM usuarios u
  JOIN marcas_dinapi m ON normalizar_matricula(m.matricula_agente) = u.matricula
  WHERE u.id = $1
    AND u.matricula_verificada
    AND ($2::uuid IS NULL OR m.id = $2)
    AND length(trim(coalesce(m.nombre_marca, ''))) > 0
    AND NOT EXISTS (
      SELECT 1 FROM terminos_monitoreados t
      WHERE t.usuario_id = u.id
        AND (t.marca_dinapi_id = m.id
             OR (normalizar_marca(t.texto_buscar) = normalizar_marca(m.nombre_marca)
                 AND t.clase_niza IS NOT DISTINCT FROM m.clase_niza))
    )
  ORDER BY normalizar_marca(m.nombre_marca), m.clase_niza, m.fecha_ingreso DESC NULLS LAST
  ON CONFLICT DO NOTHING`;

/**
 * Carga todas las marcas del agente como vigiladas (al verificar su matrícula).
 * @returns {Promise<number>} Cuántas marcas se agregaron.
 */
export async function vigilarMarcasDelAgente(usuarioId, { client = pool } = {}) {
  const { rowCount } = await client.query(SQL_VIGILAR_MARCAS_AGENTE, [usuarioId, null]);
  return rowCount;
}

/**
 * Una marca recién cargada del boletín: si su agente tiene cuenta verificada,
 * pasa a ser vigilada por esa cuenta.
 * @returns {Promise<number>} 1 si se agregó, 0 si no.
 */
export async function vigilarMarcaNuevaDeAgente(marca, { client = pool } = {}) {
  const matricula = normalizarMatricula(marca.matricula_agente);
  if (!matricula || !marca.nombre_marca?.trim()) return 0;
  const { rows } = await client.query(
    'SELECT id FROM usuarios WHERE matricula = $1 AND matricula_verificada AND habilitado',
    [matricula]
  );
  if (!rows.length) return 0;
  const { rowCount } = await client.query(SQL_VIGILAR_MARCAS_AGENTE, [rows[0].id, marca.id]);
  return rowCount;
}

/** Datos de la DINAPI sobre una matrícula: nombre del agente y cuántas marcas tiene. */
export async function datosDeMatricula(matricula, { client = pool } = {}) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS marcas,
            mode() WITHIN GROUP (ORDER BY agente) AS agente
     FROM marcas_dinapi
     WHERE normalizar_matricula(matricula_agente) = $1`,
    [matricula]
  );
  return rows[0];
}
