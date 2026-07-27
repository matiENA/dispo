const { extraerNovedadesDesdeDrive } = require('./driveService');
const { guardarEnCsvLocal, inyectarEnGoogleSheets } = require('./sheetsService');

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '1qpXukDfaovrVltV74NL9WpBzr1Ig916z';
const INTERVAL_MINUTES = parseInt(process.env.EXTRACTION_INTERVAL_MINUTES || '5', 10);

let timerId = null;
let triggerState = {
  activo: false,
  intervaloMinutos: INTERVAL_MINUTES,
  ultimaEjecucion: null,
  proximaEjecucion: null,
  totalAsignacionesExtraidas: 0,
  ultimoEstado: 'PENDIENTE',
  ultimoError: null
};

/**
 * Ejecuta el ciclo completo del trigger:
 * 1. Extrae ruteos desde Google Drive (todos los años/meses)
 * 2. Guarda el respaldo local (CSV / JSON)
 * 3. Inyecta en la pestaña sheet - DISPO del Google Sheet objetivo
 */
async function ejecutarExtraccionTrigger() {
  const inicio = new Date().toISOString();
  console.log(`\n=======================================================`);
  console.log(`[⏰ TRIGGER] Inicio de extracción automática: ${inicio}`);
  console.log(`=======================================================`);

  triggerState.ultimoEstado = 'EN_PROGRESO';

  try {
    const resDrive = await extraerNovedadesDesdeDrive(DRIVE_FOLDER_ID);

    if (!resDrive.success) {
      triggerState.ultimoEstado = 'ERROR';
      triggerState.ultimoError = resDrive.error || 'Error conectando a Google Drive';
      console.error(`[!] Trigger falló: ${triggerState.ultimoError}`);
      return triggerState;
    }

    const novedades = resDrive.novedades || [];
    triggerState.totalAsignacionesExtraidas = novedades.length;

    // Respaldo local
    guardarEnCsvLocal(novedades);

    // Inyección remota en Google Sheet target
    const inyectado = await inyectarEnGoogleSheets(novedades);

    triggerState.ultimaEjecucion = new Date().toISOString();
    triggerState.ultimoEstado = 'EXITO';
    triggerState.ultimoError = null;

    if (triggerState.activo) {
      const nextDate = new Date(Date.now() + triggerState.intervaloMinutos * 60 * 1000);
      triggerState.proximaEjecucion = nextDate.toISOString();
    }

    console.log(`[✔ TRIGGER] Extracción completada. ${novedades.length} asignaciones inyectadas.`);
    return triggerState;

  } catch (error) {
    triggerState.ultimoEstado = 'ERROR';
    triggerState.ultimoError = error.message;
    console.error(`[!] Error inesperado en trigger de extracción:`, error.message);
    return triggerState;
  }
}

/**
 * Inicia el temporizador de extracción recurrente.
 */
function startTrigger(minutos = INTERVAL_MINUTES) {
  if (timerId) {
    clearInterval(timerId);
  }

  triggerState.activo = true;
  triggerState.intervaloMinutos = minutos;

  const ms = minutos * 60 * 1000;
  const nextDate = new Date(Date.now() + ms);
  triggerState.proximaEjecucion = nextDate.toISOString();

  timerId = setInterval(() => {
    ejecutarExtraccionTrigger();
  }, ms);

  console.log(`[🚀 TRIGGER] Trigger automático iniciado. Frecuencia: cada ${minutos} minuto(s). Próxima corrida: ${triggerState.proximaEjecucion}`);
  return triggerState;
}

/**
 * Detiene el temporizador automático.
 */
function stopTrigger() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
  triggerState.activo = false;
  triggerState.proximaEjecucion = null;
  triggerState.ultimoEstado = 'DETENIDO';
  console.log(`[🛑 TRIGGER] Trigger automático detenido.`);
  return triggerState;
}

/**
 * Retorna el estado actual del trigger.
 */
function getTriggerStatus() {
  return triggerState;
}

module.exports = {
  ejecutarExtraccionTrigger,
  startTrigger,
  stopTrigger,
  getTriggerStatus
};
