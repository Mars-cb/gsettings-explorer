const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('gsettingsApi', {
  snapshot: target => ipcRenderer.invoke('snapshot', target),
  readKey: request => ipcRenderer.invoke('read-key', request),
  startWatch: request => ipcRenderer.invoke('watch-start', request),
  stopWatch: () => ipcRenderer.invoke('watch-stop'),
  onWatchEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('watch-event', listener)
    return () => ipcRenderer.removeListener('watch-event', listener)
  }
})
