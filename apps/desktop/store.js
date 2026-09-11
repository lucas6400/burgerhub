/** Configurações persistidas do app (impressora escolhida, etc.) — um JSON simples em vez de dependência extra. */
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

function storePath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), "utf-8"));
  } catch {
    return {};
  }
}

function writeAll(data) {
  fs.writeFileSync(storePath(), JSON.stringify(data, null, 2));
}

function get(key, fallback) {
  const data = readAll();
  return key in data ? data[key] : fallback;
}

function set(key, value) {
  const data = readAll();
  data[key] = value;
  writeAll(data);
}

module.exports = { get, set };
