const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');
const querystring = require('querystring');

let mainWindow;

// Helper functie voor HTTPS requests (geen node-fetch nodig)
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');
}

// Microsoft OAuth Handler
ipcMain.handle('start-microsoft-auth', async () => {
  try {
    // Step 1: Get device code
    const deviceCodeResponse = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', {
      method: 'POST',
      body: {
        client_id: '00000000402b5328',
        scope: 'XboxLive.signin offline_access'
      }
    });

    const deviceCodeData = await deviceCodeResponse.json();
    
    if (deviceCodeData.error) {
      throw new Error(deviceCodeData.error_description);
    }

    // Open browser
    shell.openExternal(deviceCodeData.verification_uri);

    // Step 2: Poll for token
    const token = await pollForToken(deviceCodeData.device_code, deviceCodeData.interval);
    
    // Step 3: Xbox Live
    const xblToken = await getXboxLiveToken(token.access_token);
    
    // Step 4: XSTS
    const xstsData = await getXSTSToken(xblToken);
    
    // Step 5: Minecraft
    const mcToken = await getMinecraftToken(xstsData);
    
    // Step 6: Profile
    const profile = await getMinecraftProfile(mcToken);

    return {
      success: true,
      user: profile,
      tokens: { minecraft: mcToken, microsoft: token }
    };

  } catch (error) {
    console.error('Auth error:', error);
    return { success: false, error: error.message };
  }
});

async function pollForToken(deviceCode, interval) {
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const response = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
          method: 'POST',
          body: {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: '00000000402b5328',
            device_code: deviceCode
          }
        });

        const data = await response.json();

        if (data.error === 'authorization_pending') {
          setTimeout(check, interval * 1000);
          return;
        }

        if (data.error) {
          reject(new Error(data.error_description || data.error));
          return;
        }

        resolve(data);
      } catch (error) {
        reject(error);
      }
    };
    check();
  });
}

async function getXboxLiveToken(accessToken) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${accessToken}`
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    });

    const req = https.request({
      hostname: 'user.auth.xboxlive.com',
      path: '/user/authenticate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(JSON.parse(body).Token));
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getXSTSToken(xblToken) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      Properties: {
        SandboxId: 'RETAIL',
        UserTokens: [xblToken]
      },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    });

    const req = https.request({
      hostname: 'xsts.auth.xboxlive.com',
      path: '/xsts/authorize',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const data = JSON.parse(body);
        resolve({
          token: data.Token,
          userHash: data.DisplayClaims.xui[0].uhs
        });
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getMinecraftToken(xstsData) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      identityToken: `XBL3.0 x=${xstsData.userHash};${xstsData.token}`
    });

    const req = https.request({
      hostname: 'api.minecraftservices.com',
      path: '/authentication/login_with_xbox',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(JSON.parse(body)));
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getMinecraftProfile(mcToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.minecraftservices.com',
      path: '/minecraft/profile',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${mcToken.access_token}`
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 404) {
          reject(new Error('Minecraft profile not found. Do you own the game?'));
        } else {
          resolve(JSON.parse(body));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
