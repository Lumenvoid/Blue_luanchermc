const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fetch = require('node-fetch');

let mainWindow;

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
    // Step 1: Get device code from Microsoft
    const deviceCodeResponse = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: '00000000402b5328',
        scope: 'XboxLive.signin offline_access'
      })
    });

    const deviceCodeData = await deviceCodeResponse.json();
    
    if (deviceCodeData.error) {
      throw new Error(deviceCodeData.error_description);
    }

    // Open browser for user to authenticate
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
    const check = async () => {
      try {
        const response = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: '00000000402b5328',
            device_code: deviceCode
          })
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
  const response = await fetch('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${accessToken}`
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    })
  });

  const data = await response.json();
  return data.Token;
}

async function getXSTSToken(xblToken) {
  const response = await fetch('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: {
        SandboxId: 'RETAIL',
        UserTokens: [xblToken]
      },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    })
  });

  const data = await response.json();
  return {
    token: data.Token,
    userHash: data.DisplayClaims.xui[0].uhs
  };
}

async function getMinecraftToken(xstsData) {
  const response = await fetch('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identityToken: `XBL3.0 x=${xstsData.userHash};${xstsData.token}`
    })
  });

  return await response.json();
}

async function getMinecraftProfile(mcToken) {
  const response = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: {
      'Authorization': `Bearer ${mcToken.access_token}`
    }
  });

  if (response.status === 404) {
    throw new Error('Minecraft profile not found. Do you own the game?');
  }

  return await response.json();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
