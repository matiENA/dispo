require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const {
  parsearMatrizRuteo,
  generarIndiceDias,
  cargarDbChoferes,
  esNombreArchivoValido
} = require('./services/ruteoExtractor');

const {
  guardarEnCsvLocal,
  inyectarEnGoogleSheets,
  registrarFeedbackChofer,
  realizarRecepcionCheck
} = require('./services/sheetsService');

const {
  extraerNovedadesDesdeDrive,
  listarArchivosCarpetaDrive,
  probaddiagnosticoDrive
} = require('./services/driveService');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_RUTEO_DIR = __dirname;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '1qpXukDfaovrVltV74NL9WpBzr1Ig916z';
const DISPO_JSON_FILE = path.join(DEFAULT_RUTEO_DIR, 'dispo_novedades.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// =================================================================
// 1. HEALTH CHECK & DIAGNÓSTICO
// =================================================================
app.get('/api/ruteo/info', (req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'Microservicio Extractor e Inyector de Ruteos Livianos',
    driveFolderId: DRIVE_FOLDER_ID,
    driveFolderUrl: `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`,
    spreadsheetId: process.env.SPREADSHEET_ID || '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc',
    targetSheet: 'sheet - DISPO',
    reglasFiltrado: 'Lectura optimizada de 1 solo archivo al día para evitar cuotas API Google [429].',
    endpoints: [
      'GET /api/ruteo/diag - Diagnóstico en tiempo real',
      'GET /api/ruteo/procesar?fecha=today - Procesa 1 solo archivo (por defecto hoy / más reciente)',
      'POST /api/ruteo/procesar-hoy - Procesa e inyecta la planilla del día en sheet - DISPO',
      'POST /api/ruteo/procesar-fecha - Body: { fecha: "YYYY-MM-DD" } para inyectar una fecha específica',
      'POST /api/ruteo/inyectar - Inyecta asignaciones procesadas',
      'GET /api/ruteo/recepcion - Información para pantalla de recepción',
      'POST /api/ruteo/feedback - Registra feedback de chofer (👍 / 👎)'
    ]
  });
});

app.get('/api/ruteo/diag', async (req, res) => {
  try {
    const diag = await probaddiagnosticoDrive();
    res.json(diag);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================================================================
// 2. EXTRACCIÓN OPTIMIZADA DESDE GOOGLE DRIVE (1 SOLO ARCHIVO POR DEFECTO)
// =================================================================
app.get('/api/ruteo/procesar', async (req, res) => {
  try {
    const folderId = req.query.folderId || DRIVE_FOLDER_ID;
    const fecha = req.query.fecha || 'today';

    // Extracción desde Google Drive (por defecto solo 1 archivo para evitar cuota 429)
    const resDrive = await extraerNovedadesDesdeDrive(folderId, fecha);

    if (!resDrive.success) {
      return res.status(400).json({
        success: false,
        error: resDrive.error || 'Error al conectar con Google Drive.'
      });
    }

    const indiceDias = generarIndiceDias(resDrive.novedades);
    res.json({
      success: true,
      origen: 'Google Drive (Modo Optimizado 1 Archivo)',
      folderId,
      driveFolderUrl: `https://drive.google.com/drive/folders/${folderId}`,
      totalArchivosEncontrados: resDrive.totalArchivosEncontrados,
      totalArchivosProcesados: resDrive.totalArchivosProcesados,
      archivosProcesados: resDrive.archivosProcesados,
      totalAsignaciones: resDrive.totalAsignaciones,
      indiceDias,
      novedades: resDrive.novedades
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint de 1 clic: Procesa e inyecta la planilla de HOY
app.post('/api/ruteo/procesar-hoy', async (req, res) => {
  try {
    const resDrive = await extraerNovedadesDesdeDrive(DRIVE_FOLDER_ID, 'today');
    if (!resDrive.success || resDrive.novedades.length === 0) {
      return res.status(400).json({ success: false, error: 'No se encontraron asignaciones para la planilla de hoy.' });
    }

    guardarEnCsvLocal(resDrive.novedades);
    const inyeccion = await inyectarEnGoogleSheets(resDrive.novedades);

    res.json({
      success: true,
      mensaje: `Planilla de hoy procesada e inyectada exitosamente (${resDrive.totalAsignaciones} asignaciones)`,
      archivosProcesados: resDrive.archivosProcesados,
      totalAsignaciones: resDrive.totalAsignaciones,
      inyeccion
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para procesar e inyectar una fecha específica YYYY-MM-DD
app.post('/api/ruteo/procesar-fecha', async (req, res) => {
  try {
    const { fecha } = req.body;
    if (!fecha) {
      return res.status(400).json({ success: false, error: 'Se requiere el parámetro "fecha" (formato YYYY-MM-DD)' });
    }

    const resDrive = await extraerNovedadesDesdeDrive(DRIVE_FOLDER_ID, fecha);
    if (!resDrive.success || resDrive.novedades.length === 0) {
      return res.status(400).json({ success: false, error: `No se encontraron asignaciones para la fecha ${fecha}` });
    }

    guardarEnCsvLocal(resDrive.novedades);
    const inyeccion = await inyectarEnGoogleSheets(resDrive.novedades);

    res.json({
      success: true,
      mensaje: `Planilla para la fecha ${fecha} procesada e inyectada exitosamente (${resDrive.totalAsignaciones} asignaciones)`,
      archivosProcesados: resDrive.archivosProcesados,
      totalAsignaciones: resDrive.totalAsignaciones,
      inyeccion
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/ruteo/procesar', (req, res) => {
  try {
    const { rows, filename } = req.body;
    if (!rows || !Array.isArray(rows)) {
      return res.status(400).json({ success: false, error: 'Se requiere array "rows" en el body' });
    }

    const choferesMap = cargarDbChoferes();
    const novedades = parsearMatrizRuteo(rows, filename || '', choferesMap);
    const indiceDias = generarIndiceDias(novedades);

    res.json({
      success: true,
      origen: 'Payload Directo',
      totalAsignaciones: novedades.length,
      indiceDias,
      novedades
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================================================================
// 3. INYECCIÓN (Diagrama: 'sheet button')
// =================================================================
app.post('/api/ruteo/inyectar', async (req, res) => {
  try {
    let novedades = req.body.novedades;

    if (!novedades || !Array.isArray(novedades)) {
      // Si no vienen en el body, extraer exclusivamente desde Google Drive
      const folderId = req.query.folderId || DRIVE_FOLDER_ID;
      const resDrive = await extraerNovedadesDesdeDrive(folderId);
      if (!resDrive.success || resDrive.totalAsignaciones === 0) {
        return res.status(400).json({
          success: false,
          error: 'No se encontraron asignaciones para inyectar desde Google Drive.'
        });
      }
      novedades = resDrive.novedades;
    }

    // 1. Guardar en CSV local y JSON
    guardarEnCsvLocal(novedades);

    // 2. Inyectar en Google Sheet target
    const inyectadoSheet = await inyectarEnGoogleSheets(novedades);

    res.json({
      success: true,
      totalInyectados: novedades.length,
      inyectadoEnGoogleSheets: inyectadoSheet,
      novedades
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================================================================
// 4. FRONT INFORMACIÓN RECEPCIÓN (Diagrama: 'front informacion recepcion')
// =================================================================
app.get('/api/ruteo/recepcion', (req, res) => {
  try {
    let novedades = [];
    if (fs.existsSync(DISPO_JSON_FILE)) {
      novedades = JSON.parse(fs.readFileSync(DISPO_JSON_FILE, 'utf-8'));
    }

    const checks = realizarRecepcionCheck();
    res.json({
      success: true,
      total: novedades.length,
      novedades,
      checks
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================================================================
// 4. AUTENTICACIÓN Y LOGIN DE CHOFERES (Diagrama: 'login key' -> 'DB_CHOFERES')
// =================================================================
app.post('/api/ruteo/auth/login', (req, res) => {
  try {
    const { id_chofer, password, dni } = req.body;
    if (!id_chofer && !dni) {
      return res.status(400).json({ success: false, error: 'Se requiere "id_chofer" o "dni"' });
    }

    const choferesMap = cargarDbChoferes();
    let choferEncontrado = null;

    const busquedaKey = normalizeText(id_chofer || dni || '');

    for (const [key, data] of choferesMap.entries()) {
      if (
        data.id.toLowerCase() === busquedaKey.toLowerCase() ||
        data.dni === busquedaKey ||
        key.includes(busquedaKey) ||
        busquedaKey.includes(key)
      ) {
        choferEncontrado = data;
        break;
      }
    }

    if (!choferEncontrado) {
      return res.status(401).json({ success: false, error: 'Chofer no encontrado en DB_CHOFERES' });
    }

    // Validar contraseña si fue proporcionada
    if (password && choferEncontrado.pass && password.trim() !== choferEncontrado.pass.trim()) {
      return res.status(401).json({ success: false, error: 'Contraseña incorrecta para la APP NOVEDADES' });
    }

    // Cargar novedades activas
    let novedades = [];
    if (fs.existsSync(DISPO_JSON_FILE)) {
      novedades = JSON.parse(fs.readFileSync(DISPO_JSON_FILE, 'utf-8'));
    }

    const asignacionesChofer = novedades.filter(n =>
      n.chofer_id === choferEncontrado.id ||
      n.id_chofer === choferEncontrado.id ||
      n.nom.toLowerCase().includes(choferEncontrado.nombre.toLowerCase())
    );

    asignacionesChofer.sort((a, b) => (b.fecha_iso || '').localeCompare(a.fecha_iso || ''));
    const asignacionActual = asignacionesChofer.length > 0 ? asignacionesChofer[0] : null;

    res.json({
      success: true,
      authStatus: 'AUTENTICADO',
      chofer: {
        id: choferEncontrado.id,
        nombre: choferEncontrado.nombre,
        dni: choferEncontrado.dni
      },
      datos: asignacionActual ? {
        id_novedad: asignacionActual.id,
        nom: asignacionActual.nom,
        terminal: asignacionActual.terminal,
        fecha_objetivo: asignacionActual.fecha_objetivo,
        horario: asignacionActual.horario,
        unidad: asignacionActual.unidad || '',
        estado_recepcion: asignacionActual.estado_recepcion || 'PENDIENTE'
      } : null,
      historial: asignacionesChofer
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================================================================
// 5. APP MÓVIL CHOFER (Diagrama: 'app')
// =================================================================
app.get('/api/ruteo/chofer/:id', (req, res) => {
  try {
    const choferId = req.params.id;
    let novedades = [];
    if (fs.existsSync(DISPO_JSON_FILE)) {
      novedades = JSON.parse(fs.readFileSync(DISPO_JSON_FILE, 'utf-8'));
    }

    const asignacionesChofer = novedades.filter(n =>
      n.chofer_id === choferId ||
      n.id_chofer === choferId ||
      n.nom.toLowerCase().includes(choferId.toLowerCase())
    );

    // Ordenar asignaciones por fecha descendente
    asignacionesChofer.sort((a, b) => (b.fecha_iso || '').localeCompare(a.fecha_iso || ''));

    const asignacionActual = asignacionesChofer.length > 0 ? asignacionesChofer[0] : null;

    res.json({
      success: true,
      choferId,
      totalAsignaciones: asignacionesChofer.length,
      asignacionActual,
      historial: asignacionesChofer
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================================================================
// 6. FEEDBACK (Diagrama: 'feedback' -> Google Sheet)
// =================================================================
app.post('/api/ruteo/feedback', async (req, res) => {
  try {
    const { novedadId, choferId, estado } = req.body;
    if (!estado || !['CONFIRMADO', 'RECHAZADO', 'OK', 'NOK'].includes(estado.toUpperCase())) {
      return res.status(400).json({ success: false, error: 'Estado inválido. Use "CONFIRMADO" (👍) o "RECHAZADO" (👎)' });
    }

    const estadoNorm = ['CONFIRMADO', 'OK'].includes(estado.toUpperCase()) ? 'CONFIRMADO' : 'RECHAZADO';
    const resultado = await registrarFeedbackChofer(novedadId, choferId, estadoNorm);

    res.json(resultado);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const {
  ejecutarExtraccionTrigger,
  startTrigger,
  stopTrigger,
  getTriggerStatus
} = require('./services/triggerService');

// =================================================================
// 8. CONTROLES DEL TRIGGER DE EXTRACCIÓN PERIÓDICA
// =================================================================
app.get('/api/ruteo/trigger/status', (req, res) => {
  res.json({ success: true, trigger: getTriggerStatus() });
});

app.post('/api/ruteo/trigger/start', (req, res) => {
  const minutos = parseInt(req.body.minutos || req.query.minutos || process.env.EXTRACTION_INTERVAL_MINUTES || '5', 10);
  const estado = startTrigger(minutos);
  res.json({ success: true, trigger: estado });
});

app.post('/api/ruteo/trigger/stop', (req, res) => {
  const estado = stopTrigger();
  res.json({ success: true, trigger: estado });
});

app.post('/api/ruteo/trigger/run', async (req, res) => {
  const estado = await ejecutarExtraccionTrigger();
  res.json({ success: true, trigger: estado });
});

// Arrancar servidor Express
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`[🚀] Microservicio Ruteo Node.js corriendo en puerto ${PORT}`);
  console.log(`[🔗] Target Google Sheet ID: ${process.env.SPREADSHEET_ID || '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc'}`);
  console.log(`=======================================================`);

  // Desactivar extracción automática por defecto (solo a demanda vía API o Web Dashboard)
  if (process.env.ENABLE_AUTO_TRIGGER === 'true') {
    const intervalMin = parseInt(process.env.EXTRACTION_INTERVAL_MINUTES || '5', 10);
    startTrigger(intervalMin);
  } else {
    console.log(`[🛑] Extracción automática deshabilitada por defecto. Uso a demanda vía Web Dashboard / API.`);
  }
});
