const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require("electron");
const path = require("path");
const store = require("./store");
const TRAY_ICON_DATA_URL = require("./tray-icon");

const APP_URL = "https://burgerhub-web.vercel.app";
const ALLOWED_HOSTS = new Set(["burgerhub-web.vercel.app"]);
const ICON_PATH = path.join(__dirname, "build", "icon.ico");

let mainWindow = null;
let tray = null;
let isQuitting = false;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: "BurgerHub",
    backgroundColor: "#0b0f14",
    autoHideMenuBar: true,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Sem isso, o Electron pausa/reduz timers em janela minimizada/oculta —
      // quebraria o polling de pedido novo (e a impressão automática) assim
      // que o app fosse pra bandeja.
      backgroundThrottling: false,
    },
  });

  mainWindow.loadURL(APP_URL);

  // Só navega dentro do próprio domínio do painel — qualquer link externo
  // (ex.: cardápio digital compartilhado, WhatsApp Web) abre no navegador padrão.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      /* url inválida — deixa o próprio Electron rejeitar */
    }
    if (!ALLOWED_HOSTS.has(host)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Fechar (X) minimiza pra bandeja em vez de encerrar — mantém o alerta de
  // pedido novo e a impressão automática rodando em segundo plano.
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function rebuildTrayMenu() {
  const autoLaunch = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir BurgerHub", click: () => mainWindow?.show() },
      { type: "separator" },
      {
        label: "Iniciar com o Windows",
        type: "checkbox",
        checked: autoLaunch,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: "separator" },
      {
        label: "Sair",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  // Ícone embutido em base64 (tray-icon.js) em vez de carregado por path —
  // se o arquivo não fosse empacotado certinho no instalador (asar), o
  // nativeImage vinha vazio e a bandeja ficava com ícone invisível/em branco.
  // Redimensionado explicitamente pra 16x16, tamanho que a bandeja do Windows espera.
  const trayIcon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL).resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip("BurgerHub");
  tray.on("click", () => mainWindow?.show());
  rebuildTrayMenu();
}

app.whenReady().then(() => {
  createMainWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else mainWindow?.show();
  });
});

// Fica na bandeja mesmo com a janela fechada — não é o padrão usual do
// Electron, mas é o comportamento pretendido (app tipo PDV, sempre ligado).
app.on("window-all-closed", () => {});

// ---------------- IPC: impressão nativa e configurações ----------------

ipcMain.handle("get-printers", async () => {
  if (!mainWindow) return [];
  return mainWindow.webContents.getPrintersAsync();
});

ipcMain.handle("get-selected-printer", () => store.get("printerName", null));
ipcMain.handle("set-selected-printer", (_event, name) => {
  store.set("printerName", name);
  return true;
});

ipcMain.handle("get-auto-launch", () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle("set-auto-launch", (_event, enabled) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled });
  return true;
});

/** Imprime um HTML de cupom direto na impressora escolhida, sem caixa de diálogo. */
ipcMain.handle("print-silent", async (_event, html) => {
  const printerName = store.get("printerName", null);
  const printWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await printWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await new Promise((resolve) => {
      printWin.webContents.print(
        { silent: true, printBackground: true, ...(printerName ? { deviceName: printerName } : {}) },
        (success, reason) => resolve({ success, reason }),
      );
    });
  } finally {
    printWin.destroy();
  }
});
