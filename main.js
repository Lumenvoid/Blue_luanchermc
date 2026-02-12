const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

let mainWindow;
const CLIENT_ID = 'f457da6e-1e63-45dd-81c6-2f9370d484e3';

const MINECRAFT_DIR = path.join(os.homedir(), 'AppData', 'Roaming', '.blue-minecraft');
const LIBRARIES_DIR = path.join(MINECRAFT_DIR, 'libraries');
const VERSIONS_DIR = path.join(MINECRAFT_DIR, 'versions');
const ASSETS_DIR = path.join(MINECRAFT_DIR, 'assets');

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

// Download helper
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      
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

// MINECRAFT DOWNLOAD & LAUNCH
ipcMain.handle('launch-minecraft', async (event, version, authData) => {
  try {
    // Zorg dat directories bestaan
    [MINECRAFT_DIR, LIBRARIES_DIR, VERSIONS_DIR, ASSETS_DIR].forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    // 1. Download Java als het niet bestaat
    const javaPath = await ensureJava();
    if (!javaPath) {
      return { success: false, error: 'Failed to download Java' };
    }

    // 2. Download version manifest
    const versionManifest = await getVersionManifest(version);
    if (!versionManifest) {
      return { success: false, error: 'Version not found' };
    }

    // 3. Download version JSON en client jar
    const versionDir = path.join(VERSIONS_DIR, version);
    if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

    const versionJsonPath = path.join(versionDir, `${version}.json`);
    if (!fs.existsSync(versionJsonPath)) {
      mainWindow.webContents.send('launch-status', 'Downloading version info...');
      await downloadFile(versionManifest.url, versionJsonPath);
    }

    const versionData = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));

    // Download client jar
    const clientJarPath = path.join(versionDir, `${version}.jar`);
    if (!fs.existsSync(clientJarPath)) {
      mainWindow.webContents.send('launch-status', 'Downloading Minecraft client...');
      await downloadFile(versionData.downloads.client.url, clientJarPath);
    }

    // 4. Download libraries
    mainWindow.webContents.send('launch-status', 'Downloading libraries...');
    const classpath = await downloadLibraries(versionData);

    // 5. Download assets
    mainWindow.webContents.send('launch-status', 'Downloading assets...');
    await downloadAssets(versionData);

    // 6. Launch!
    mainWindow.webContents.send('launch-status', 'Starting Minecraft...');
    return await startMinecraft(version, versionData, classpath, javaPath, authData);

  } catch (error) {
    console.error('Launch error:', error);
    return { success: false, error: error.message };
  }
});

async function ensureJava() {
  const javaDir = path.join(MINECRAFT_DIR, 'runtime', 'java-17');
  const javaExe = path.join(javaDir, 'bin', 'java.exe');
  
  if (fs.existsSync(javaExe)) {
    return javaExe;
  }

  // Download Adoptium Java 17
  mainWindow.webContents.send('launch-status', 'Downloading Java 17...');
  
  const javaZip = path.join(MINECRAFT_DIR, 'java.zip');
  const javaUrl = 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.9%2B9.1/OpenJDK17U-jdk_x64_windows_hotspot_17.0.9_9.zip';
  
  try {
    await downloadFile(javaUrl, javaZip);
    // Extract zou hier moeten gebeuren - voor nu gebruiken we systeem Java als fallback
    return null;
  } catch (e) {
    // Fallback: zoek systeem Java
    const systemJava = [
      'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe',
      'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe',
      'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.8.7-hotspot\\bin\\java.exe'
    ].find(p => fs.existsSync(p));
    
    return systemJava || null;
  }
}

async function getVersionManifest(version) {
  const manifest = await makeRequest({
    hostname: 'launchermeta.mojang.com',
    path: '/mc/game/version_manifest.json',
    method: 'GET'
  });
  
  const v = manifest.versions.find(v => v.id === version);
  return v || null;
}

async function downloadLibraries(versionData) {
  const classpath = [];
  
  for (const lib of versionData.libraries || []) {
    // Check rules
    if (lib.rules) {
      let allowed = false;
      for (const rule of lib.rules) {
        if (rule.os) {
          if (rule.os.name === 'windows' && rule.action === 'allow') allowed = true;
          if (rule.os.name === 'windows' && rule.action === 'disallow') allowed = false;
        } else if (rule.action === 'allow') {
          allowed = true;
        }
      }
      if (!allowed) continue;
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
        console.log('Failed to download:', artifact.url);
        continue;
      }
    }
    
    classpath.push(libPath);
  }
  
  return classpath;
}

async function downloadAssets(versionData) {
  const assetIndex = versionData.assetIndex;
  if (!assetIndex) return;

  const indexPath = path.join(ASSETS_DIR, 'indexes', `${assetIndex.id}.json`);
  if (!fs.existsSync(indexPath)) {
    const indexDir = path.dirname(indexPath);
    if (!fs.existsSync(indexDir)) fs.mkdirSync(indexDir, { recursive: true });
    await downloadFile(assetIndex.url, indexPath);
  }

  const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const objectsDir = path.join(ASSETS_DIR, 'objects');
  
  for (const [name, obj] of Object.entries(indexData.objects || {})) {
    const hash = obj.hash;
    const subDir = hash.substring(0, 2);
    const objPath = path.join(objectsDir, subDir, hash);
    
    if (!fs.existsSync(objPath)) {
      const dir = path.dirname(objPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      
      const url = `https://resources.download.minecraft.net/${subDir}/${hash}`;
      try {
        await downloadFile(url, objPath);
      } catch (e) {
        console.log('Failed asset:', name);
      }
    }
  }
}

async function startMinecraft(version, versionData, classpath, javaPath, authData) {
  const versionDir = path.join(VERSIONS_DIR, version);
  const clientJar = path.join(versionDir, `${version}.jar`);
  
  // Natives directory
  const nativesDir = path.join(versionDir, 'natives-windows');
  if (!fs.existsSync(nativesDir)) fs.mkdirSync(nativesDir, { recursive: true });

  // JVM arguments
  const jvmArgs = [
    '-Xmx2G',
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:G1NewSizePercent=30',
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=8M',
    '-XX:G1ReservePercent=20',
    '-XX:G1HeapWastePercent=5',
    `-Djava.library.path=${nativesDir}`,
    '-Dminecraft.launcher.brand=BlueLauncher',
    '-Dminecraft.launcher.version=1.0',
    '-cp', [...classpath, clientJar].join(';')
  ];

  // Game arguments
  const gameArgs = [
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

  console.log('Launching:', javaPath, gameArgs[0]);

  const mcProcess = spawn(javaPath, [...jvmArgs, ...gameArgs], {
    detached: true,
    stdio: 'ignore',
    cwd: MINECRAFT_DIR
  });

  mcProcess.unref();

  return { 
    success: true, 
    message: `Minecraft ${version} started as ${authData.user.name}` 
  };
}

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
