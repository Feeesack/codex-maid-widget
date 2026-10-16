'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('maid', {
  getState: () => ipcRenderer.invoke('state'),
  refresh: () => ipcRenderer.invoke('refresh'),
  setSettings: patch => ipcRenderer.invoke('settings', patch),
  action: name => ipcRenderer.invoke('action', name),
  importCharacters: () => ipcRenderer.invoke('import-characters'),
  selectCharacter: id => ipcRenderer.invoke('select-character', id),
  renameCharacter: (id,name) => ipcRenderer.invoke('rename-character', id,name),
  removeCharacter: id => ipcRenderer.invoke('remove-character', id),
  drag: phase => { if (['start','move','end'].includes(phase)) ipcRenderer.send('drag-' + phase); },
  pointerRegion: inside => ipcRenderer.send('pointer-region', !!inside),
  onState: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('state', listener); return () => ipcRenderer.removeListener('state', listener); },
  onBounce: callback => { const listener = () => callback(); ipcRenderer.on('bounce', listener); return () => ipcRenderer.removeListener('bounce', listener); },
});
