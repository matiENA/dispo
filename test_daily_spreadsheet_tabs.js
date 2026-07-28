require('dotenv').config();
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
    const jwt = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: formatPrivateKey(process.env.GOOGLE_PRIVATE_KEY),
      scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']
    });

    const tokens = await jwt.authorize();
    const token = tokens.access_token;

    // Spreadsheet ID for 2026-07-27  UTE TPH, TPL, TLC Y TMDP
    const spreadsheetId = '1k2mslmOcAcLAiF6b74SJEiD7NCsm1bbLwDPs9uqJuqM';
    console.log(`[*] Consultando metadatos y pestañas de la planilla diaria ID ${spreadsheetId}...`);

    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`;
    const resMeta = await fetch(metaUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    const metaData = await resMeta.json();

    console.log('[OK] Pestañas encontradas en la planilla diaria:');
    const sheets = metaData.sheets || [];
    sheets.forEach((s, idx) => {
      console.log(` Index ${idx}: title="${s.properties.title}", sheetId=${s.properties.sheetId}`);
    });

    // Buscar si existe una pestaña 'Dispo' o 'DISPO'
    const dispoSheet = sheets.find(s => s.properties.title.toLowerCase().includes('dispo')) || sheets[0];
    const targetTitle = dispoSheet.properties.title;

    console.log(`\n[*] Leyendo rango 'A1:Z100' de la pestaña "${targetTitle}"...`);
    const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/'${encodeURIComponent(targetTitle)}'!A1:Z100?valueRenderOption=FORMATTED_VALUE`;
    const resValues = await fetch(valuesUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    const valuesData = await resValues.json();

    if (resValues.ok && valuesData.values) {
      console.log(`[✔ ÉXITO!] Filas leídas de "${targetTitle}": ${valuesData.values.length}`);
      console.log('Fila 1:', valuesData.values[0] ? valuesData.values[0].slice(0, 5) : []);
      console.log('Fila 2:', valuesData.values[1] ? valuesData.values[1].slice(0, 5) : []);
      console.log('Fila 3:', valuesData.values[2] ? valuesData.values[2].slice(0, 5) : []);
      console.log('Fila 4 (Primera asignación):', valuesData.values[3] ? valuesData.values[3].slice(0, 7) : []);
    } else {
      console.error('[!] Error leiendo valores:', valuesData);
    }

  } catch (e) {
    console.error(e);
  }
})();
