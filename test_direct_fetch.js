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
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/spreadsheets'
      ]
    });

    const tokens = await jwt.authorize();
    const token = tokens.access_token;

    const spreadsheetId = '1k2mslmOcAcLAiF6b74SJEiD7NCsm1bbLwDPs9uqJuqM';
    console.log(`[*] Probando lectura directa via REST Sheets v4 values.get para id ${spreadsheetId}...`);

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:Z100?valueRenderOption=FORMATTED_VALUE`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });

    console.log('HTTP Status:', res.status);
    const data = await res.json();
    if (res.ok) {
      console.log('[✔ ÉXITO!] Filas leídas:', data.values ? data.values.length : 0);
      if (data.values && data.values.length > 0) {
        console.log('Fila 1 (Fecha):', data.values[0]);
        console.log('Fila 2 (Terminales):', data.values[1]);
        console.log('Fila 3 (Muestra Lista):', data.values[2]);
      }
    } else {
      console.error('[!] Error payload:', data);
    }

  } catch (e) {
    console.error(e);
  }
})();
