// hacerAdmin.js - Da (o quita) permiso de administrador a una cuenta ya creada.
//
// Uso:  npm run admin -- cliente@ejemplo.com           (dar permiso)
//       npm run admin -- cliente@ejemplo.com --quitar  (quitar permiso)
//
// La cuenta tiene que existir: primero se registra en la página.
import { query, cerrarPool } from './db.js';

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase();
const darlo = !args.includes('--quitar');

if (!email) {
  console.error('Falta el email. Uso: npm run admin -- cliente@ejemplo.com [--quitar]');
  process.exit(1);
}

try {
  const { rows } = await query(
    'UPDATE usuarios SET es_admin = $2, habilitado = habilitado OR $2 WHERE lower(email) = $1 RETURNING nombre',
    [email, darlo]
  );
  if (!rows.length) {
    console.error(`No hay ninguna cuenta con el email ${email}. Primero registrala en la página.`);
    process.exitCode = 1;
  } else {
    console.log(`${rows[0].nombre} (${email}) ${darlo ? 'ahora es administrador' : 'ya no es administrador'}.`);
  }
} finally {
  await cerrarPool();
}
