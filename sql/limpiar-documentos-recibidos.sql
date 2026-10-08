-- =====================================================================
--  Limpieza (una sola vez): borra las filas que se cargaron por error desde
--  boletines de "Documentos Recibidos" (no son solicitudes de marcas).
--  Desde la versión del 07/10/2026 el procesador ya no los carga.
--
--  Hacer un respaldo antes:  pg_dump alertas_marcas > respaldo.sql
--  Ejecutar:                 npm run db:limpiar-documentos
--
--  Es seguro: identifica las filas por el momento exacto en que se cargó cada
--  boletín de documentos (guardado en boletines_procesados) y solo borra si
--  la cantidad coincide con la que ese boletín cargó. Si no coincide, no
--  borra nada y muestra un error. Las alertas de esas filas se borran solas.
-- =====================================================================
DO $$
DECLARE
  esperadas INT;
  borradas  INT;
BEGIN
  SELECT coalesce(sum((resumen->>'nuevas')::int), 0) INTO esperadas
  FROM boletines_procesados
  WHERE url ~* 'documentos[-_. ]*recibidos';

  WITH borrado AS (
    DELETE FROM marcas_dinapi m
    USING boletines_procesados b
    WHERE b.url ~* 'documentos[-_. ]*recibidos'
      AND m.cargado_el BETWEEN (b.resumen->>'inicio')::timestamptz
                           AND (b.resumen->>'fin')::timestamptz
    RETURNING 1
  )
  SELECT count(*) INTO borradas FROM borrado;

  IF borradas <> esperadas THEN
    RAISE EXCEPTION 'Se iban a borrar % filas pero los boletines de documentos cargaron %. No se borró nada.',
      borradas, esperadas;
  END IF;

  DELETE FROM boletines_procesados WHERE url ~* 'documentos[-_. ]*recibidos';
  RAISE NOTICE 'Listo: % filas de Documentos Recibidos borradas.', borradas;
END
$$;
