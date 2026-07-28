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
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const key = formatPrivateKey(process.env.GOOGLE_PRIVATE_KEY);

    const jwt = new JWT({
      email,
      key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(spreadsheetId, jwt);
    await doc.loadInfo();

    const sheetDispo = doc.sheetsById[625701060];
    console.log(`--- CONTENIDO DE PESTAÑA 'DISPO' (GID 625701060) ---`);
    console.log(`Title: "${sheetDispo.title}", RowCount: ${sheetDispo.rowCount}`);

    const rows = await sheetDispo.getRows({ limit: 10 });
    console.log(`Header values:`, sheetDispo.headerValues);
    console.log(`Primeras 3 filas:`);
    for (let i = 0; i < Math.min(rows.length, 3); i++) {
      console.log(`Fila ${i + 1}:`, rows[i].toObject());
    }

  } catch (e) {
    console.error('[!] Error:', e.message);
  }
})();
