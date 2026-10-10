import {
  contextBridge,
  ipcRenderer,
  type IpcRendererEvent,
} from 'electron'

interface ExportRequest {
  cutTimes: number[]
  duration: number
  fps: number
  reverse?: boolean
}

interface ExportProgress {
  current: number
  total: number
  percent: number
  fileName: string
}

contextBridge.exposeInMainWorld('videoEditor', {
  selectVideo: () => ipcRenderer.invoke('video:select'),
  exportSegments: (request: ExportRequest) => ipcRenderer.invoke('video:export', request),
  onExportProgress: (callback: (progress: ExportProgress) => void) => {
    const listener = (_event: IpcRendererEvent, progress: ExportProgress) => {
      callback(progress)
    }
    ipcRenderer.on('video:export-progress', listener)
    return () => ipcRenderer.removeListener('video:export-progress', listener)
  },
})