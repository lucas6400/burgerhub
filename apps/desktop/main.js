const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, Notification } = require("electron");
const { autoUpdater } = require("electron-updater");
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

/** Versão já baixada esperando pra instalar (null = nada pendente). */
let updateReadyVersion = null;

function rebuildTrayMenu() {
  const autoLaunch = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir BurgerHub", click: () => mainWindow?.show() },
      ...(updateReadyVersion
        ? [{ label: `Reiniciar para atualizar (versão ${updateReadyVersion})`, click: () => installUpdateNow() }]
        : []),
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

// ---------------- Atualização automática ----------------
// O painel em si já atualiza sozinho (a janela carrega o site). Isto cobre o "motor" do app (impressão, bandeja):
// confere se há versão nova em desktop-updates.vercel.app, baixa em segundo plano e instala sozinha de madrugada
// (ou na hora, pelo menu da bandeja / ao fechar o app) — sem precisar baixar o instalador de novo.
const UPDATE_CHECK_EVERY_MS = 4 * 60 * 60_000;
const UPDATE_INSTALL_HOUR = 5; // 05:00 — a loja está fechada

function installUpdateNow() {
  isQuitting = true;
  autoUpdater.quitAndInstall(true, true);
}

function setupAutoUpdate() {
  if (!app.isPackaged) return; // só no app instalado (em desenvolvimento não há o que atualizar)
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (err) => console.error("[atualização]", err?.message ?? err));
  autoUpdater.on("update-downloaded", (info) => {
    updateReadyVersion = info.version;
    rebuildTrayMenu();
    new Notification({ title: "BurgerHub — atualização pronta", body: `A versão ${info.version} instala sozinha às ${UPDATE_INSTALL_HOUR}h, ou clique no ícone da bandeja → "Reiniciar para atualizar".` }).show();
  });
  const check = () => autoUpdater.checkForUpdates().catch((err) => console.error("[atualização]", err?.message ?? err));
  check();
  setInterval(check, UPDATE_CHECK_EVERY_MS);
  // Com a atualização baixada, instala de madrugada (o app fica ligado o dia todo, então "ao sair" quase nunca acontece).
  setInterval(() => {
    if (updateReadyVersion && new Date().getHours() === UPDATE_INSTALL_HOUR) installUpdateNow();
  }, 10 * 60_000);
}

// Sem isto o "fechar (X) vira bandeja" impediria o instalador da atualização de encerrar o app.
app.on("before-quit", () => {
  isQuitting = true;
});

app.whenReady().then(() => {
  createMainWindow();
  createTray();
  setupAutoUpdate();

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

const MM_TO_PX = 3.7795;
const PAINT_WAIT_MS = 400;

/**
 * Imprime um HTML de cupom direto na impressora escolhida, sem caixa de diálogo e sem margens.
 *
 * NÃO manda tamanho de papel: o papel é o que está configurado na impressora (driver do Windows). Mandar um tamanho
 * personalizado (versão 0.2.0) fez a térmica ignorar o cupom e soltar só ~1 cm de papel em branco. O cupom é montado
 * na largura do papel configurada no painel (58/80 mm), então só a largura do conteúdo é ajustada — por CSS.
 */
ipcMain.handle("print-silent", async (_event, html, opts) => {
  const widthMm = Number(opts?.widthMm) > 0 ? Number(opts.widthMm) : 80;
  const printerName = store.get("printerName", null);
  // A janela escondida tem a largura do papel: o cupom é montado na mesma largura em que será impresso.
  const printWin = new BrowserWindow({ show: false, width: Math.ceil(widthMm * MM_TO_PX), height: 800, useContentSize: true, webPreferences: { sandbox: true } });
  try {
    await printWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    // Dá um instante pra janela escondida pintar o cupom antes de mandar pra impressora.
    await new Promise((r) => setTimeout(r, PAINT_WAIT_MS));
    return await new Promise((resolve) => {
      printWin.webContents.print(
        {
          silent: true,
          printBackground: true,
          margins: { marginType: "none" },
          ...(printerName ? { deviceName: printerName } : {}),
        },
        (success, reason) => resolve({ success, reason }),
      );
    });
  } finally {
    printWin.destroy();
  }
});
