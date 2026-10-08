-- Datos de prueba: 2 usuarios y algunos términos vigilados.
-- Se puede ejecutar varias veces (no duplica).
INSERT INTO usuarios (email, nombre, plan_pago) VALUES
  ('abogada@ejemplo.com.py', 'Estudio Jurídico Demo', 'PREMIUM'),
  ('emprendedor@ejemplo.com.py', 'Emprendedor Demo', 'FREE')
ON CONFLICT DO NOTHING;

INSERT INTO terminos_monitoreados (usuario_id, texto_buscar, clase_niza)
SELECT u.id, t.texto, t.clase
FROM (VALUES
  ('abogada@ejemplo.com.py',     'Kurupí',       30),
  ('abogada@ejemplo.com.py',     'Pilsen',       32),
  ('abogada@ejemplo.com.py',     'Tigo',         NULL),
  ('emprendedor@ejemplo.com.py', 'Mburucuyá',    43),
  ('emprendedor@ejemplo.com.py', 'Chipa Barrero', 30),
  -- Términos pensados para el boletín real (ejemplos/boletin-real-23-27-febrero-2026.csv)
  ('abogada@ejemplo.com.py',     'Chanel',       NULL),
  ('abogada@ejemplo.com.py',     'Destructor',   5),
  ('abogada@ejemplo.com.py',     'Mozana',       41),
  ('abogada@ejemplo.com.py',     'Bespa',        1),
  ('emprendedor@ejemplo.com.py', 'Durmax',       1),
  ('emprendedor@ejemplo.com.py', 'Doña Rosa',    35),
  ('emprendedor@ejemplo.com.py', 'Kalm',         20),
  ('emprendedor@ejemplo.com.py', 'Skynative',    3)
) AS t(email, texto, clase)
JOIN usuarios u ON lower(u.email) = t.email
WHERE NOT EXISTS (
  SELECT 1 FROM terminos_monitoreados x
  WHERE x.usuario_id = u.id AND x.texto_buscar = t.texto
);
