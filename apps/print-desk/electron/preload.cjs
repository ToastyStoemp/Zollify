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
    forecast: invoke('zollify:forecast'),
    addOnHand: invoke('zollify:addOnHand'),
    priceData: invoke('zollify:priceData'),
  },
  cards: {
    pickPng: invoke('pick:png'),
    pickFolder: invoke('pick:folder'),
    dir: invoke('cards:dir'),
    draw: invoke('cards:draw'),
    setTexts: invoke('cards:setTexts'),
    sheets: invoke('cards:sheets'),
    pdf: invoke('cards:pdf'),
    print: invoke('cards:print'),
    image: invoke('cards:image'),
    open: invoke('cards:open'),
  },
  materials: {
    setKey: invoke('materials:setKey'),
    list: invoke('materials:list'),
    use: invoke('materials:use'),
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
