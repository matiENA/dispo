const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const {
  parsearMatrizRuteo,
  cargarDbChoferes,
  esNombreArchivoValido
} = require('./ruteoExtractor');

const DEFAULT_RUTEO_DIR = path.join(__dirname, '..');
const DEFAULT_DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '1qpXukDfaovrVltV74NL9WpBzr1Ig916z';

/**
 * Autentica y obtiene el objeto JWT para Google APIs.
 */
function getAuthClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!email || !privateKey) {
    const credsPath = path.join(DEFAULT_RUTEO_DIR, 'credentials.json');
    if (fs.existsSync(credsPath)) {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      return new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: [
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/drive'
        ]
      });
    }
    return null;
  }

  privateKey = privateKey.replace(/\\n/g, '\n');
  return new JWT({
    email,
    key: privateKey,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ]
  });
}

/**
 * Lista todos los archivos de la carpeta objetivo de Google Drive (1qpXukDfaovrVltV74NL9WpBzr1Ig916z)
 * aplicando los filtros de validación (YYYY-MM-DD UTE TPH, ignora copias e históricos).
 */
async function listarArchivosCarpetaDrive(folderId = DEFAULT_DRIVE_FOLDER_ID) {
  const auth = getAuthClient();
  if (!auth) {
    console.log('[!] Google Service Account no configurada. No se puede listar la carpeta de Drive.');
    return [];
  }

  const drive = google.drive({ version: 'v3', auth });

  try {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, modifiedTime)',
      pageSize: 100
    });

    const files = res.data.files || [];
    console.log(`[*] Encontrados ${files.length} archivos en la carpeta de Google Drive ${folderId}`);

    // Aplicar regla de validación de nombres
    const archivosValidos = files.filter(f => esNombreArchivoValido(f.name));
    console.log(`[*] Archivos válidos tras filtrado (${archivosValidos.length}):`, archivosValidos.map(f => f.name));

    return archivosValidos;

  } catch (error) {
    console.error('[!] Error consultando Google Drive API:', error.message);
    return [];
  }
}

/**
 * Extrae las asignaciones ruteo (Lista 1 y Lista 2) desde todas las planillas válidas de la carpeta de Drive.
 */
async function extraerNovedadesDesdeDrive(folderId = DEFAULT_DRIVE_FOLDER_ID) {
  const auth = getAuthClient();
  if (!auth) {
    return { success: false, error: 'Google Service Account credentials no disponibles' };
  }

  const archivosValidos = await listarArchivosCarpetaDrive(folderId);
  const choferesMap = cargarDbChoferes();
  let todasNovedades = [];

  for (const file of archivosValidos) {
    try {
      console.log(`[*] Leyendo planilla remota de Drive: ${file.name} (ID: ${file.id})...`);
      const doc = new GoogleSpreadsheet(file.id, auth);
      await doc.loadInfo();

      // Leer la primera hoja de cálculo o hoja de ruteo
      const sheet = doc.sheetsByIndex[0];
      if (!sheet) continue;

      const rows = await sheet.getRows();
      // Convertir a matriz de cadenas similar al CSV
      const matrix = [];

      // Fila 1 (Fecha)
      const headerRow = sheet.headerValues || [];
      matrix.push(headerRow);

      // Filas de datos
      for (const row of rows) {
        matrix.push(row._rawRow || Object.values(row.toObject() || {}));
      }

      const novs = parsearMatrizRuteo(matrix, file.name, choferesMap);
      todasNovedades = todasNovedades.concat(novs);

    } catch (err) {
      console.error(`[!] Error procesando archivo ${file.name}:`, err.message);
    }
  }

  return {
    success: true,
    folderId,
    archivosProcesados: archivosValidos.map(f => ({ id: f.id, name: f.name })),
    totalAsignaciones: todasNovedades.length,
    novedades: todasNovedades
  };
}

module.exports = {
  getAuthClient,
  listarArchivosCarpetaDrive,
  extraerNovedadesDesdeDrive
};
