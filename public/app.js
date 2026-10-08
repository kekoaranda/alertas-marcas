// app.js - Página del cliente: ingreso, marcas vigiladas y alertas.
// Todo el texto que viene del servidor se pone con textContent (nunca innerHTML)
// para que un nombre de marca no pueda inyectar código en la página.

const $ = (selector) => document.querySelector(selector);

const TIPOS = {
  IDENTICA: 'Idéntica',
  PARCIAL: 'Contiene tu marca',
  ORTOGRAFICA: 'Se escribe parecido',
  FONETICA: 'Suena parecido',
};

async function api(metodo, ruta, cuerpo) {
  const opciones = { method: metodo, headers: {}, credentials: 'same-origin' };
  if (cuerpo !== undefined) {
    opciones.headers['Content-Type'] = 'application/json';
    opciones.body = JSON.stringify(cuerpo);
  }
  let respuesta;
  try {
    respuesta = await fetch(ruta, opciones);
  } catch {
    const err = new Error('Sin conexión a internet. Probá de nuevo en un rato.');
    err.sinConexion = true;
    throw err;
  }
  $('#sin-conexion').hidden = true;
  const datos = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) {
    const err = new Error(datos.error ?? 'Ocurrió un error');
    err.estado = respuesta.status;
    throw err;
  }
  return datos;
}

const datosForm = (form) => Object.fromEntries(new FormData(form).entries());
const fecha = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');

function el(etiqueta, texto, clase) {
  const nodo = document.createElement(etiqueta);
  if (texto !== undefined && texto !== null) nodo.textContent = texto;
  if (clase) nodo.className = clase;
  return nodo;
}

async function conBoton(form, trabajo) {
  const boton = form.querySelector('button[type=submit]');
  boton.disabled = true;
  try {
    await trabajo();
  } finally {
    // Sigue deshabilitado si el formulario quedó bloqueado (ej: límite del plan)
    boton.disabled = form.dataset.bloqueado === 'si';
  }
}

// ---------------------------------------------------------------------
// Acceso
// ---------------------------------------------------------------------
function mostrarPestana(cual) {
  const registro = cual === 'registro';
  $('#form-registro').hidden = !registro;
  $('#form-ingreso').hidden = registro;
  $('#tab-registro').classList.toggle('activa', registro);
  $('#tab-ingreso').classList.toggle('activa', !registro);
  $('#error-acceso').textContent = '';
}
$('#tab-ingreso').addEventListener('click', () => mostrarPestana('ingreso'));
$('#tab-registro').addEventListener('click', () => mostrarPestana('registro'));

for (const [form, ruta] of [
  [$('#form-ingreso'), '/api/ingreso'],
  [$('#form-registro'), '/api/registro'],
]) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    conBoton(form, async () => {
      try {
        await api('POST', ruta, datosForm(form));
        form.reset();
        await iniciar();
      } catch (err) {
        $('#error-acceso').textContent = err.message;
      }
    });
  });
}

$('#salir').addEventListener('click', async () => {
  await api('POST', '/api/salir', {}).catch(() => {});
  await iniciar();
});

// ---------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------
async function cargarCuenta() {
  const yo = await api('GET', '/api/yo');
  $('#usuario-nombre').textContent = yo.nombre;
  $('#plan').textContent =
    yo.limite === null
      ? `Plan ${yo.plan}: ${yo.usados} marcas`
      : `Plan ${yo.plan}: ${yo.usados} de ${yo.limite} marcas`;
  $('#recibir-avisos').checked = yo.recibir_avisos;
  const lleno = yo.limite !== null && yo.usados >= yo.limite;
  $('#form-termino').dataset.bloqueado = lleno ? 'si' : 'no';
  $('#form-termino button').disabled = lleno;
  $('#error-termino').textContent = lleno
    ? `Llegaste al máximo de tu plan ${yo.plan}. Quitá una marca o pasate a PREMIUM.`
    : '';
}

async function cargarTerminos() {
  const terminos = await api('GET', '/api/terminos');
  const lista = $('#lista-terminos');
  lista.replaceChildren();
  $('#sin-terminos').hidden = terminos.length > 0;
  for (const t of terminos) {
    const item = $('#tpl-termino').content.firstElementChild.cloneNode(true);
    item.querySelector('.t-texto').textContent = t.texto;
    item.querySelector('.t-clase').textContent = t.clase ? `Clase ${t.clase}` : 'Todas las clases';
    const insignia = item.querySelector('.t-alertas');
    if (t.alertas_pendientes > 0) {
      insignia.hidden = false;
      insignia.textContent = `${t.alertas_pendientes} alerta${t.alertas_pendientes === 1 ? '' : 's'}`;
    }
    item.querySelector('.t-borrar').addEventListener('click', async () => {
      if (!confirm(`¿Dejar de vigilar "${t.texto}"? También se borran sus alertas.`)) return;
      await api('DELETE', `/api/terminos/${t.id}`);
      await refrescar();
    });
    item.querySelector('.t-similares').addEventListener('click', () => verSimilares(t, item));
    lista.append(item);
  }
}

async function verSimilares(termino, item) {
  const caja = item.querySelector('.t-resultado');
  if (!caja.hidden) {
    caja.hidden = true;
    return;
  }
  caja.hidden = false;
  caja.replaceChildren(el('p', 'Buscando en la base de la DINAPI...', 'sutil'));
  try {
    const marcas = await api('GET', `/api/terminos/${termino.id}/similares`);
    if (!marcas.length) {
      caja.replaceChildren(el('p', 'No encontramos marcas parecidas ya presentadas.', 'sutil'));
      return;
    }
    const tabla = el('table', null, 'tabla');
    const encabezado = el('tr');
    for (const titulo of ['Marca', 'Clase', 'Expediente', 'Fecha', 'Parecido']) encabezado.append(el('th', titulo));
    tabla.append(el('thead'), el('tbody'));
    tabla.tHead.append(encabezado);
    for (const m of marcas) {
      const fila = el('tr');
      fila.append(
        celda('Marca', m.nombre_marca, m.estado_tramite),
        celda('Clase', m.clase_niza ?? '-'),
        celda('Expediente', m.nro_expediente),
        celda('Fecha', fecha(m.fecha_ingreso)),
        celda('Parecido', parecido(m))
      );
      tabla.tBodies[0].append(fila);
    }
    caja.replaceChildren(tabla);
  } catch (err) {
    caja.replaceChildren(el('p', err.message, 'error'));
  }
}

function parecido(m) {
  if (m.similitud >= 1) return 'Idéntica';
  if (m.contiene) return 'Contiene tu marca';
  if (m.suena_igual) return 'Suena parecido';
  return `Se escribe parecido (${Math.round(m.similitud * 100)}%)`;
}

function celda(titulo, principal, secundario) {
  const td = el('td');
  td.dataset.titulo = titulo;
  td.append(el('span', principal));
  if (secundario) {
    td.append(document.createElement('br'), el('span', secundario, 'chica'));
  }
  return td;
}

async function cargarAlertas() {
  const todas = $('#ver-todas').checked;
  const alertas = await api('GET', `/api/alertas?estado=${todas ? 'todas' : 'pendientes'}`);
  const contenedor = $('#alertas');
  contenedor.replaceChildren();
  $('#sin-alertas').hidden = alertas.length > 0;
  if (!alertas.length) return;

  const tabla = el('table', null, 'tabla');
  tabla.append(el('thead'), el('tbody'));
  const encabezado = el('tr');
  for (const titulo of ['Tu marca', 'Solicitud nueva', 'Clase', 'Expediente', 'Coincidencia', '']) {
    encabezado.append(el('th', titulo));
  }
  tabla.tHead.append(encabezado);

  for (const a of alertas) {
    const fila = el('tr', null, a.revisada ? 'alerta-revisada' : '');
    const titular = [a.titular, a.pais_titular && `(${a.pais_titular})`].filter(Boolean).join(' ');
    const boton = el('button', a.revisada ? 'Marcar pendiente' : 'Marcar revisada', 'enlace');
    boton.addEventListener('click', async () => {
      boton.disabled = true;
      await api('PATCH', `/api/alertas/${a.id}`, { revisada: !a.revisada });
      await refrescar();
    });
    const accion = el('td');
    accion.append(boton);
    fila.append(
      celda('Tu marca', a.tu_marca),
      celda('Solicitud', a.nombre_marca ?? '(solo logo)', titular),
      celda('Clase', a.clase_niza ?? '-'),
      celda('Expediente', a.nro_expediente, fecha(a.fecha_ingreso)),
      celda('Coincidencia', TIPOS[a.tipo_coincidencia] ?? a.tipo_coincidencia),
      accion
    );
    tabla.tBodies[0].append(fila);
  }
  contenedor.append(tabla);
}

$('#ver-todas').addEventListener('change', cargarAlertas);

$('#form-termino').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  conBoton(form, async () => {
    try {
      const datos = datosForm(form);
      await api('POST', '/api/terminos', { texto: datos.texto, clase: datos.clase || null });
      form.reset();
      $('#error-termino').textContent = '';
      await refrescar();
    } catch (err) {
      $('#error-termino').textContent = err.message;
    }
  });
});

$('#recibir-avisos').addEventListener('change', async (e) => {
  await api('PATCH', '/api/yo', { recibir_avisos: e.target.checked });
});

$('#form-password').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  conBoton(form, async () => {
    try {
      await api('POST', '/api/cambiar-password', datosForm(form));
      form.reset();
      $('#msg-password').textContent = 'Listo, contraseña cambiada.';
    } catch (err) {
      $('#msg-password').textContent = err.message;
    }
  });
});

// Opciones de clase de Niza 1 a 45
for (let clase = 1; clase <= 45; clase++) {
  $('#form-termino select').append(new Option(`Clase ${clase}`, String(clase)));
}

async function refrescar() {
  await Promise.all([cargarCuenta(), cargarTerminos(), cargarAlertas()]);
}

async function iniciar() {
  try {
    await cargarCuenta(); // si no hay sesión, falla acá con 401
    await Promise.all([cargarTerminos(), cargarAlertas()]);
    $('#vista-acceso').hidden = true;
    $('#vista-panel').hidden = false;
    $('#usuario').hidden = false;
  } catch (err) {
    if (err.sinConexion) {
      // Sin internet: se queda lo que ya está en pantalla y se reintenta al volver la conexión
      $('#sin-conexion').hidden = false;
      return;
    }
    if (err.estado !== 401) console.error(err);
    $('#vista-panel').hidden = true;
    $('#usuario').hidden = true;
    $('#vista-acceso').hidden = false;
  }
}

// ---------------------------------------------------------------------
// App instalable (PWA)
// ---------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => console.error('Service worker:', err));
}

// Chrome y Edge (PC y Android) avisan cuando se puede instalar: mostramos el botón.
// En iPhone se instala desde Safari con Compartir > "Agregar a inicio".
let pedidoInstalar = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  pedidoInstalar = e;
  $('#instalar').hidden = false;
});
$('#instalar').addEventListener('click', async () => {
  if (!pedidoInstalar) return;
  pedidoInstalar.prompt();
  await pedidoInstalar.userChoice;
  pedidoInstalar = null;
  $('#instalar').hidden = true;
});
window.addEventListener('appinstalled', () => {
  $('#instalar').hidden = true;
});

// Al volver la conexión, o al volver a la app después de un rato, se actualiza todo
window.addEventListener('online', iniciar);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#vista-panel').hidden) refrescar().catch(() => {});
});

iniciar();
