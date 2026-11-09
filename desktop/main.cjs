// Electron shell: loads the built web client from app/ (file://). The client then connects to
// wss://surviver.yunix.software/ws (override: SURVIVER_SERVER=http://localhost:8080 env var).
const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b1220',
    title: 'Surviver',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const query = process.env.SURVIVER_SERVER ? { server: process.env.SURVIVER_SERVER } : {};
  win.loadFile(path.join(__dirname, 'app', 'play.html'), { query });
  // external links (site, admin) open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
}

// macOS keeps the default app menu: without it Cmd+Q / Cmd+C / Cmd+V (chat input) stop working
if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
