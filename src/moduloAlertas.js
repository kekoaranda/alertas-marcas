// moduloAlertas.js - Motor de alertas.
// Compara una marca nueva de la DINAPI contra todos los términos que los
// usuarios vigilan y guarda una alerta por cada coincidencia.
import { pool } from './db.js';
import { envNumero } from './config.js';

const UMBRAL_POR_DEFECTO = envNumero('UMBRAL_SIMILITUD', 0.4);

// Umbral para strict_word_similarity: detecta el término DENTRO de una marca
// más larga aunque esté mal escrito ("Kurupí" vs "Kurupy Premium").
const UMBRAL_PALABRA_POR_DEFECTO = envNumero('UMBRAL_PALABRA', 0.5);

// Largo mínimo para la coincidencia parcial (palabras completas) y la fonética.
// Evita que un término de 1 o 2 letras ("A", "PY") coincida con todo.
const LARGO_MINIMO_PARCIAL = 3;

// Texto como lista de palabras: solo letras y números, separados y rodeados
// por un espacio (" tigo money "). Así la coincidencia parcial es por palabras
// completas: "Tigo" coincide con "TIGO MONEY" pero no con "CONTIGO" (un caso
// real del boletín de agosto 2026). Al no quedar % ni _, no hace falta escapar.
const PALABRAS = (expr) =>
  `(' ' || trim(regexp_replace(${expr}, '[^a-z0-9]+', ' ', 'g')) || ' ')`;

// Escapa los comodines de ILIKE (% _ \) para que se busquen como texto literal.
const ESCAPAR_LIKE = (expr) =>
  `replace(replace(replace(${expr}, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;

// Fonética: fonetica_es() (definida en sql/schema.sql) aplica reglas del
// español: b=v, s=z=c(e,i), k=c=qu, y=ll, h muda, j=g(e,i), letras dobles.
//
// Una sola consulta que:
//  1. normaliza (minúsculas, sin tildes) la marca y cada término,
//  2. evalúa los criterios contra los términos de la misma clase de Niza
//     (o sin clase, que vigilan todas): idéntica, parcial (por palabras),
//     ortográfica (similarity > umbral) y fonética (fonetica_es igual),
//  3. inserta las alertas (ON CONFLICT evita duplicados si se reprocesa),
//  4. devuelve las alertas nuevas con el email del usuario, listas para notificar.
const SQL_BUSCAR_E_INSERTAR = `
WITH marca AS (
  SELECT $1::uuid AS id,
         normalizar_marca($2::text) AS nombre,
         ${PALABRAS('normalizar_marca($2::text)')} AS palabras,
         $3::int AS clase,
         fonetica_es($2::text) AS fonetica
),
terminos AS (
  SELECT t.id, normalizar_marca(t.texto_buscar) AS texto,
         ${PALABRAS('normalizar_marca(t.texto_buscar)')} AS palabras,
         fonetica_es(t.texto_buscar) AS fonetica
  FROM terminos_monitoreados t, marca m
  WHERE t.clase_niza IS NULL
     OR m.clase IS NULL
     OR t.clase_niza = m.clase
),
evaluados AS (
  SELECT
    t.id AS termino_id,
    similarity(t.texto, m.nombre) AS sim,
    strict_word_similarity(t.texto, m.nombre) AS sim_palabra,
    t.texto = m.nombre AS es_identica,
    (
      (length(t.texto) >= $6 AND m.palabras LIKE '%' || t.palabras || '%')
      OR
      (length(m.nombre) >= $6 AND t.palabras LIKE '%' || m.palabras || '%')
    ) AS es_parcial,
    (length(m.fonetica) >= $6 AND t.fonetica = m.fonetica) AS es_fonetica
  FROM terminos t, marca m
),
nuevas AS (
  INSERT INTO alertas (termino_id, marca_dinapi_id, tipo_coincidencia, similitud)
  SELECT
    e.termino_id,
    $1::uuid,
    CASE
      WHEN e.es_identica                      THEN 'IDENTICA'
      WHEN e.es_parcial                       THEN 'PARCIAL'
      WHEN e.sim > $4 OR e.sim_palabra > $5   THEN 'ORTOGRAFICA'
      ELSE                                         'FONETICA'
    END,
    greatest(e.sim, e.sim_palabra)
  FROM evaluados e
  WHERE e.es_identica OR e.es_parcial OR e.sim > $4 OR e.sim_palabra > $5 OR e.es_fonetica
  ON CONFLICT (termino_id, marca_dinapi_id) DO NOTHING
  RETURNING id, termino_id, tipo_coincidencia, similitud
)
SELECT
  n.id                AS alerta_id,
  n.tipo_coincidencia,
  round(n.similitud::numeric, 3)::float AS similitud,
  t.texto_buscar,
  t.clase_niza        AS clase_termino,
  u.id                AS usuario_id,
  u.email,
  u.nombre            AS usuario_nombre,
  u.plan_pago
FROM nuevas n
JOIN terminos_monitoreados t ON t.id = n.termino_id
JOIN usuarios u              ON u.id = t.usuario_id
ORDER BY n.similitud DESC;
`;

/**
 * Busca coincidencias para una marca recién ingresada y crea las alertas.
 *
 * @param {object} marca  Fila de marcas_dinapi ya guardada.
 * @param {string} marca.id
 * @param {string} marca.nombre_marca
 * @param {number|null} [marca.clase_niza]
 * @param {object} [opciones]
 * @param {import('pg').PoolClient} [opciones.client]  Para usar la misma
 *        transacción que insertó la marca (así no se pierde ninguna alerta).
 * @param {number} [opciones.umbral]  Similitud mínima (0 a 1). Por defecto 0.4.
 * @param {number} [opciones.umbralPalabra]  Mínimo para strict_word_similarity. Por defecto 0.5.
 * @returns {Promise<Array<object>>} Alertas nuevas creadas (vacío si no hubo).
 */
export async function generarAlertasParaMarca(marca, opciones = {}) {
  const {
    client = pool,
    umbral = UMBRAL_POR_DEFECTO,
    umbralPalabra = UMBRAL_PALABRA_POR_DEFECTO,
  } = opciones;

  if (!marca?.id || !marca?.nombre_marca?.trim()) {
    throw new Error('generarAlertasParaMarca: la marca necesita id y nombre_marca');
  }

  const { rows } = await client.query(SQL_BUSCAR_E_INSERTAR, [
    marca.id,
    marca.nombre_marca.trim(),
    marca.clase_niza ?? null,
    umbral,
    umbralPalabra,
    LARGO_MINIMO_PARCIAL,
  ]);

  return rows;
}

/**
 * Búsqueda inversa (usa los índices de marcas_dinapi): cuando un usuario
 * registra un término nuevo, muestra qué marcas ya existentes se le parecen.
 * Útil para la "búsqueda de anterioridad" antes de presentar una marca.
 */
export async function buscarMarcasSimilares(texto, { clase = null, umbral = UMBRAL_POR_DEFECTO, limite = 50 } = {}) {
  // Cada condición del primer bloque usa un índice (GIN trigramas o B-tree
  // fonético); el segundo bloque afina con el umbral exacto.
  const sql = `
    WITH b AS (
      SELECT normalizar_marca($1::text) AS texto,
             fonetica_es($1::text) AS fonetica
    )
    SELECT m.id, m.nro_expediente, m.nombre_marca, m.clase_niza, m.estado_tramite, m.fecha_ingreso,
           round(similarity(normalizar_marca(m.nombre_marca), b.texto)::numeric, 3)::float AS similitud,
           normalizar_marca(m.nombre_marca) ILIKE '%' || ${ESCAPAR_LIKE('b.texto')} || '%' AS contiene,
           (length(b.fonetica) >= 3 AND fonetica_es(m.nombre_marca) = b.fonetica) AS suena_igual
    FROM marcas_dinapi m, b
    WHERE ($2::int IS NULL OR m.clase_niza = $2)
      AND (
            normalizar_marca(m.nombre_marca) % b.texto
         OR normalizar_marca(m.nombre_marca) ILIKE '%' || ${ESCAPAR_LIKE('b.texto')} || '%'
         OR (length(b.fonetica) >= 3 AND fonetica_es(m.nombre_marca) = b.fonetica)
      )
      AND (
            similarity(normalizar_marca(m.nombre_marca), b.texto) > $3
         OR normalizar_marca(m.nombre_marca) ILIKE '%' || ${ESCAPAR_LIKE('b.texto')} || '%'
         OR fonetica_es(m.nombre_marca) = b.fonetica
      )
    ORDER BY similitud DESC
    LIMIT $4`;
  const { rows } = await pool.query(sql, [texto.trim(), clase, umbral, limite]);
  return rows;
}
