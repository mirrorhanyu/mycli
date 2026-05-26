const fs = require("node:fs");
const path = require("node:path");

const CLIS_DIR = path.resolve(__dirname, "..", "clis");

const registry = new Map();

function defineCommand(spec) {
  if (!spec || !spec.site || !spec.name) {
    throw new Error("defineCommand requires { site, name, handler, ... }");
  }
  const key = `${spec.site}:${spec.name}`;
  registry.set(key, spec);
  return spec;
}

function getCommand(site, name) {
  return registry.get(`${site}:${name}`);
}

function listCommands(site) {
  return [...registry.values()].filter((spec) => !site || spec.site === site);
}

function listSites() {
  return [...new Set([...registry.values()].map((spec) => spec.site))].sort();
}

function loadSite(site) {
  const indexPath = path.join(CLIS_DIR, site, "index.js");
  if (!fs.existsSync(indexPath)) return false;
  require(indexPath);
  return true;
}

function loadAllSites() {
  if (!fs.existsSync(CLIS_DIR)) return;
  for (const entry of fs.readdirSync(CLIS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    try {
      loadSite(entry.name);
    } catch (error) {
      console.error(`[mycli] Failed to load site ${entry.name}: ${error.message}`);
    }
  }
}

function userscriptPath(site) {
  return path.join(CLIS_DIR, site, "userscript.user.js");
}

module.exports = {
  defineCommand,
  getCommand,
  listCommands,
  listSites,
  loadSite,
  loadAllSites,
  userscriptPath,
  CLIS_DIR,
};
