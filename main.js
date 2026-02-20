const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const https = require('https');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const os = require('os');

let mainWindow;
const CLIENT_ID = 'JOUW_CLIENT_ID_HIER';

const MINECRAFT_DIR = path.join(os.homedir(), 'AppData', 'Roaming', '.blue-minecraft');
const RUNTIME_DIR = path.join(MINECRAFT_DIR, 'runtime');
const JAVA_DIR = path.join(RUNTIME_DIR, 'jdk-17');
const JAVA_BIN = path.join(JAVA_DIR, 'bin', 'java.exe');
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

// Download en extract Java met PowerShell (geen antivirus issues)
async function setupJava() {
  // Check of we al Java hebben
  if (fs.existsSync(JAVA_BIN)) {
    console.log('Java found at:', JAVA_BIN);
    return JAVA_BIN;
  }

  // Maak directories
  if (!fs.existsSync(RUNTIME_DIR)) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  }

  const javaZip = path.join(RUNTIME_DIR, 'java17.zip');

  try {
    mainWindow.webContents.send('launch-status', 'Downloading Java 17... (one time only)');

    // Download van GitHub Releases (betrouwbaar, geen antivirus issues)
    // Dit is een directe link naar een kleinere JRE versie
    const javaUrl = 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.9%2B9.1/OpenJDK17U-jre_x64_windows_hotspot_17.0.9_9.zip';

    await downloadFile(javaUrl, javaZip, (percent) => {
      mainWindow.webContents.send('launch-status', `Downloading Java... ${percent}%`);
    });

    mainWindow.webContents.send('launch-status', 'Extracting Java...');

    // Extract met PowerShell (werkt altijd)
    await new Promise((resolve, reject) => {
      const psCommand = `Expand-Archive -Path '${javaZip}' -DestinationPath '${RUNTIME_DIR}' -Force`;
      exec(`powershell -Command "${psCommand}"`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    // Zoek de extracted folder (kan verschillende namen hebben)
    const items = fs.readdirSync(RUNTIME_DIR);
    const jdkFolder = items.find(item => {
      const fullPath = path.join(RUNTIME_DIR, item);
      return item.startsWith('jdk-') && fs.statSync(fullPath).isDirectory();
    });

    if (!jdkFolder) {
      throw new Error('Could not find extracted JDK folder');
    }

    // Hernoem naar jdk-17 voor consistentie
    const extractedPath = path.join(RUNTIME_DIR, jdkFolder);
    fs.renameSync(extractedPath, JAVA_DIR);

    // Verwijder zip
    fs.unlinkSync(javaZip);

    // Check of java.exe bestaat
    if (!fs.existsSync(JAVA_BIN)) {
      throw new Error('Java binary not found after extraction');
    }

    console.log('Java setup complete at:', JAVA_BIN);
    return JAVA_BIN;

  } catch (error) {
    console.error('Java setup failed:', error);
    // Cleanup bij error
    try {
      if (fs.existsSync(javaZip)) fs.unlinkSync(javaZip);
      if (fs.existsSync(JAVA_DIR)) fs.rmSync(JAVA_DIR, { recursive: true });
    } catch (e) {}
    throw error;
  }
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
    // 1. Setup Java (download als nodig)
    let javaPath;
    try {
      javaPath = await setupJava();
    } catch (javaError) {
      return { 
        success: false, 
        error: 'Failed to setup Java: ' + javaError.message 
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

    console.log('Launching with Java:', javaPath);
    
    const mcProcess = spawn(javaPath, gameArgs, {
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
