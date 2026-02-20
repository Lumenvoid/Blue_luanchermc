const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

let mainWindow;
const CLIENT_ID = 'f457da6e-1e63-45dd-81c6-2f9370d484e3';

const MINECRAFT_DIR = path.join(os.homedir(), 'AppData', 'Roaming', '.blue-minecraft');
const LIBRARIES_DIR = path.join(MINECRAFT_DIR, 'libraries');
const VERSIONS_DIR = path.join(MINECRAFT_DIR, 'versions');
const ASSETS_DIR = path.join(MINECRAFT_DIR, 'assets');

// JAVA PAD - meegeleverd in de build
const JAVA_BIN = app.isPackaged 
  ? path.join(process.resourcesPath, 'java', 'jdk-17', 'bin', 'java.exe')
  : path.join(__dirname, 'java', 'jdk-17', 'bin', 'java.exe');

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

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : require('http');
    
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        downloadFile(response.headers.location, dest, onProgress).then(resolve).catch(reject);
        return;
      }
      
      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;
      
      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (onProgress && totalSize) {
          const percent = Math.round((downloadedSize / totalSize) * 100);
          onProgress(percent);
        }
      });
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// Check of meegeleverde Java bestaat
function checkBundledJava() {
  console.log('Looking for Java at:', JAVA_BIN);
  if (fs.existsSync(JAVA_BIN)) {
    console.log('Found bundled Java!');
    return true;
  }
  console.log('Bundled Java not found!');
  return false;
}

// AUTH handlers
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

// MINECRAFT LAUNCH
ipcMain.handle('launch-minecraft', async (event, version, authData) => {
  try {
    // 1. Check Java
    if (!checkBundledJava()) {
      return { 
        success: false, 
        error: 'Bundled Java not found. Please reinstall the launcher.' 
      };
    }

    // 2. Maak directories
    [MINECRAFT_DIR, LIBRARIES_DIR, VERSIONS_DIR, ASSETS_DIR].forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    // 3. Download version info
    mainWindow.webContents.send('launch-status', 'Getting version info...');
    const manifest = await makeRequest({
      hostname: 'launchermeta.mojang.com',
      path: '/mc/game/version_manifest.json',
      method: 'GET'
    });
    
    const versionInfo = manifest.versions.find(v => v.id === version);
    if (!versionInfo) return { success: false, error: 'Version not found' };

    // 4. Download version JSON
    const versionDir = path.join(VERSIONS_DIR, version);
    if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

    const versionJsonPath = path.join(versionDir, `${version}.json`);
    if (!fs.existsSync(versionJsonPath)) {
      mainWindow.webContents.send('launch-status', 'Downloading version info...');
      await downloadFile(versionInfo.url, versionJsonPath);
    }

    const versionData = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));

    // 5. Download client jar
    const clientJarPath = path.join(versionDir, `${version}.jar`);
    if (!fs.existsSync(clientJarPath)) {
      mainWindow.webContents.send('launch-status', 'Downloading Minecraft...');
      await downloadFile(versionData.downloads.client.url, clientJarPath, (pct) => {
        mainWindow.webContents.send('launch-status', `Downloading Minecraft... ${pct}%`);
      });
    }

    // 6. Download libraries
    mainWindow.webContents.send('launch-status', 'Checking libraries...');
    const classpath = [];
    
    for (const lib of versionData.libraries || []) {
      if (lib.rules) {
        let skip = false;
        for (const rule of lib.rules) {
          if (rule.os && rule.os.name !== 'windows' && rule.action === 'allow') skip = true;
        }
        if (skip) continue;
      }

      const artifact = lib.downloads?.artifact;
      if (!artifact) continue;

      const libPath = path.join(LIBRARIES_DIR, artifact.path);
      
      if (!fs.existsSync(libPath)) {
        const dir = path.dirname(libPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        try {
          await downloadFile(artifact.url, libPath);
        } catch (e) {
          console.log('Failed lib:', artifact.path);
          continue;
        }
      }
      
      classpath.push(libPath);
    }

    // 7. Download asset index
    const assetIndex = versionData.assetIndex;
    if (assetIndex) {
      const indexDir = path.join(ASSETS_DIR, 'indexes');
      if (!fs.existsSync(indexDir)) fs.mkdirSync(indexDir, { recursive: true });
      
      const indexPath = path.join(indexDir, `${assetIndex.id}.json`);
      if (!fs.existsSync(indexPath)) {
        mainWindow.webContents.send('launch-status', 'Downloading assets index...');
        await downloadFile(assetIndex.url, indexPath);
      }
    }

    // 8. Launch!
    mainWindow.webContents.send('launch-status', 'Starting Minecraft...');
    
    const gameArgs = [
      `-Xmx2G`,
      `-XX:+UseG1GC`,
      `-XX:+ParallelRefProcEnabled`,
      `-XX:MaxGCPauseMillis=200`,
      `-Djava.library.path=${versionDir}`,
      `-cp`, [...classpath, clientJarPath].join(';'),
      versionData.mainClass,
      '--username', authData.user.name,
      '--version', version,
      '--gameDir', MINECRAFT_DIR,
      '--assetsDir', ASSETS_DIR,
      '--assetIndex', versionData.assetIndex?.id || 'legacy',
      '--uuid', authData.user.id,
      '--accessToken', authData.tokens.minecraft.access_token,
      '--userType', 'msa',
      '--versionType', 'release'
    ];

    console.log('Launching with bundled Java:', JAVA_BIN);
    
    const mcProcess = spawn(JAVA_BIN, gameArgs, {
      detached: true,
      stdio: 'ignore',
      cwd: MINECRAFT_DIR,
      windowsHide: false
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
    const base64Data = skinDataUrl.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

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
