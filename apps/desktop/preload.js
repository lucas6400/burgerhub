const { contextBridge, ipcRenderer } = require("electron");

/**
 * Ponte exposta pro painel web do BurgerHub detectar que está rodando dentro
 * do app desktop e usar impressão nativa em vez do fallback de navegador
 * (window.print) — ver apps/web/src/lib/print.ts.
 */
contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  printSilently: (html) => ipcRenderer.invoke("print-silent", html),
  getPrinters: () => ipcRenderer.invoke("get-printers"),
  getSelectedPrinter: () => ipcRenderer.invoke("get-selected-printer"),
  setSelectedPrinter: (name) => ipcRenderer.invoke("set-selected-printer", name),
  getAutoLaunch: () => ipcRenderer.invoke("get-auto-launch"),
  setAutoLaunch: (enabled) => ipcRenderer.invoke("set-auto-launch", enabled),
});
