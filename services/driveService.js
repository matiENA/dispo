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
 * Lista recursivamente todos los archivos válidos explorando la estructura de subdirectorios:
 * Ruteos LIVIANO (1qpXukDfaovrVltV74NL9WpBzr1Ig916z) -> Años (Ruteo Liviano 2026...) -> Meses (07. Julio 26...) -> Archivos diarios
 */
async function listarArchivosCarpetaDriveRecursivo(rootFolderId = DEFAULT_DRIVE_FOLDER_ID) {
  const auth = getAuthClient();
  if (!auth) {
    console.log('[!] Google Service Account no configurada. No se puede listar la carpeta de Drive.');
    return [];
  }

  let accessToken = null;
  try {
    const tokens = await auth.authorize();
    accessToken = tokens.access_token;
  } catch (authErr) {
    console.error('[!] Error de autenticación JWT de Google Service Account:', authErr.message);
    return [];
  }

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
        let url = `https://www.googleapis.com/drive/v3/files?q=%27${current.id}%27+in+parents+and+trashed%3Dfalse&pageSize=500&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=nextPageToken,files(id,name,mimeType,modifiedTime)`;
        if (pageToken) {
          url += `&pageToken=${encodeURIComponent(pageToken)}`;
        }

        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error ? errData.error.message : `HTTP ${response.status}`);
        }

        const data = await response.json();
        const items = data.files || [];
        pageToken = data.nextPageToken;

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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Extrae las asignaciones ruteo (Lista 1 y Lista 2) desde planillas de Drive.
 * Por defecto lee únicamente 1 SOLO ARCHIVO (el del día actual o el más reciente) para evitar cuotas [429].
 */
async function extraerNovedadesDesdeDrive(rootFolderId = DEFAULT_DRIVE_FOLDER_ID, fechaFiltro = null) {
  const auth = getAuthClient();
  if (!auth) {
    return { success: false, error: 'Google Service Account credentials no disponibles' };
  }

  const archivosValidos = await listarArchivosCarpetaDriveRecursivo(rootFolderId);
  const choferesMap = cargarDbChoferes();
  let todasNovedades = [];

  if (archivosValidos.length === 0) {
    return {
      success: true,
      rootFolderId,
      totalArchivosValidos: 0,
      archivosProcesados: [],
      totalAsignaciones: 0,
      novedades: []
    };
  }

  // Filtrar objetivos
  let archivosAProcesar = archivosValidos;

  if (fechaFiltro) {
    if (fechaFiltro === 'today' || fechaFiltro === 'hoy') {
      const nowStr = new Date().toISOString().split('T')[0];
      archivosAProcesar = archivosValidos.filter(f => f.name.includes(nowStr));
      if (archivosAProcesar.length === 0) {
        // Fallback al archivo más reciente si no hay uno exacto con la fecha de hoy
        archivosAProcesar = [archivosValidos[0]];
      }
    } else {
      // Buscar por fecha específica YYYY-MM-DD
      archivosAProcesar = archivosValidos.filter(f => f.name.includes(fechaFiltro));
      if (archivosAProcesar.length === 0) {
        archivosAProcesar = [archivosValidos[0]];
      }
    }
  } else {
    // Modo de uso habitual por defecto: LEER SOLO 1 ARCHIVO AL DÍA (el más reciente)
    archivosAProcesar = [archivosValidos[0]];
  }

  console.log(`[*] Modo optimizado activo: Leyendo ${archivosAProcesar.length} archivo(s) objetivo (de ${archivosValidos.length} disponibles)...`);

  let accessToken = null;
  try {
    const tokens = await auth.authorize();
    accessToken = tokens.access_token;
  } catch (authErr) {
    console.error('[!] Error de autenticación JWT:', authErr.message);
    return { success: false, error: authErr.message };
  }

  for (let i = 0; i < archivosAProcesar.length; i++) {
    const file = archivosAProcesar[i];
    try {
      console.log(`[*] Leyendo planilla remota [${i + 1}/${archivosAProcesar.length}]: [${file.folderPath}] ${file.name} (ID: ${file.id})...`);
      
      const sheetsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${file.id}/values/A1:Z100?valueRenderOption=FORMATTED_VALUE`;
      const response = await fetch(sheetsUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error ? errData.error.message : `HTTP ${response.status}`);
      }

      const sheetsData = await response.json();
      const matrix = sheetsData.values || [];

      if (matrix.length === 0) continue;

      const novs = parsearMatrizRuteo(matrix, file.name, choferesMap);
      todasNovedades = todasNovedades.concat(novs);

      if (archivosAProcesar.length > 1 && i < archivosAProcesar.length - 1) {
        await sleep(1200);
      }

    } catch (err) {
      console.error(`[!] Error procesando archivo ${file.name}:`, err.message);
    }
  }

  return {
    success: true,
    rootFolderId,
    totalArchivosEncontrados: archivosValidos.length,
    totalArchivosProcesados: archivosAProcesar.length,
    archivosProcesados: archivosAProcesar.map(f => ({ id: f.id, name: f.name, path: f.folderPath })),
    totalAsignaciones: todasNovedades.length,
    novedades: todasNovedades
  };
}

/**
 * Función de diagnóstico que retorna el estado exacto de autenticación y variables de entorno.
 */
async function probaddiagnosticoDrive(folderId = DEFAULT_DRIVE_FOLDER_ID) {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || null;
  const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY || null;
  const credsFileExists = fs.existsSync(path.join(DEFAULT_RUTEO_DIR, 'credentials.json'));

  const diag = {
    timestamp: new Date().toISOString(),
    env: {
      GOOGLE_SERVICE_ACCOUNT_EMAIL: email,
      GOOGLE_PRIVATE_KEY_CARGADO: !!privateKeyRaw,
      GOOGLE_PRIVATE_KEY_LONGITUD: privateKeyRaw ? privateKeyRaw.length : 0,
      CREDENTIALS_JSON_EXISTE: credsFileExists,
      DRIVE_FOLDER_ID: folderId,
      SPREADSHEET_ID: process.env.SPREADSHEET_ID || '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc'
    },
    authStatus: 'PENDIENTE',
    driveApiStatus: 'PENDIENTE',
    error: null,
    filesFound: []
  };

  const auth = getAuthClient();
  if (!auth) {
    diag.authStatus = 'ERROR: No se pudo instanciar JWT (faltan credenciales)';
    return diag;
  }

  try {
    const tokens = await auth.authorize();
    diag.authStatus = 'EXITO: Token JWT generado correctamente';

    const url = `https://www.googleapis.com/drive/v3/files?q=%27${folderId}%27+in+parents+and+trashed%3Dfalse&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,mimeType)`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`
      }
    });

    const data = await response.json();

    if (!response.ok) {
      diag.driveApiStatus = 'ERROR';
      diag.error = data.error || { status: response.status };
    } else {
      diag.driveApiStatus = 'EXITO: API de Google Drive respondió correctamente con HTTP 200';
      diag.filesFound = data.files || [];
    }

  } catch (err) {
    diag.driveApiStatus = 'ERROR';
    diag.error = {
      message: err.message,
      code: err.code,
      status: err.status,
      errors: err.errors
    };
  }

  return diag;
}

module.exports = {
  getAuthClient,
  listarArchivosCarpetaDrive: listarArchivosCarpetaDriveRecursivo,
  listarArchivosCarpetaDriveRecursivo,
  extraerNovedadesDesdeDrive,
  probaddiagnosticoDrive
};
