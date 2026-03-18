#!/usr/bin/env node
'use strict';

const bridge = require('../../lib/shannon_bridge.ts');

function notify(payload = {}) {
  return bridge.desktopShell({
    surface: 'notify',
    action: payload.action || 'notify',
    ...payload,
  });
}

function trayStatus(payload = {}) {
  return bridge.desktopShell({
    surface: 'tray',
    action: payload.action || 'status',
    ...payload,
  });
}

function offlineHistory(payload = {}) {
  return bridge.desktopShell({
    surface: 'history',
    action: payload.action || 'snapshot',
    ...payload,
  });
}

module.exports = {
  notify,
  trayStatus,
  offlineHistory,
};
