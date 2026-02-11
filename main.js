const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');
const querystring = require('querystring');

// Helper functie voor HTTPS requests
function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const data = options.body ? querystring.stringify(options.body) : null;
    
    const requestOptions = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        ...options.headers
      }
    };

    if (data) {
      requestOptions.headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = https.request(requestOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          json: () => Promise.resolve(JSON.parse(body)),
          text: () => Promise.resolve(body),
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300
        });
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Rest van je code blijft hetzelfde, maar gebruik nu deze fetch functie
