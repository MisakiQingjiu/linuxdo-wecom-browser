const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browserChrome', {
  navigate: (input) => ipcRenderer.send('nav', String(input ?? '')),
  back: () => ipcRenderer.send('back'),
  forward: () => ipcRenderer.send('forward'),
  reload: () => ipcRenderer.send('reload'),
  stop: () => ipcRenderer.send('stop'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
});
