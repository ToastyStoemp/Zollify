// The renderer's whole surface: a few invokes and one event. The handlers are in electron/main.ts.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('printDesk', {
  settings: { get: invoke('settings:get'), set: invoke('settings:set') },
  pickFile: invoke('pick:file'),
  // A dropped File carries no path since Electron 32; this is the supported way to get it ('' when it has none).
  pathOf: (file) => webUtils.getPathForFile(file),
  pickExe: invoke('pick:exe'),
  zollify: {
    resume: invoke('zollify:resume'),
    login: invoke('zollify:login'),
    linkStart: invoke('zollify:linkStart'),
    linkPoll: invoke('zollify:linkPoll'),
    logout: invoke('zollify:logout'),
    catalog: invoke('zollify:catalog'),
    lastEventSold: invoke('zollify:lastEventSold'),
    setOnHand: invoke('zollify:setOnHand'),
  },
  photocraft: {
    printers: invoke('photocraft:printers'),
    size: invoke('photocraft:size'),
    lastPrint: invoke('photocraft:lastPrint'),
    describeSettings: invoke('photocraft:describeSettings'),
    print: invoke('photocraft:print'),
    onQueue: (cb) => {
      const handler = (_e, progress) => cb(progress);
      ipcRenderer.on('spooler:progress', handler);
      return () => ipcRenderer.off('spooler:progress', handler);
    },
  },
});
