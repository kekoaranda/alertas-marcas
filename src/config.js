// config.js - Lectura de variables de entorno (.env).
// Una variable vacía (ej: "BOLETINES_PAGINA_URL=" copiado de .env.example)
// cuenta como no definida y se usa el valor por defecto.

/** Texto de la variable, o `porDefecto` si no existe o está vacía. */
export function env(nombre, porDefecto = undefined) {
  const valor = process.env[nombre]?.trim();
  return valor ? valor : porDefecto;
}

/** Número de la variable, o `porDefecto` si no existe, está vacía o no es un número. */
export function envNumero(nombre, porDefecto) {
  const valor = Number(env(nombre));
  return env(nombre) !== undefined && Number.isFinite(valor) ? valor : porDefecto;
}
