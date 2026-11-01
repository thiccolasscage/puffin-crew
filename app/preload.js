'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crew', {
  call: (method, ...args) => ipcRenderer.invoke('crew:invoke', method, args),
  onUpdate: (fn) => ipcRenderer.on('crew:update', (_e, payload) => fn(payload)),
  onFocus: (fn) => ipcRenderer.on('crew:focus', (_e, payload) => fn(payload)),
});
