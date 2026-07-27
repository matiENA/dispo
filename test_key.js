require('dotenv').config();
const { JWT } = require('google-auth-library');

function formatPemKey(raw) {
  if (!raw) return '';
  let str = raw.trim();

  // Strip quotes
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1).trim();
  }

  // Handle literal escaped \n
  str = str.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r/g, '');

  // Extract base64 part
  const header = '-----BEGIN PRIVATE KEY-----';
  const footer = '-----END PRIVATE KEY-----';

  if (str.includes(header) && str.includes(footer)) {
    let body = str
      .replace(header, '')
      .replace(footer, '')
      .replace(/\s+/g, ''); // Remove all whitespace/newlines from base64 body

    // Split base64 body into 64-character lines
    const lines = body.match(/.{1,64}/g) || [body];
    return `${header}\n${lines.join('\n')}\n${footer}\n`;
  }

  return str;
}

const rawKey = process.env.GOOGLE_PRIVATE_KEY || '';
const formattedKey = formatPemKey(rawKey);

console.log('--- TEST PEM RE-FORMATTING ---');
console.log(formattedKey.slice(0, 100));

try {
  const jwt = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: formattedKey,
    scopes: ['https://www.googleapis.com/auth/drive']
  });

  jwt.authorize((err, tokens) => {
    if (err) {
      console.error('[!] JWT Authorize error:', err.message);
    } else {
      console.log('[OK] Google JWT Service Account authorized successfully!');
    }
  });
} catch (e) {
  console.error('[!] Error creating JWT:', e.message);
}
