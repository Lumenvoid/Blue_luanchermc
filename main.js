const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');
const querystring = require('querystring');

let mainWindow;

// VERVANG DIT MET JE EIGEN CLIENT ID
const CLIENT_ID = '36314525-156f-4b1b-9909-d66763e7e333';

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

function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } 
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

ipcMain.handle('start-microsoft-auth', async () => {
  try {
    // Device code flow
    const deviceCodeData = await makeRequest({
      hostname: 'login.microsoftonline.com',
      path: '/consumers/oauth2/v2.0/devicecode',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, querystring.stringify({
      client_id: CLIENT_ID,
      scope: 'XboxLive.signin offline_access'
    }));

    if (deviceCodeData.error) {
      throw new Error(deviceCodeData.error_description);
    }

    // Open browser
    shell.openExternal(deviceCodeData.verification_uri);
    
    // Return device code info to renderer
    return {
      success: true,
      deviceCode: deviceCodeData.device_code,
      userCode: deviceCodeData.user_code,
      interval: deviceCodeData.interval,
      verificationUri: deviceCodeData.verification_uri
    };

  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('poll-for-token', async (event, deviceCode, interval) => {
  try {
    const data = await makeRequest({
      hostname: 'login.microsoftonline.com',
      path: '/consumers/oauth2/v2.0/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, querystring.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: CLIENT_ID,
      device_code: deviceCode
    }));

    if (data.error === 'authorization_pending') {
      return { pending: true };
    }

    if (data.error) {
      throw new Error(data.error_description || data.error);
    }

    // Xbox Live
    const xblToken = await getXboxLiveToken(data.access_token);
    const xstsData = await getXSTSToken(xblToken);
    const mcToken = await getMinecraftToken(xstsData);
    const profile = await getMinecraftProfile(mcToken);

    return {
      success: true,
      user: profile,
      tokens: { minecraft: mcToken, microsoft: data }
    };

  } catch (error) {
    return { success: false, error: error.message };
  }
});

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
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);

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
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);

  return {
    token: data.Token,
    userHash: data.DisplayClaims.xui[0].uhs
  };
}

async function getMinecraftToken(xstsData) {
  const postData = JSON.stringify({
    identityToken: `XBL3.0 x=${xstsData.userHash};${xstsData.token}`
  });

  return await makeRequest({
    hostname: 'api.minecraftservices.com',
    path: '/authentication/login_with_xbox',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);
}

async function getMinecraftProfile(mcToken) {
  return await makeRequest({
    hostname: 'api.minecraftservices.com',
    path: '/minecraft/profile',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${mcToken.access_token}`
    }
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
