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
 * Formatea la clave privada de Google Service Account asegurando saltos de línea PEM válidos (líneas de 64 caracteres).
 */
function formatPrivateKey(rawKey) {
  if (!rawKey) return '';
  let str = rawKey.trim();

  // Eliminar comillas envolventes si fueron incluidas
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1).trim();
  }

  // Reemplazar saltos de línea escapados \n o \\n por newlines reales
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
        key: formatPrivateKey(creds.private_key),
        scopes: [
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/drive'
        ]
      });
    }
    return null;
  }

  return new JWT({
    email,
    key: formatPrivateKey(privateKey),
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ]
  });
}

/**
 * Lista recursivamente todos los archivos válidos explorando la estructura de 2 subdirectorios:
 * Ruteos LIVIANO (1qpXukDfaovrVltV74NL9WpBzr1Ig916z) -> Años (Ruteo Liviano 2026, 2025...) -> Meses (07. Julio 26, 06. Junio 26...) -> Archivos diarios
 */
async function listarArchivosCarpetaDriveRecursivo(rootFolderId = DEFAULT_DRIVE_FOLDER_ID) {
  const auth = getAuthClient();
  if (!auth) {
    console.log('[!] Google Service Account no configurada. No se puede listar la carpeta de Drive.');
    return [];
  }

  const drive = google.drive({ version: 'v3', auth });
  const archivosValidos = [];

  // Cola BFS de carpetas a explorar
  const queue = [{ id: rootFolderId, path: 'Ruteos LIVIANO' }];
  const carpetasVisitadas = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (carpetasVisitadas.has(current.id)) continue;
    carpetasVisitadas.add(current.id);

    try {
      let pageToken = null;
      do {
        const res = await drive.files.list({
          q: `'${current.id}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
          pageSize: 500,
          pageToken: pageToken
        });

        const items = res.data.files || [];
        pageToken = res.data.nextPageToken;

        for (const item of items) {
          if (item.mimeType === 'application/vnd.google-apps.folder') {
            // Es una subcarpeta (ej: 'Ruteo Liviano 2026', '07. Julio 26')
            queue.push({
              id: item.id,
              path: `${current.path} > ${item.name}`
            });
          } else {
            // Es un archivo diario; validar nombre (YYYY-MM-DD UTE TPH...)
            if (esNombreArchivoValido(item.name)) {
              archivosValidos.push({
                ...item,
                folderPath: current.path
              });
            }
          }
        }
      } while (pageToken);

    } catch (error) {
      console.error(`[!] Error explorando carpeta '${current.path}' (${current.id}):`, error.message);
    }
  }

  console.log(`[OK] Recorrido recursivo completado. Total archivos válidos en todos los años y meses: ${archivosValidos.length}`);
  return archivosValidos;
}

/**
 * Extrae las asignaciones ruteo (Lista 1 y Lista 2) desde todas las planillas válidas en todos los años/meses.
 */
async function extraerNovedadesDesdeDrive(rootFolderId = DEFAULT_DRIVE_FOLDER_ID) {
  const auth = getAuthClient();
  if (!auth) {
    return { success: false, error: 'Google Service Account credentials no disponibles' };
  }

  const archivosValidos = await listarArchivosCarpetaDriveRecursivo(rootFolderId);
  const choferesMap = cargarDbChoferes();
  let todasNovedades = [];

  for (const file of archivosValidos) {
    try {
      console.log(`[*] Leyendo planilla remota de Drive: [${file.folderPath}] ${file.name} (ID: ${file.id})...`);
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
    rootFolderId,
    totalArchivosValidos: archivosValidos.length,
    archivosProcesados: archivosValidos.map(f => ({ id: f.id, name: f.name, path: f.folderPath })),
    totalAsignaciones: todasNovedades.length,
    novedades: todasNovedades
  };
}

module.exports = {
  getAuthClient,
  listarArchivosCarpetaDrive: listarArchivosCarpetaDriveRecursivo,
  listarArchivosCarpetaDriveRecursivo,
  extraerNovedadesDesdeDrive
};
