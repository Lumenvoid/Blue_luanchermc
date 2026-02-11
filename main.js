const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');
const querystring = require('querystring');

let mainWindow;

// Microsoft OAuth configuratie - gebruik de juiste endpoints
const MS_CONFIG = {
  clientId: '00000000402b5328', // Minecraft client ID
  authority: 'https://login.live.com',
  redirectUri: 'https://login.live.com/oauth20_desktop.srf'
};

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

// Helper voor HTTPS requests
function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// Microsoft Auth Handler
ipcMain.handle('start-microsoft-auth', async () => {
  try {
    console.log('Starting Microsoft auth...');
    
    // Step 1: Get device code from Microsoft (juiste endpoint)
    const deviceCodeData = await makeRequest({
      hostname: 'login.microsoftonline.com',
      path: '/consumers/oauth2/v2.0/devicecode',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }, querystring.stringify({
      client_id: MS_CONFIG.clientId,
      scope: 'XboxLive.signin XboxLive.offline_access'
    }));

    console.log('Device code response:', deviceCodeData);

    if (deviceCodeData.error) {
      throw new Error(deviceCodeData.error_description || deviceCodeData.error);
    }

    // Open browser voor gebruiker
    shell.openExternal(deviceCodeData.verification_uri);

    // Step 2: Poll for token
    const token = await pollForToken(deviceCodeData.device_code, deviceCodeData.interval);
    
    // Step 3: Xbox Live Auth
    const xblToken = await getXboxLiveToken(token.access_token);
    
    // Step 4: XSTS Token
    const xstsData = await getXSTSToken(xblToken);
    
    // Step 5: Minecraft Token
    const mcToken = await getMinecraftToken(xstsData);
    
    // Step 6: Get Profile
    const profile = await getMinecraftProfile(mcToken);

    return {
      success: true,
      user: profile,
      tokens: {
        minecraft: mcToken,
        microsoft: token
      }
    };

  } catch (error) {
    console.error('Auth error:', error);
    return { success: false, error: error.message };
  }
});

async function pollForToken(deviceCode, interval) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = 60; // 5 minuten max
    
    const check = async () => {
      attempts++;
      if (attempts > maxAttempts) {
        reject(new Error('Timeout - device code expired'));
        return;
      }

      try {
        const data = await makeRequest({
          hostname: 'login.microsoftonline.com',
          path: '/consumers/oauth2/v2.0/token',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }, querystring.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: MS_CONFIG.clientId,
          device_code: deviceCode
        }));

        console.log('Token poll response:', data.error || 'success');

        if (data.error === 'authorization_pending') {
          setTimeout(check, (interval || 5) * 1000);
          return;
        }

        if (data.error === 'expired_token') {
          reject(new Error('Device code expired. Please try again.'));
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
  const postData = JSON.stringify({
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${accessToken}`
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  });

  const data = await makeRequest({
    hostname: 'user.auth.xboxlive.com',
    path: '/user/authenticate',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);

  if (!data.Token) throw new Error('Xbox Live auth failed');
  return data.Token;
}

async function getXSTSToken(xblToken) {
  const postData = JSON.stringify({
    Properties: {
      SandboxId: 'RETAIL',
      UserTokens: [xblToken]
    },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT'
  });

  const data = await makeRequest({
    hostname: 'xsts.auth.xboxlive.com',
    path: '/xsts/authorize',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);

  if (!data.Token) throw new Error('XSTS auth failed');
  return {
    token: data.Token,
    userHash: data.DisplayClaims.xui[0].uhs
  };
}

async function getMinecraftToken(xstsData) {
  const postData = JSON.stringify({
    identityToken: `XBL3.0 x=${xstsData.userHash};${xstsData.token}`
  });

  const data = await makeRequest({
    hostname: 'api.minecraftservices.com',
    path: '/authentication/login_with_xbox',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);

  if (!data.access_token) throw new Error('Minecraft auth failed');
  return data;
}

async function getMinecraftProfile(mcToken) {
  const data = await makeRequest({
    hostname: 'api.minecraftservices.com',
    path: '/minecraft/profile',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${mcToken.access_token}`
    }
  });

  if (data.error || !data.name) {
    throw new Error('Minecraft profile not found. Do you own the game?');
  }

  return data;
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
