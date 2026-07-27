require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const {
  parsearMatrizRuteo,
  generarIndiceDias,
  cargarDbChoferes
} = require('./services/ruteoExtractor');

const {
  guardarEnCsvLocal,
  inyectarEnGoogleSheets,
  registrarFeedbackChofer,
  realizarRecepcionCheck
} = require('./services/sheetsService');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_RUTEO_DIR = __dirname;
const DISPO_JSON_FILE = path.join(DEFAULT_RUTEO_DIR, 'dispo_novedades.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// =================================================================
// 1. HEALTH CHECK & SERVICIO INFO (Render deployment root)
// =================================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'Microservicio Extractor e Inyector de Ruteos Livianos',
    spreadsheetId: process.env.SPREADSHEET_ID || '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc',
    targetSheet: 'sheet - DISPO',
    endpoints: [
      'GET /api/ruteo/procesar - Extrae las 2 listas desde archivos CSV locales',
      'POST /api/ruteo/procesar - Extrae las 2 listas enviadas en el body (matriz rows)',
      'POST /api/ruteo/inyectar - Inyecta asignaciones procesadas en Google Sheet y CSV local',
      'GET /api/ruteo/recepcion - Obtiene información de asignaciones para recepción',
      'GET /api/ruteo/chofer/:id - Obtiene la asignación objetivo para la tarjeta de la app del chofer',
      'POST /api/ruteo/feedback - Registra feedback del chofer (👍 CONFIRMADO / 👎 RECHAZADO)',
      'GET /api/ruteo/recepcion-check - Evaluación de check de recepción (ID, Nombre, Recepción Check)'
    ]
  });
});

// =================================================================
// 2. EXTRACCIÓN (Diagrama: 'extraccion')
// =================================================================
app.get('/api/ruteo/procesar', (req, res) => {
  try {
    const choferesMap = cargarDbChoferes();
    const files = fs.readdirSync(DEFAULT_RUTEO_DIR)
      .filter(f => f.endsWith('.csv') && !f.startsWith('sheet -') && !f.startsWith('dispo_'));

    let todasNovedades = [];
    files.forEach(file => {
      const filePath = path.join(DEFAULT_RUTEO_DIR, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const rows = parse(content, { skip_empty_lines: true, relax_column_count: true });
      const novs = parsearMatrizRuteo(rows, file, choferesMap);
      todasNovedades = todasNovedades.concat(novs);
    });

    const indiceDias = generarIndiceDias(todasNovedades);
    res.json({
      success: true,
      totalAsignaciones: todasNovedades.length,
      archivosProcesados: files,
      indiceDias,
      novedades: todasNovedades
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
      // Si no vienen en el body, procesar archivos locales
      const choferesMap = cargarDbChoferes();
      const files = fs.readdirSync(DEFAULT_RUTEO_DIR)
        .filter(f => f.endsWith('.csv') && !f.startsWith('sheet -') && !f.startsWith('dispo_'));

      novedades = [];
      files.forEach(file => {
        const filePath = path.join(DEFAULT_RUTEO_DIR, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const rows = parse(content, { skip_empty_lines: true, relax_column_count: true });
        novedades = novedades.concat(parsearMatrizRuteo(rows, file, choferesMap));
      });
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

    res.json({
      success: true,
      choferId,
      total: asignacionesChofer.length,
      asignaciones: asignacionesChofer
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

// =================================================================
// 7. RECEPCIÓN CHECK (Diagrama: 'id, nombre, recepcion check')
// =================================================================
app.get('/api/ruteo/recepcion-check', (req, res) => {
  try {
    const checks = realizarRecepcionCheck();
    res.json({
      success: true,
      total: checks.length,
      confirmados: checks.filter(c => c.recepcion_check).length,
      pendientes: checks.filter(c => !c.recepcion_check).length,
      items: checks
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Arrancar servidor Express
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`[🚀] Microservicio Ruteo Node.js corriendo en puerto ${PORT}`);
  console.log(`[🔗] Target Google Sheet ID: ${process.env.SPREADSHEET_ID || '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc'}`);
  console.log(`=======================================================`);
});
