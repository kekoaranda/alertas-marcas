-- =====================================================================
--  ALERTAS DE MARCAS DINAPI - Esquema de base de datos (PostgreSQL 13+)
--  Se puede ejecutar en pgAdmin, DBeaver o con: npm run db:schema
--  Es seguro ejecutarlo varias veces: no borra datos.
-- =====================================================================

-- 1) Extensiones y funciones ------------------------------------------
-- pg_trgm: similitud de texto por trigramas (similarity, operador %).
-- No se usa fuzzystrmatch: su metaphone() sigue reglas del inglés.
-- En su lugar está fonetica_es() (más abajo), con reglas del español.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- gen_random_uuid() ya viene incluida en PostgreSQL 13 o superior.

-- Normaliza un nombre para compararlo: minúsculas, sin tildes ni diéresis,
-- ñ como n, sin la marca "(SLOGAN)" y espacios simples. Así "Kurupí" y
-- "KURUPI" cuentan como idénticas.
-- Es IMMUTABLE para poder usarla dentro de índices.
CREATE OR REPLACE FUNCTION normalizar_marca(texto TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT trim(regexp_replace(
           regexp_replace(
             lower(translate(texto,
               'ÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛÇáéíóúüñàèìòùâêîôûç',
               'AEIOUUNAEIOUAEIOUCaeiouunaeiouaeiouc')),
             '\(slogan\)', '', 'g'),   -- la DINAPI agrega "(SLOGAN)" al nombre
           '\s+', ' ', 'g'))
$$;

-- Código fonético para nombres en español (y Guaraní básico).
-- Dos nombres que "suenan igual" dan el mismo código:
--   Tigo = Tygo, Vaca = Baca, Zapatería = Sapatería, Quesos = Kesos,
--   Llave = Yave, Gente = Jente, Hielo = Yelo, Kurupí = Kurupy, Pilsen = Pil Sen.
CREATE OR REPLACE FUNCTION fonetica_es(texto TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
AS $$
DECLARE
  s TEXT := normalizar_marca(texto);
BEGIN
  s := regexp_replace(s, '[^a-z]', '', 'g');        -- solo letras, sin espacios
  s := replace(s, 'ch', 'X');                       -- ch se conserva (marca temporal X)
  s := replace(s, 'ph', 'f');
  s := replace(s, 'll', 'y');                       -- llave = yave
  s := regexp_replace(s, 'hi([aeou])', 'y\1', 'g'); -- hielo = yelo
  s := regexp_replace(s, 'qu([ei])', 'k\1', 'g');   -- queso = keso
  s := regexp_replace(s, 'gu([ei])', 'G\1', 'g');   -- guerra: g suave
  s := regexp_replace(s, 'g([ei])', 'j\1', 'g');    -- gente = jente
  s := replace(s, 'G', 'g');
  s := regexp_replace(s, 'c([ei])', 's\1', 'g');    -- cielo = sielo
  s := translate(s, 'cqzvwh', 'kksbu');             -- c=k, z=s, v=b, h muda
  s := replace(s, 'x', 'ks');
  s := replace(s, 'X', 'ch');
  s := regexp_replace(s, 'y([aeiou])', 'Y\1', 'g'); -- y consonante (yerba)
  s := replace(s, 'y', 'i');                        -- y vocal (Tygo, Kurupy)
  s := replace(s, 'Y', 'y');
  s := regexp_replace(s, '(.)\1+', '\1', 'g');      -- letras dobles: rr = r
  RETURN s;
END
$$;

-- 2) Tablas ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS usuarios (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT NOT NULL,
    nombre      TEXT NOT NULL,
    plan_pago   TEXT NOT NULL DEFAULT 'FREE'
                CHECK (plan_pago IN ('FREE', 'PREMIUM')),
    creado_el   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Email único sin importar mayúsculas/minúsculas
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_email_unico
    ON usuarios (lower(email));

CREATE TABLE IF NOT EXISTS terminos_monitoreados (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id    UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    texto_buscar  TEXT NOT NULL CHECK (length(trim(texto_buscar)) > 0),
    -- Clase de Niza (1 a 45). NULL = vigilar en todas las clases.
    clase_niza    INT CHECK (clase_niza BETWEEN 1 AND 45),
    creado_el     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS terminos_usuario_idx
    ON terminos_monitoreados (usuario_id);

CREATE TABLE IF NOT EXISTS marcas_dinapi (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nro_expediente  TEXT NOT NULL UNIQUE,
    nombre_marca    TEXT NOT NULL,
    clase_niza      INT CHECK (clase_niza BETWEEN 1 AND 45),
    estado_tramite  TEXT,
    fecha_ingreso   DATE,
    cargado_el      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Datos extra que trae el boletín real de la DINAPI.
-- (ADD COLUMN IF NOT EXISTS: se puede aplicar sobre una base ya creada)
ALTER TABLE marcas_dinapi
    ADD COLUMN IF NOT EXISTS tipo_signo        TEXT,  -- D denominativa, M mixta, F figurativa
    ADD COLUMN IF NOT EXISTS titular           TEXT,
    ADD COLUMN IF NOT EXISTS pais_titular      TEXT,
    ADD COLUMN IF NOT EXISTS agente            TEXT,
    ADD COLUMN IF NOT EXISTS matricula_agente  TEXT,
    ADD COLUMN IF NOT EXISTS tipo_tramite      TEXT,  -- Registro de Marca / Renovación de Marca
    ADD COLUMN IF NOT EXISTS referencia        TEXT,  -- en renovaciones, el registro anterior
    ADD COLUMN IF NOT EXISTS origen            TEXT;  -- archivo o URL del boletín de donde salió
-- Las marcas figurativas (solo logo) llegan sin denominación
ALTER TABLE marcas_dinapi ALTER COLUMN nombre_marca DROP NOT NULL;

CREATE TABLE IF NOT EXISTS alertas (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    termino_id         UUID NOT NULL REFERENCES terminos_monitoreados(id) ON DELETE CASCADE,
    marca_dinapi_id    UUID NOT NULL REFERENCES marcas_dinapi(id) ON DELETE CASCADE,
    -- Por qué saltó la alerta: IDENTICA, PARCIAL, ORTOGRAFICA o FONETICA
    tipo_coincidencia  TEXT NOT NULL,
    -- Valor de similarity() entre 0 y 1, para ordenar por gravedad
    similitud          REAL NOT NULL DEFAULT 0,
    revisada           BOOLEAN NOT NULL DEFAULT false,
    creado_el          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Nunca dos alertas iguales para el mismo término y la misma marca
    CONSTRAINT alertas_unica UNIQUE (termino_id, marca_dinapi_id)
);
CREATE INDEX IF NOT EXISTS alertas_pendientes_idx
    ON alertas (termino_id) WHERE revisada = false;
CREATE INDEX IF NOT EXISTS alertas_marca_idx
    ON alertas (marca_dinapi_id);

-- Avisos por email (src/notificador.js)
ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS recibir_avisos BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE alertas
    ADD COLUMN IF NOT EXISTS notificada_el TIMESTAMPTZ;  -- NULL = falta enviar el email
CREATE INDEX IF NOT EXISTS alertas_sin_notificar_idx
    ON alertas (creado_el) WHERE notificada_el IS NULL;

-- Boletines ya cargados desde la página de la DINAPI (para no repetirlos).
-- No es una de las 4 tablas del negocio: es control interno del cargador.
CREATE TABLE IF NOT EXISTS boletines_procesados (
    url           TEXT PRIMARY KEY,
    ok            BOOLEAN NOT NULL,
    resumen       JSONB,
    procesado_el  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3) Índices de búsqueda por similitud ---------------------------------
-- Trigramas sobre el nombre normalizado: aceleran similarity() y el operador
-- %, ILIKE '%texto%' y word_similarity. Las consultas usan la misma expresión
-- normalizar_marca(columna) para que el índice se aproveche.
-- Se usa GIN y no GIST: busca más rápido (sobre todo con ILIKE); a cambio
-- inserta algo más lento, lo cual no importa porque los boletines se cargan
-- una vez y se consultan muchas.
CREATE INDEX IF NOT EXISTS marcas_nombre_trgm
    ON marcas_dinapi USING GIN (normalizar_marca(nombre_marca) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS terminos_texto_trgm
    ON terminos_monitoreados USING GIN (normalizar_marca(texto_buscar) gin_trgm_ops);

-- Índices fonéticos: se compara fonetica_es(...) con "=", así que un índice
-- B-tree sobre esa expresión lo hace instantáneo.
CREATE INDEX IF NOT EXISTS terminos_texto_fonetica_idx
    ON terminos_monitoreados (fonetica_es(texto_buscar));

CREATE INDEX IF NOT EXISTS marcas_nombre_fonetica_idx
    ON marcas_dinapi (fonetica_es(nombre_marca));

-- Para listar los ingresos recientes por clase
CREATE INDEX IF NOT EXISTS marcas_clase_fecha_idx
    ON marcas_dinapi (clase_niza, fecha_ingreso DESC);

-- 4) Cuentas de clientes (página web, src/servidor.js) ------------------
-- Contraseña con bcrypt. NULL = cuenta creada a mano, sin acceso a la web.
ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Sesiones de la página web. Se guarda solo el hash del token de la cookie:
-- si alguien lee la base, no puede usar las sesiones.
CREATE TABLE IF NOT EXISTS sesiones (
    token_hash  TEXT PRIMARY KEY,
    usuario_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    creado_el   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expira_el   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sesiones_usuario_idx ON sesiones (usuario_id);
CREATE INDEX IF NOT EXISTS sesiones_expira_idx  ON sesiones (expira_el);

-- 5) Administración (sección Admin de la página) -------------------------
-- es_admin: puede ver y manejar todas las cuentas desde la página.
-- habilitado = false: la cuenta no puede entrar, no genera alertas nuevas ni
-- recibe avisos. No se borra nada: al reactivarla vuelve como estaba.
ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS es_admin   BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS habilitado BOOLEAN NOT NULL DEFAULT true;
