'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// NEAR Agent defaults. Caps are in units of the default payment asset
// (NEAR here); see src/guardrails.js. Adapted from the PayPal Agent store:
// same JSON-file store, same API, NEAR defaults.
const DEFAULT_SETTINGS = {
  perTxCap: 50,
  dailyCap: 200,
  asset: 'NEAR',
  allowlist: [],
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * Sync JSON-file store backed by dataDir/settings.json, history.json, pending.json.
 * Files/directory are created if missing.
 */
function createStore(dataDir) {
  if (!dataDir) throw new Error('createStore requires a dataDir');
  fs.mkdirSync(dataDir, { recursive: true });

  const settingsFile = path.join(dataDir, 'settings.json');
  const historyFile = path.join(dataDir, 'history.json');
  const pendingFile = path.join(dataDir, 'pending.json');

  if (!fs.existsSync(settingsFile)) writeJson(settingsFile, DEFAULT_SETTINGS);
  if (!fs.existsSync(historyFile)) writeJson(historyFile, []);
  if (!fs.existsSync(pendingFile)) writeJson(pendingFile, {});

  function getSettings() {
    const raw = readJson(settingsFile, {});
    const settings = { ...DEFAULT_SETTINGS, ...(raw || {}) };
    // Back-compat: older settings files used `currency` for the default asset.
    if (!settings.asset && typeof settings.currency === 'string') {
      settings.asset = settings.currency;
    }
    if (!Array.isArray(settings.allowlist)) settings.allowlist = [];
    return settings;
  }

  function updateSettings(patch = {}) {
    const settings = { ...getSettings(), ...patch };
    if (!Array.isArray(settings.allowlist)) settings.allowlist = [];
    writeJson(settingsFile, settings);
    return settings;
  }

  function getAllowlist() {
    return getSettings().allowlist;
  }

  function addAllowlist(account) {
    const normalized = String(account).trim().toLowerCase();
    const settings = getSettings();
    if (!settings.allowlist.includes(normalized)) {
      settings.allowlist.push(normalized);
      writeJson(settingsFile, settings);
    }
    return settings.allowlist;
  }

  function removeAllowlist(account) {
    const normalized = String(account).trim().toLowerCase();
    const settings = getSettings();
    settings.allowlist = settings.allowlist.filter((e) => e !== normalized);
    writeJson(settingsFile, settings);
    return settings.allowlist;
  }

  function getHistory() {
    const raw = readJson(historyFile, []);
    return Array.isArray(raw) ? raw : [];
  }

  function addTransaction(tx = {}) {
    const history = getHistory();
    const entry = {
      id: tx.id || crypto.randomUUID(),
      timestamp: tx.timestamp || new Date().toISOString(),
      ...tx,
    };
    // Re-assert id/timestamp in case tx carried empty values.
    if (!entry.id) entry.id = crypto.randomUUID();
    if (!entry.timestamp) entry.timestamp = new Date().toISOString();
    history.push(entry);
    writeJson(historyFile, history);
    return entry;
  }

  function getTodayTotal() {
    const today = new Date().toISOString().slice(0, 10);
    return getHistory()
      .filter((tx) => tx.status === 'COMPLETED' && typeof tx.timestamp === 'string' && tx.timestamp.slice(0, 10) === today)
      .reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
  }

  function readPending() {
    const raw = readJson(pendingFile, {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }

  function savePending(p = {}) {
    const pending = readPending();
    const entry = { ...p, id: p.id || crypto.randomUUID() };
    pending[entry.id] = entry;
    writeJson(pendingFile, pending);
    return entry;
  }

  function getPending(id) {
    if (!id) return null;
    return readPending()[id] || null;
  }

  function deletePending(id) {
    const pending = readPending();
    const existed = Object.prototype.hasOwnProperty.call(pending, id);
    delete pending[id];
    writeJson(pendingFile, pending);
    return existed;
  }

  /** Demo/seed helpers (mock mode only at the API layer). */
  function clearHistory() {
    writeJson(historyFile, []);
    return [];
  }

  function clearPending() {
    writeJson(pendingFile, {});
    return {};
  }

  function resetSettings() {
    writeJson(settingsFile, { ...DEFAULT_SETTINGS });
    return { ...DEFAULT_SETTINGS };
  }

  return {
    getSettings,
    updateSettings,
    getAllowlist,
    addAllowlist,
    removeAllowlist,
    getHistory,
    addTransaction,
    getTodayTotal,
    savePending,
    getPending,
    deletePending,
    clearHistory,
    clearPending,
    resetSettings,
  };
}

module.exports = { createStore, DEFAULT_SETTINGS };
