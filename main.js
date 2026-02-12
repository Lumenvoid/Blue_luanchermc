const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

let mainWindow;
const CLIENT_ID = 'f457da6e-1e63-45dd-81c6-2f9370d484e3';

// Minecraft paths
const MINECRAFT_DIR = path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft');
const LAUNCHER_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'BlueLauncher');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
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

// AUTH handlers (blijven hetzelfde)
ipcMain.handle('start-microsoft-auth', async () => {
  try {
    const deviceCodeData = await makeRequest({
      hostname: 'login.microsoftonline.com',
      path: '/consumers/oauth2/v2.0/devicecode',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, `client_id=${CLIENT_ID}&scope=XboxLive.signin%20offline_access`);

    if (deviceCodeData.error) throw new Error(deviceCodeData.error_description);
    shell.openExternal(deviceCodeData.verification_uri);
    
    return {
      success: true,
      deviceCode: deviceCodeData.device_code,
      userCode: deviceCodeData.user_code,
      interval: deviceCodeData.interval
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
    }, `grant_type=urn:ietf:params:oauth:grant-type:device_code&client_id=${CLIENT_ID}&device_code=${deviceCode}`);

    if (data.error === 'authorization_pending') return { pending: true };
    if (data.error) throw new Error(data.error_description);

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
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${accessToken}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  });
  const data = await makeRequest({
    hostname: 'user.auth.xboxlive.com',
    path: '/user/authenticate',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
  }, postData);
  return data.Token;
}

async function getXSTSToken(xblToken) {
  const postData = JSON.stringify({
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT'
  });
  const data = await makeRequest({
    hostname: 'xsts.auth.xboxlive.com',
    path: '/xsts/authorize',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
  }, postData);
  return { token: data.Token, userHash: data.DisplayClaims.xui[0].uhs };
}

async function getMinecraftToken(xstsData) {
  const postData = JSON.stringify({ identityToken: `XBL3.0 x=${xstsData.userHash};${xstsData.token}` });
  return await makeRequest({
    hostname: 'api.minecraftservices.com',
    path: '/authentication/login_with_xbox',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
  }, postData);
}

async function getMinecraftProfile(mcToken) {
  return await makeRequest({
    hostname: 'api.minecraftservices.com',
    path: '/minecraft/profile',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${mcToken.access_token}` }
  });
}

// ECHTE MINECRAFT LAUNCH
ipcMain.handle('launch-minecraft', async (event, version, authData) => {
  try {
    // Check of Minecraft bestaat
    if (!fs.existsSync(MINECRAFT_DIR)) {
      return { 
        success: false, 
        error: 'Minecraft not found. Please install Minecraft Launcher first from minecraft.net' 
      };
    }

    // Zoek Java
    const javaPaths = [
      'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe',
      'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe',
      'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.8.7-hotspot\\bin\\java.exe',
      'C:\\Program Files\\Microsoft\\jdk-17\\bin\\java.exe',
      path.join(MINECRAFT_DIR, 'runtime', 'java-runtime-gamma', 'windows-x64', 'java-runtime-gamma', 'bin', 'java.exe'),
      path.join(MINECRAFT_DIR, 'runtime', 'jre-legacy', 'windows-x64', 'jre-legacy', 'bin', 'java.exe')
    ];

    let javaPath = null;
    for (const jp of javaPaths) {
      if (fs.existsSync(jp)) {
        javaPath = jp;
        break;
      }
    }

    if (!javaPath) {
      return { 
        success: false, 
        error: 'Java not found. Please install Java 17 or higher from adoptium.net' 
      };
    }

    // Download version manifest als nodig
    const versionDir = path.join(MINECRAFT_DIR, 'versions', version);
    if (!fs.existsSync(versionDir)) {
      return { 
        success: false, 
        error: `Minecraft ${version} not installed. Please install it first in the official launcher.` 
      };
    }

    // Lees version JSON
    const versionJsonPath = path.join(versionDir, `${version}.json`);
    if (!fs.existsSync(versionJsonPath)) {
      return { success: false, error: 'Version configuration not found' };
    }

    const versionData = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));

    // Bouw classpath
    const librariesDir = path.join(MINECRAFT_DIR, 'libraries');
    const classpath = [];

    // Voeg libraries toe
    for (const lib of versionData.libraries || []) {
      if (lib.rules) {
        const allowed = lib.rules.every(rule => {
          if (rule.os && rule.os.name !== 'windows') return false;
          return rule.action === 'allow';
        });
        if (!allowed) continue;
      }

      const libPath = lib.downloads?.artifact?.path;
      if (libPath) {
        const fullPath = path.join(librariesDir, libPath);
        if (fs.existsSync(fullPath)) {
          classpath.push(fullPath);
        }
      }
    }

    // Voeg client jar toe
    const clientJar = path.join(versionDir, `${version}.jar`);
    if (fs.existsSync(clientJar)) {
      classpath.push(clientJar);
    }

    // Game directory
    const gameDir = MINECRAFT_DIR;
    const assetsDir = path.join(MINECRAFT_DIR, 'assets');
    const assetIndex = versionData.assetIndex?.id || 'legacy';

    // Bouw launch arguments
    const jvmArgs = [
      `-Xmx2G`,
      `-Djava.library.path=${path.join(versionDir, 'natives-windows')}`,
      `-Dminecraft.launcher.brand=BlueLauncher`,
      `-Dminecraft.launcher.version=1.0`,
      `-cp`, classpath.join(';')
    ];

    const gameArgs = [
      versionData.mainClass,
      `--username`, authData.user.name,
      `--version`, version,
      `--gameDir`, gameDir,
      `--assetsDir`, assetsDir,
      `--assetIndex`, assetIndex,
      `--uuid`, authData.user.id,
      `--accessToken`, authData.tokens.minecraft.access_token,
      `--userType`, 'msa',
      `--versionType`, 'release'
    ];

    // Start Minecraft
    console.log('Starting Minecraft with:', javaPath, [...jvmArgs, ...gameArgs].join(' '));
    
    const mcProcess = spawn(javaPath, [...jvmArgs, ...gameArgs], {
      detached: true,
      stdio: 'ignore'
    });

    mcProcess.unref();

    return { 
      success: true, 
      message: `Minecraft ${version} started as ${authData.user.name}` 
    };

  } catch (error) {
    console.error('Launch error:', error);
    return { success: false, error: error.message };
  }
});

// SKIN UPLOAD
ipcMain.handle('upload-skin', async (event, skinDataUrl, authToken) => {
  try {
    // Converteer base64 naar buffer
    const base64Data = skinDataUrl.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // Upload naar Minecraft API
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    
    const postData = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="variant"\r\n\r\nclassic\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skin.png"\r\nContent-Type: image/png\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.minecraftservices.com',
        path: '/minecraft/profile/skins',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': postData.length
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 204) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: data });
          }
        });
      });

      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.write(postData);
      req.end();
    });

  } catch (error) {
    return { success: false, error: error.message };
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
