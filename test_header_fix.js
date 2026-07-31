require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

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
    let body = str.replace(header, '').replace(footer, '').replace(/\s+/g, '');
    const lines = body.match(/.{1,64}/g) || [body];
    return `${header}\n${lines.join('\n')}\n${footer}\n`;
  }
  return str.trim();
}

(async () => {
  try {
    const spreadsheetId = '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc';
    const jwt = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: formatPrivateKey(process.env.GOOGLE_PRIVATE_KEY),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(spreadsheetId, jwt);
    await doc.loadInfo();

    const sheet = doc.sheetsById[625701060] || doc.sheetsByTitle['DISPO'];
    console.log(`[*] Cargando cabeceras de la pestaña DISPO (GID ${sheet.sheetId})...`);

    const headers = [
      'ID_NOVEDAD', 'CHOFER_ID', 'CHOFER_NOMBRE', 'TERMINAL',
      'FECHA_ISO', 'FECHA_OBJETIVO', 'HORARIO', 'LISTA_ORIGEN', 'DETALLE', 'ESTADO_RECEPCION', 'TIMESTAMP_FEEDBACK', 'JSON_PAYLOAD'
    ];

    try {
      await sheet.loadHeaderRow();
      console.log('[OK] Cabeceras cargadas:', sheet.headerValues);
    } catch (e) {
      console.log('[*] Cabeceras no encontradas, estableciendo cabeceras por defecto...');
      await sheet.setHeaderRow(headers);
      console.log('[OK] Cabeceras establecidas:', sheet.headerValues);
    }

    const rows = await sheet.getRows();
    console.log(`[✔ ÉXITO!] Filas existentes leídas correctamente: ${rows.length}`);

  } catch (e) {
    console.error('[!] Error test header:', e);
  }
})();
