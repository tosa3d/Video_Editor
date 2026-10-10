import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, protocol, type OpenDialogOptions } from 'electron'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static') as string | null
const devServerUrl = process.env.VITE_DEV_SERVER_URL
const supportedExtensions = [
  'mp4',
  'mov',
  'mkv',
  'webm',
  'avi',
  'm4v',
  'mpeg',
  'mpg',
]

let mainWindow: BrowserWindow | null = null
let selectedVideoPath: string | null = null

interface ExportRequest {
  cutTimes: number[]
  duration: number
  fps: number
  reverseStarts?: number[]
}

interface ExportProgress {
  current: number
  total: number
  percent: number
  fileName: string
}

interface Segment {
  start: number
  end: number
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
])

function getFfmpegPath(): string {
  if (!ffmpegPath) {
    throw new Error('فایل اجرایی FFmpeg پیدا نشد.')
  }

  return app.isPackaged
    ? ffmpegPath.replace('app.asar', 'app.asar.unpacked')
    : ffmpegPath
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 940,
    minHeight: 660,
    backgroundColor: '#101314',
    title: 'برش',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

const videoMimeTypes: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
}

// Chromium can only seek a <video> whose source answers Range requests with 206.
// net.fetch on a file: URL ignores Range and returns 200, which leaves the video
// unseekable: every seek (timeline, frame step, segment click) snaps back to 0.
async function serveVideo(filePath: string, request: Request): Promise<Response> {
  const { size } = await stat(filePath)
  const extension = path.extname(filePath).slice(1).toLowerCase()
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Type': videoMimeTypes[extension] ?? 'application/octet-stream',
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')

  if (!range || (!range[1] && !range[2])) {
    const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream
    return new Response(body, {
      status: 200,
      headers: { ...headers, 'Content-Length': String(size) },
    })
  }

  // "bytes=-500" asks for the last 500 bytes; "bytes=100-" for everything from 100.
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  if (start >= size || start > end) {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` },
    })
  }

  const body = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream
  return new Response(body, {
    status: 206,
    headers: {
      ...headers,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
    },
  })
}

function buildSegments(cutTimes: number[], duration: number, fps: number): Segment[] {
  const minimumDuration = Math.max(1 / fps, 0.04)
  const validCuts = [...cutTimes]
    .filter((time) => Number.isFinite(time) && time > 0 && time < duration)
    .sort((a, b) => a - b)

  const boundaries = [0]
  for (const cut of validCuts) {
    const previous = boundaries[boundaries.length - 1] ?? 0
    if (cut - previous >= minimumDuration && duration - cut >= minimumDuration) {
      boundaries.push(cut)
    }
  }
  boundaries.push(duration)

  return boundaries.slice(0, -1).map((start, index) => ({
    start,
    end: boundaries[index + 1] ?? duration,
  }))
}

function safeBaseName(filePath: string): string {
  const baseName = path.parse(filePath).name
  const sanitized = baseName
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\p{Cc}/gu, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 80)

  return sanitized || 'video'
}

function parseFfmpegTime(output: string): number | null {
  const matches = [...output.matchAll(/time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/g)]
  const latest = matches.at(-1)
  if (!latest) return null

  const hours = Number(latest[1])
  const minutes = Number(latest[2])
  const seconds = Number(latest[3])
  return hours * 3600 + minutes * 60 + seconds
}

function detectFrameRate(inputPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = spawn(getFfmpegPath(), ['-hide_banner', '-i', inputPath], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let output = ''

    probe.stderr.on('data', (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-32_000)
    })
    probe.once('error', () => resolve(null))
    probe.once('close', () => {
      const match = output.match(/,\s*(\d+(?:\.\d+)?)\s+fps(?:,|\s)/i)
      const frameRate = match?.[1] ? Number(match[1]) : Number.NaN
      resolve(Number.isFinite(frameRate) && frameRate >= 1 && frameRate <= 240
        ? frameRate
        : null)
    })
  })
}

function encodeSegment(
  inputPath: string,
  outputPath: string,
  segment: Segment,
  fps: number,
  onProgress: (seconds: number) => void,
): Promise<void> {
  const segmentDuration = segment.end - segment.start
  // FFmpeg drops every frame stamped before -ss. Cuts sit exactly on a frame's start,
  // and printing that time rounds it up past the frame's own timestamp (11/30 →
  // 0.366667), which would drop the cut frame. Starting a quarter frame early keeps it;
  // -t is unchanged, so the frame at the next cut still falls outside this clip.
  const seekStart = Math.max(0, segment.start - 0.25 / fps)
  const args = [
    '-hide_banner',
    '-y',
    '-ss',
    seekStart.toFixed(6),
    '-i',
    inputPath,
    '-t',
    segmentDuration.toFixed(6),
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    '-avoid_negative_ts',
    'make_zero',
    outputPath,
  ]

  return runFfmpeg(args, onProgress)
}

// Plays an exported clip backwards (picture and sound), e.g. for the camera's return move.
// FFmpeg's reverse filter holds the whole clip in memory, which suits short clips.
// The clips' timestamps do not start at zero, so the reversed frames get fresh ones
// (setpts/asetpts) and pass straight through; otherwise FFmpeg drops and repeats
// frames to fit a constant rate.
function encodeReversed(
  inputPath: string,
  outputPath: string,
  onProgress: (seconds: number) => void,
): Promise<void> {
  const args = [
    '-hide_banner',
    '-y',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-vf',
    'reverse,setpts=N/FRAME_RATE/TB',
    '-af',
    'areverse,asetpts=N/SR/TB',
    '-fps_mode',
    'passthrough',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    outputPath,
  ]

  return runFfmpeg(args, onProgress)
}

function runFfmpeg(args: string[], onProgress: (seconds: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn(getFfmpegPath(), args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let errorOutput = ''

    process.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      errorOutput = `${errorOutput}${text}`.slice(-12_000)
      const encodedSeconds = parseFfmpegTime(text)
      if (encodedSeconds !== null) onProgress(encodedSeconds)
    })

    process.once('error', (error) => reject(error))
    process.once('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(errorOutput.trim() || `FFmpeg با کد ${code ?? 'نامشخص'} متوقف شد.`))
    })
  })
}

function registerIpcHandlers(): void {
  ipcMain.handle('video:select', async () => {
    const options: OpenDialogOptions = {
      title: 'انتخاب ویدیو',
      properties: ['openFile'],
      filters: [
        { name: 'فایل‌های ویدیویی', extensions: supportedExtensions },
        { name: 'همه فایل‌ها', extensions: ['*'] },
      ],
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled || !result.filePaths[0]) return null

    selectedVideoPath = path.resolve(result.filePaths[0])
    const fps = await detectFrameRate(selectedVideoPath)
    return {
      name: path.basename(selectedVideoPath),
      url: `media://video/current?version=${Date.now()}`,
      fps,
    }
  })

  ipcMain.handle('video:export', async (event, request: ExportRequest) => {
    if (!selectedVideoPath) {
      throw new Error('ابتدا یک فایل ویدیویی انتخاب کنید.')
    }
    if (!Number.isFinite(request.duration) || request.duration <= 0) {
      throw new Error('مدت ویدیو معتبر نیست.')
    }

    const fps = Number.isFinite(request.fps)
      ? Math.min(240, Math.max(1, request.fps))
      : 30
    const segments = buildSegments(request.cutTimes, request.duration, fps)
    if (segments.length === 0) {
      throw new Error('هیچ بخش معتبری برای خروجی وجود ندارد.')
    }

    const directoryResult = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: 'انتخاب پوشه خروجی',
          properties: ['openDirectory', 'createDirectory'],
        })
      : await dialog.showOpenDialog({
          title: 'انتخاب پوشه خروجی',
          properties: ['openDirectory', 'createDirectory'],
        })

    const outputDirectory = directoryResult.filePaths[0]
    if (directoryResult.canceled || !outputDirectory) {
      return { canceled: true, count: 0 }
    }

    const baseName = safeBaseName(selectedVideoPath)
    // Clips chosen for a reversed copy, matched by start time (0, or the cut that opens the clip).
    const reverseStarts = Array.isArray(request.reverseStarts) ? request.reverseStarts.filter(Number.isFinite) : []
    const isReversed = (segment: Segment) => reverseStarts.some((start) => Math.abs(start - segment.start) < 1e-6)
    const reversedCount = segments.filter(isReversed).length
    // Each clip is one step, plus one more for each reversed copy.
    const totalSteps = segments.length + reversedCount
    let step = 0
    const reportFor = (fileName: string, stepDuration: number) => {
      const stepIndex = step++
      return (seconds: number) => {
        const stepPercent = Math.min(1, seconds / stepDuration)
        const progress: ExportProgress = {
          current: stepIndex + 1,
          total: totalSteps,
          percent: Math.round(((stepIndex + stepPercent) / totalSteps) * 100),
          fileName,
        }
        if (!event.sender.isDestroyed()) {
          event.sender.send('video:export-progress', progress)
        }
      }
    }

    for (const [index, segment] of segments.entries()) {
      const partNumber = String(index + 1).padStart(2, '0')
      const fileName = `${baseName}_part_${partNumber}.mp4`
      const outputPath = path.join(outputDirectory, fileName)
      const segmentDuration = segment.end - segment.start

      await encodeSegment(selectedVideoPath, outputPath, segment, fps, reportFor(fileName, segmentDuration))

      if (isReversed(segment)) {
        const reversedName = `${baseName}_part_${partNumber}_reverse.mp4`
        await encodeReversed(outputPath, path.join(outputDirectory, reversedName), reportFor(reversedName, segmentDuration))
      }
    }

    return {
      canceled: false,
      count: segments.length,
      reversedCount,
      directory: outputDirectory,
    }
  })
}

app.whenReady().then(() => {
  protocol.handle('media', (request) => {
    if (!selectedVideoPath) {
      return new Response('Video not selected', { status: 404 })
    }

    return serveVideo(selectedVideoPath, request)
  })

  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})