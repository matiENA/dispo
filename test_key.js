require('dotenv').config();
const { google } = require('googleapis');
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
    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: formatPrivateKey(process.env.GOOGLE_PRIVATE_KEY),
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/spreadsheets'
      ]
    });

    console.log('[*] Obteniendo token JWT...');
    await auth.authorize();
    console.log('[OK] JWT Autorizado.');

    const drive = google.drive({ version: 'v3', auth });
    const folderId = '1qpXukDfaovrVltV74NL9WpBzr1Ig916z';

    console.log(`[*] Listando contenidos de la carpeta ${folderId} (Shared With Me)...`);
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType)',
      pageSize: 50,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    console.log('[✔ OK] ÉXITO! Archivos encontrados:', res.data.files);
  } catch (e) {
    console.error('[!] Error en test drive:', e.message);
  }
})();
