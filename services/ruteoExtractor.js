const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const DEFAULT_RUTEO_DIR = path.join(__dirname, '..');
const DB_CHOFERES_FILE = path.join(DEFAULT_RUTEO_DIR, 'sheet - DB_CHOFERES.csv');

/**
 * Normaliza texto eliminando tildes y caracteres especiales.
 */
function normalizeText(text) {
  if (!text) return '';
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9 ]/gi, '')
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Normaliza fechas a formato YYYY-MM-DD e ISO.
 */
function parseFecha(fechaStr, filename = '') {
  fechaStr = (fechaStr || '').trim();

  // Buscar DD/MM/YYYY
  const matchDMY = fechaStr.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (matchDMY) {
    const [, d, m, y] = matchDMY;
    const day = d.padStart(2, '0');
    const month = m.padStart(2, '0');
    return {
      fechaIso: `${y}-${month}-${day}`,
      fechaCorta: `${day}/${month}`
    };
  }

  // Buscar YYYY-MM-DD en filename o cell
  const matchYMD = (fechaStr + ' ' + filename).match(/(\d{4})[-/.](\d{2})[-/.](\d{2})/);
  if (matchYMD) {
    const [, y, m, d] = matchYMD;
    return {
      fechaIso: `${y}-${m}-${d}`,
      fechaCorta: `${d}/${m}`
    };
  }

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return {
    fechaIso: `${y}-${m}-${d}`,
    fechaCorta: `${d}/${m}`
  };
}

/**
 * Carga la base de datos de choferes en memoria.
 */
function cargarDbChoferes(dbPath = DB_CHOFERES_FILE) {
  const choferesMap = new Map();
  if (!fs.existsSync(dbPath)) {
    console.warn(`[!] Warning: No se encontró la DB de choferes en ${dbPath}`);
    return choferesMap;
  }

  const fileContent = fs.readFileSync(dbPath, 'utf-8');
  const records = parse(fileContent, { skip_empty_lines: true, relax_column_count: true });

  for (const row of records) {
    if (row.length > 1) {
      const choferId = (row[0] || '').trim();
      if (!choferId.startsWith('drv_')) continue;

      const officialName = (row[1] || '').trim();
      const driverData = {
        id: choferId,
        nombre: officialName,
        dni: row[6] ? row[6].trim() : '',
        pass: row[7] ? row[7].trim() : ''
      };

      // Indexar variantes de nombre (cols 1, 3, 5)
      [1, 3, 5].forEach(colIdx => {
        if (row[colIdx]) {
          const norm = normalizeText(row[colIdx]);
          if (norm) choferesMap.set(norm, driverData);
        }
      });
    }
  }

  return choferesMap;
}

/**
 * Busca un chofer por nombre o palabras clave.
 */
function buscarChofer(nombreRaw, choferesMap) {
  const norm = normalizeText(nombreRaw);
  if (!norm) return null;

  // 1. Coincidencia exacta
  if (choferesMap.has(norm)) {
    return choferesMap.get(norm);
  }

  // 2. Coincidencia por 2 palabras (Apellido + Nombre)
  const words = norm.split(' ');
  if (words.length >= 2) {
    for (const [key, data] of choferesMap.entries()) {
      const keyWords = key.split(' ');
      if (words[0] === keyWords[0] && words[1] === keyWords[1]) {
        return data;
      }
    }
  }

  return null;
}

/**
 * Extrae la Lista 1 y Lista 2 a partir de una matriz de celdas / filas CSV.
 */
function parsearMatrizRuteo(rows, filename = '', choferesMap = null) {
  if (!choferesMap) {
    choferesMap = cargarDbChoferes();
  }

  if (!rows || rows.length < 3) {
    return [];
  }

  // Fila 1: Fecha
  const row1 = rows[0] || [];
  const rawFecha = (row1[0] || '').trim();
  const { fechaIso, fechaCorta } = parseFecha(rawFecha, filename);

  // Fila 2: Terminales (Bloque 1 Cols A-D, Bloque 2 Cols E-H)
  const row2 = rows[1] || [];
  const terminal1 = (row2[0] || '').trim() || 'TERMINAL PLAZA HUINCUL';
  const terminal2 = (row2[4] || '').trim() || 'TERMINAL DOCK SUD';

  const novedades = [];

  // A partir de Fila 4 (índice 3)
  for (let rowIdx = 3; rowIdx < rows.length; rowIdx++) {
    const r = rows[rowIdx] || [];

    // -------------------------------------------------------------
    // LISTA 1: Col B (índice 1) Horario, Col C (índice 2) Nombre
    // -------------------------------------------------------------
    const hs1 = (r[1] || '').trim();
    const nom1 = (r[2] || '').trim();

    if (nom1 && !['CHOFER', 'NOMBRE', 'HS', 'UNIDAD'].includes(nom1.toUpperCase())) {
      const choferInfo = buscarChofer(nom1, choferesMap);
      const horarioFmt = /^\d+$/.test(hs1) ? `${hs1} HS` : (hs1 || 'A CONFIRMAR');

      novedades.push({
        id: `${fechaIso}_L1_${rowIdx + 1}`,
        chofer_id: choferInfo ? choferInfo.id : `UNMAPPED_${rowIdx + 1}`,
        id_chofer: choferInfo ? choferInfo.id : `UNMAPPED_${rowIdx + 1}`,
        nom: choferInfo ? choferInfo.nombre : nom1,
        tipo_novedad: 'ASIGNACION_RUTEO',
        terminal: terminal1,
        fecha_iso: fechaIso,
        fecha_objetivo: fechaCorta,
        horario: horarioFmt,
        srv: terminal1,
        detalle: `Presentación en ${terminal1} a las ${horarioFmt} (${fechaCorta})`,
        lista_origen: 'LISTA_1_BC',
        resuelto: false,
        estado_recepcion: 'PENDIENTE'
      });
    }

    // -------------------------------------------------------------
    // LISTA 2: Col F (índice 5) Horario, Col G (índice 6) Nombre
    // -------------------------------------------------------------
    const hs2 = (r[5] || '').trim();
    const nom2 = (r[6] || '').trim();

    if (nom2 && !['CHOFER', 'NOMBRE', 'HS', 'UNIDAD'].includes(nom2.toUpperCase())) {
      const choferInfo2 = buscarChofer(nom2, choferesMap);
      const horarioFmt2 = /^\d+$/.test(hs2) ? `${hs2} HS` : (hs2 || 'A CONFIRMAR');

      novedades.push({
        id: `${fechaIso}_L2_${rowIdx + 1}`,
        chofer_id: choferInfo2 ? choferInfo2.id : `UNMAPPED_${rowIdx + 1}`,
        id_chofer: choferInfo2 ? choferInfo2.id : `UNMAPPED_${rowIdx + 1}`,
        nom: choferInfo2 ? choferInfo2.nombre : nom2,
        tipo_novedad: 'ASIGNACION_RUTEO',
        terminal: terminal2,
        fecha_iso: fechaIso,
        fecha_objetivo: fechaCorta,
        horario: horarioFmt2,
        srv: terminal2,
        detalle: `Presentación en ${terminal2} a las ${horarioFmt2} (${fechaCorta})`,
        lista_origen: 'LISTA_2_FG',
        resuelto: false,
        estado_recepcion: 'PENDIENTE'
      });
    }
  }

  return novedades;
}

/**
 * Agrupa asignaciones por índice de fecha.
 */
function generarIndiceDias(novedades) {
  const indice = {};
  for (const nov of novedades) {
    const fecha = nov.fecha_iso;
    if (!indice[fecha]) {
      indice[fecha] = [];
    }
    indice[fecha].push(nov);
  }
  return indice;
}

module.exports = {
  normalizeText,
  parseFecha,
  cargarDbChoferes,
  buscarChofer,
  parsearMatrizRuteo,
  generarIndiceDias
};
