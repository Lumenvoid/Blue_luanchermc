const { app, BrowserWindow, ipcMain } = require("electron");
const { exec } = require("child_process");
const https = require("https");
const fs = require("fs");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true
    }
  });

  win.loadFile("index.html");
}

app.whenReady().then(createWindow);

/* Start Minecraft */
ipcMain.handle("start-minecraft", async () => {
  exec('"C:\\Program Files (x86)\\Minecraft Launcher\\MinecraftLauncher.exe"');
});

/* Download mod */
ipcMain.handle("download-mod", async (event, url, filename) => {
  const modsFolder = path.join(
    process.env.APPDATA,
    ".minecraft",
    "mods"
  );

  if (!fs.existsSync(modsFolder)) {
    fs.mkdirSync(modsFolder, { recursive: true });
  }

  const filePath = path.join(modsFolder, filename);

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);

    https.get(url, response => {
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve("done");
      });
    }).on("error", err => reject(err));
  });
});
