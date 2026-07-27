const fs = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc';
const SHEET_DISPO_NAME = 'DISPO'; // Pestaña GID 625701060
const SHEET_DISPO_ALT_NAME = 'sheet - DISPO';
const DEFAULT_RUTEO_DIR = path.join(__dirname, '..');
const DISPO_CSV_FILE = path.join(DEFAULT_RUTEO_DIR, 'sheet - DISPO.csv');
const DISPO_JSON_FILE = path.join(DEFAULT_RUTEO_DIR, 'dispo_novedades.json');

// Memoria local de novedades para servicio sin estado persistente
let memoriaNovedades = [];

/**
 * Inyecta las asignaciones procesadas en el CSV local y guarda el archivo JSON.
 */
function guardarEnCsvLocal(novedades, outputCsv = DISPO_CSV_FILE) {
  const headers = ['ID_NOVEDAD', 'CHOFER_ID', 'CHOFER_NOMBRE', 'TERMINAL', 'FECHA_ISO', 'FECHA_OBJETIVO', 'HORARIO', 'LISTA_ORIGEN', 'DETALLE', 'ESTADO_RECEPCION'];
  
  const rows = novedades.map(n => [
    n.id,
    n.chofer_id,
    `"${(n.nom || '').replace(/"/g, '""')}"`,
    `"${(n.terminal || '').replace(/"/g, '""')}"`,
    n.fecha_iso,
    n.fecha_objetivo,
    n.horario,
    n.lista_origen,
    `"${(n.detalle || '').replace(/"/g, '""')}"`,
    n.estado_recepcion || 'PENDIENTE'
  ]);

  const content = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  fs.writeFileSync(outputCsv, content, 'utf-8');
  fs.writeFileSync(DISPO_JSON_FILE, JSON.stringify(novedades, null, 2), 'utf-8');
  memoriaNovedades = novedades;
  console.log(`[OK] Inyectadas ${novedades.length} asignaciones en archivo local ${outputCsv} y JSON ${DISPO_JSON_FILE}`);
}

/**
 * Formatea la clave privada de Google Service Account asegurando saltos de línea PEM válidos (líneas de 64 caracteres).
 */
function formatPrivateKey(rawKey) {
  if (!rawKey) return '';
  let str = rawKey.trim();

  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1).trim();
  }

  str = str.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r/g, '');

  const header = '-----BEGIN PRIVATE KEY-----';
  const footer = '-----END PRIVATE KEY-----';

  if (str.includes(header) && str.includes(footer)) {
    let body = str
      .replace(header, '')
      .replace(footer, '')
      .replace(/\s+/g, '');

    const lines = body.match(/.{1,64}/g) || [body];
    return `${header}\n${lines.join('\n')}\n${footer}\n`;
  }

  return str.trim();
}

/**
 * Inicializa y autentica el cliente de Google Sheets.
 */
async function getGoogleSheetDoc() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!email || !privateKey) {
    // Intentar cargar credenciales desde credentials.json si existe
    const credsPath = path.join(DEFAULT_RUTEO_DIR, 'credentials.json');
    if (fs.existsSync(credsPath)) {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      return new GoogleSpreadsheet(SPREADSHEET_ID, new JWT({
        email: creds.client_email,
        key: formatPrivateKey(creds.private_key),
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      }));
    }
    return null;
  }

  const serviceAccountAuth = new JWT({
    email,
    key: formatPrivateKey(privateKey),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
}

/**
 * Inyecta las asignaciones procesadas en la pestaña DISPO (GID 625701060) del Google Sheet target.
 */
async function inyectarEnGoogleSheets(novedades) {
  try {
    const doc = await getGoogleSheetDoc();
    if (!doc) {
      console.log('[!] Google Service Account no configurada en env/credentials.json. Inyección solo local realizada.');
      return false;
    }

    await doc.loadInfo();
    
    // Buscar por GID 625701060 o por nombre DISPO
    let sheet = doc.sheetsById[625701060] || doc.sheetsByTitle[SHEET_DISPO_NAME] || doc.sheetsByTitle[SHEET_DISPO_ALT_NAME];
    
    if (!sheet) {
      sheet = await doc.addSheet({ title: SHEET_DISPO_NAME, headerValues: [
        'ID_NOVEDAD', 'CHOFER_ID', 'CHOFER_NOMBRE', 'TERMINAL',
        'FECHA_ISO', 'FECHA_OBJETIVO', 'HORARIO', 'LISTA_ORIGEN', 'DETALLE', 'ESTADO_RECEPCION', 'TIMESTAMP_FEEDBACK', 'JSON_PAYLOAD'
      ] });
    } else {
      // Establecer cabeceras si la pestaña no las tiene
      await sheet.setHeaderRow([
        'ID_NOVEDAD', 'CHOFER_ID', 'CHOFER_NOMBRE', 'TERMINAL',
        'FECHA_ISO', 'FECHA_OBJETIVO', 'HORARIO', 'LISTA_ORIGEN', 'DETALLE', 'ESTADO_RECEPCION', 'TIMESTAMP_FEEDBACK', 'JSON_PAYLOAD'
      ]);
      await sheet.clearRows();
    }

    const rowsToAdd = novedades.map(n => ({
      'ID_NOVEDAD': n.id,
      'CHOFER_ID': n.chofer_id,
      'CHOFER_NOMBRE': n.nom,
      'TERMINAL': n.terminal,
      'FECHA_ISO': n.fecha_iso,
      'FECHA_OBJETIVO': n.fecha_objetivo,
      'HORARIO': n.horario,
      'LISTA_ORIGEN': n.lista_origen,
      'DETALLE': n.detalle,
      'ESTADO_RECEPCION': n.estado_recepcion || 'PENDIENTE',
      'TIMESTAMP_FEEDBACK': n.timestamp_feedback || '',
      'JSON_PAYLOAD': JSON.stringify(n)
    }));

    await sheet.addRows(rowsToAdd);
    console.log(`[OK] Inyectadas ${novedades.length} asignaciones JSON en Google Sheet '${sheet.title}' (GID ${sheet.sheetId}) de ${SPREADSHEET_ID}`);
    return true;

  } catch (err) {
    console.error('[!] Error en inyectarEnGoogleSheets:', err.message);
    return false;
  }
}

/**
 * Registra el feedback del chofer (👍 CONFIRMADO / 👎 RECHAZADO)
 */
async function registrarFeedbackChofer(novedadId, choferId, estadoFeedback) {
  const timestamp = new Date().toISOString();

  // Actualizar en memoria local / JSON
  let novedad = memoriaNovedades.find(n => n.id === novedadId || n.chofer_id === choferId);
  if (novedad) {
    novedad.estado_recepcion = estadoFeedback; // 'CONFIRMADO' o 'RECHAZADO'
    novedad.timestamp_feedback = timestamp;
    guardarEnCsvLocal(memoriaNovedades);
  }

  // Actualizar en Google Sheets si está disponible
  try {
    const doc = await getGoogleSheetDoc();
    if (doc) {
      await doc.loadInfo();
      const sheet = doc.sheetsByTitle[SHEET_DISPO_NAME];
      if (sheet) {
        const rows = await sheet.getRows();
        for (const r of rows) {
          if (r.get('ID_NOVEDAD') === novedadId || r.get('CHOFER_ID') === choferId) {
            r.set('ESTADO_RECEPCION', estadoFeedback);
            r.set('TIMESTAMP_FEEDBACK', timestamp);
            await r.save();
            break;
          }
        }
      }
    }
  } catch (e) {
    console.error('[!] Error actualizando feedback en Google Sheets:', e.message);
  }

  return {
    success: true,
    novedadId,
    choferId,
    estado_recepcion: estadoFeedback,
    timestamp
  };
}

/**
 * Realiza el chequeo de recepción (ID, Nombre, Recepción Check).
 */
function realizarRecepcionCheck() {
  if (fs.existsSync(DISPO_JSON_FILE)) {
    try {
      memoriaNovedades = JSON.parse(fs.readFileSync(DISPO_JSON_FILE, 'utf-8'));
    } catch (e) {}
  }

  return memoriaNovedades.map(n => ({
    id: n.id,
    chofer_id: n.chofer_id,
    nombre: n.nom,
    terminal: n.terminal,
    fecha_objetivo: n.fecha_objetivo,
    horario: n.horario,
    estado_recepcion: n.estado_recepcion || 'PENDIENTE',
    recepcion_check: (n.estado_recepcion === 'CONFIRMADO')
  }));
}

module.exports = {
  guardarEnCsvLocal,
  inyectarEnGoogleSheets,
  registrarFeedbackChofer,
  realizarRecepcionCheck
};
