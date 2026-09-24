const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('gsettingsApi', {
  snapshot: target => ipcRenderer.invoke('snapshot', target),
  readKey: request => ipcRenderer.invoke('read-key', request),
  startWatch: request => ipcRenderer.invoke('watch-start', request),
  stopWatch: () => ipcRenderer.invoke('watch-stop'),
  getExportDirectory: () => ipcRenderer.invoke('export-default-dir'),
  chooseExportDirectory: currentPath => ipcRenderer.invoke('choose-export-dir', currentPath),
  exportLog: payload => ipcRenderer.invoke('export-log', payload),
  onWatchEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('watch-event', listener)
    return () => ipcRenderer.removeListener('watch-event', listener)
  }
})
