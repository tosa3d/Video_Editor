import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react'
import './App.css'

type Notice = { type: 'success' | 'error' | 'info'; text: string }

interface Segment {
  start: number
  end: number
}

function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      {children}
    </svg>
  )
}

const FolderIcon = () => (
  <Icon>
    <path d="M3.5 7.5h6l2-2h9v13h-17v-11Z" stroke="currentColor" strokeWidth="1.7" />
  </Icon>
)

const PlayIcon = ({ playing }: { playing: boolean }) => (
  <Icon size={22}>
    {playing ? (
      <path d="M8 6v12M16 6v12" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" />
    ) : (
      <path d="m9 6 9 6-9 6V6Z" fill="currentColor" />
    )}
  </Icon>
)

const CutIcon = () => (
  <Icon size={22}>
    <circle cx="6" cy="7" r="3" stroke="currentColor" strokeWidth="1.7" />
    <circle cx="6" cy="17" r="3" stroke="currentColor" strokeWidth="1.7" />
    <path d="m8.5 8.5 11 7M8.5 15.5l11-7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
  </Icon>
)

const ExportIcon = () => (
  <Icon>
    <path d="M12 15V3m0 0L8 7m4-4 4 4M5 13v7h14v-7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
  </Icon>
)

const StepIcon = ({ direction }: { direction: 'back' | 'forward' }) => (
  <Icon>
    <path
      d={direction === 'forward' ? 'M17 6v12M7 6l8 6-8 6V6Z' : 'M7 6v12m10-12-8 6 8 6V6Z'}
      fill="currentColor"
    />
  </Icon>
)

const TrashIcon = () => (
  <Icon size={17}>
    <path d="M5 7h14M9 7V4h6v3m2 0-1 13H8L7 7m3 4v5m4-5v5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
  </Icon>
)

// Index of the frame on screen at `seconds`. Media timestamps are truncated to
// microseconds (frame 11 at 30 FPS starts at 0.3666667 but reads back as 0.366666),
// so a tiny tolerance keeps a frame's own start time from counting as the frame before.
function frameAt(seconds: number, fps: number): number {
  return Math.max(0, Math.floor(seconds * fps + 0.001))
}

// Where to seek to show `frame`: a quarter frame past its start. Seeking to the exact
// start can land on the previous frame because of the same microsecond truncation.
function frameSeekTime(frame: number, fps: number): number {
  return (frame + 0.25) / fps
}

function formatTimecode(seconds: number, fps: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00:00'
  const safeFps = Math.max(1, Math.round(fps))
  const wholeSeconds = Math.floor(seconds)
  const hours = Math.floor(wholeSeconds / 3600)
  const minutes = Math.floor((wholeSeconds % 3600) / 60)
  const secs = wholeSeconds % 60
  const frames = Math.min(safeFps - 1, frameAt(seconds % 1, safeFps))
  return [hours, minutes, secs, frames]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

function formatShortTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '00:00.0'
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${String(minutes).padStart(2, '0')}:${secs.toFixed(1).padStart(4, '0')}`
}

const REVERSE_PREF = 'boresh.exportReversed'

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [video, setVideo] = useState<VideoSelection | null>(null)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [fps, setFps] = useState(30)
  const [cutTimes, setCutTimes] = useState<number[]>([])
  const [isPlaying, setIsPlaying] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  // On by default; the choice is remembered between sessions.
  const [exportReversed, setExportReversed] = useState(() => {
    try { return localStorage.getItem(REVERSE_PREF) !== 'off' } catch { return true }
  })

  const toggleExportReversed = (event: ChangeEvent<HTMLInputElement>) => {
    const on = event.currentTarget.checked
    setExportReversed(on)
    try { localStorage.setItem(REVERSE_PREF, on ? 'on' : 'off') } catch { /* storage unavailable */ }
  }

  const segments = useMemo<Segment[]>(() => {
    if (duration <= 0) return []
    const boundaries = [0, ...cutTimes, duration]
    return boundaries.slice(0, -1).map((start, index) => ({
      start,
      end: boundaries[index + 1] ?? duration,
    }))
  }, [cutTimes, duration])

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0

  const seekTo = useCallback(
    (time: number) => {
      const player = videoRef.current
      if (!player || duration <= 0) return
      const nextTime = Math.min(duration, Math.max(0, time))
      player.currentTime = nextTime
      setCurrentTime(nextTime)
    },
    [duration],
  )

  const seekFromButton = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      seekTo(Number(event.currentTarget.dataset.time))
    },
    [seekTo],
  )

  const seekFromTimeline = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      seekTo(frameSeekTime(Math.round(Number(event.currentTarget.value) * fps), fps))
    },
    [fps, seekTo],
  )

  const togglePlayback = useCallback(async () => {
    const player = videoRef.current
    if (!player || !video) return

    if (player.paused) {
      try {
        await player.play()
      } catch {
        setNotice({ type: 'error', text: 'پخش ویدیو امکان‌پذیر نیست.' })
      }
    } else {
      player.pause()
    }
  }, [video])

  // Steps by seeking straight to the neighbouring frame. currentTime already holds the
  // target of a seek still in progress, so holding the key keeps counting frames.
  const stepFrame = useCallback(
    (direction: -1 | 1) => {
      const player = videoRef.current
      if (!player || duration <= 0) return
      player.pause()
      const lastFrame = Math.max(0, Math.ceil(duration * fps - 0.001) - 1)
      const targetFrame = Math.min(lastFrame, Math.max(0, frameAt(player.currentTime, fps) + direction))
      seekTo(frameSeekTime(targetFrame, fps))
    },
    [duration, fps, seekTo],
  )

  const addCut = useCallback(() => {
    if (!video || duration <= 0) return
    // A cut sits exactly at the start of the frame on screen, so that frame opens the next clip.
    const time = frameAt(videoRef.current?.currentTime ?? currentTime, fps) / fps
    const tolerance = Math.max(1 / fps, 0.04)

    if (time <= tolerance || duration - time <= tolerance) {
      setNotice({ type: 'info', text: 'نقطه برش باید از ابتدا و انتهای ویدیو فاصله داشته باشد.' })
      return
    }

    setCutTimes((previous) => {
      if (previous.some((cut) => Math.abs(cut - time) < tolerance)) {
        setNotice({ type: 'info', text: 'در این فریم قبلاً برش ثبت شده است.' })
        return previous
      }
      setNotice({ type: 'success', text: `برش در ${formatTimecode(time, fps)} ثبت شد.` })
      return [...previous, time].sort((a, b) => a - b)
    })
  }, [currentTime, duration, fps, video])

  const removeCut = (time: number) => {
    setCutTimes((previous) => previous.filter((cut) => cut !== time))
    setNotice({ type: 'info', text: 'نقطه برش حذف شد.' })
  }

  const loadVideo = useCallback((selection: VideoSelection) => {
    videoRef.current?.pause()
    setVideo(selection)
    setDuration(0)
    setCurrentTime(0)
    if (selection.fps && Number.isFinite(selection.fps)) setFps(selection.fps)
    setCutTimes([])
    setIsPlaying(false)
    setExportProgress(null)
    setNotice({ type: 'success', text: 'ویدیو آماده تدوین است.' })
  }, [])

  const handleBrowserFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    if (!file) return

    loadVideo({ name: file.name, url: URL.createObjectURL(file) })
    event.currentTarget.value = ''
  }

  const selectVideo = async () => {
    const api = window.videoEditor
    if (!api) {
      fileInputRef.current?.click()
      return
    }

    try {
      const selection = await api.selectVideo()
      if (!selection) return
      loadVideo(selection)
    } catch (error) {
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : 'فایل ویدیو باز نشد.',
      })
    }
  }

  const exportSegments = async () => {
    if (!video || duration <= 0 || isExporting) return
    const api = window.videoEditor
    if (!api) {
      setNotice({
        type: 'info',
        text: 'برای گرفتن خروجی، فایل اجرایی نسخه رومیزی برنامه را باز کنید.',
      })
      return
    }

    setIsExporting(true)
    setExportProgress({ current: 1, total: segments.length * (exportReversed ? 2 : 1), percent: 0, fileName: '' })
    setNotice({ type: 'info', text: 'در حال آماده‌سازی خروجی‌ها…' })

    try {
      const result = await api.exportSegments({ cutTimes, duration, fps, reverse: exportReversed })
      if (result.canceled) {
        setExportProgress(null)
        setNotice({ type: 'info', text: 'خروجی گرفتن لغو شد.' })
      } else {
        setExportProgress((previous) =>
          previous ? { ...previous, percent: 100 } : previous,
        )
        setNotice({
          type: 'success',
          text: result.reversedCount
            ? `${result.count.toLocaleString('fa-IR')} کلیپ و ${result.reversedCount.toLocaleString('fa-IR')} نسخه‌ی برعکس ذخیره شد.`
            : `${result.count.toLocaleString('fa-IR')} کلیپ با موفقیت ذخیره شد.`,
        })
      }
    } catch (error) {
      setExportProgress(null)
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : 'ساخت خروجی با خطا روبه‌رو شد.',
      })
    } finally {
      setIsExporting(false)
    }
  }

  useEffect(() => {
    const api = window.videoEditor
    if (!api) return
    return api.onExportProgress(setExportProgress)
  }, [])

  useEffect(() => {
    const objectUrl = video?.url
    if (!objectUrl?.startsWith('blob:')) return
    return () => URL.revokeObjectURL(objectUrl)
  }, [video?.url])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      // The timeline slider keeps focus after a click; shortcuts must still work there.
      const isSlider = target instanceof HTMLInputElement && target.type === 'range'
      if (
        target?.isContentEditable ||
        (!isSlider && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? ''))
      ) {
        return
      }

      if (event.code === 'Space') {
        event.preventDefault()
        void togglePlayback()
      } else if (event.code === 'Period') {
        event.preventDefault()
        stepFrame(1)
      } else if (event.code === 'Comma') {
        event.preventDefault()
        stepFrame(-1)
      } else if (event.code === 'KeyZ') {
        event.preventDefault()
        addCut()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [addCut, stepFrame, togglePlayback])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  return (
    <div className="app-shell">
      <input
        accept="video/*,.mkv,.m4v,.avi,.mpeg,.mpg"
        hidden
        onChange={handleBrowserFile}
        ref={fileInputRef}
        type="file"
      />
      <header className="topbar">
        <div className="brand" aria-label="برش، تدوین ویدیو">
          <span className="brand-mark"><CutIcon /></span>
          <span className="brand-copy">
            <strong>بُرش</strong>
            <small>تقسیم ساده و دقیق ویدیو</small>
          </span>
        </div>

        <div className="topbar-actions">
          <span className="offline-badge"><i /> پردازش آفلاین</span>
          <button className="button button-secondary" onClick={selectVideo} type="button">
            <FolderIcon />
            {video ? 'تغییر ویدیو' : 'انتخاب ویدیو'}
          </button>
          <button
            className="button button-primary"
            disabled={!video || duration <= 0 || isExporting}
            onClick={() => void exportSegments()}
            type="button"
          >
            <ExportIcon />
            {isExporting ? 'در حال خروجی…' : `خروجی ${segments.length || ''} کلیپ`}
          </button>
        </div>
      </header>

      <main className="editor">
        <section className="viewer-panel panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">پیش‌نمایش</span>
              <h1 title={video?.name}>{video?.name ?? 'هنوز ویدیویی انتخاب نشده'}</h1>
            </div>
            <div className="timecode" dir="ltr">{formatTimecode(currentTime, fps)}</div>
          </div>

          <div className={`video-stage ${video ? 'has-video' : ''}`}>
            {video ? (
              <video
                key={video.url}
                onClick={() => void togglePlayback()}
                onDurationChange={(event) => {
                  const nextDuration = event.currentTarget.duration
                  if (Number.isFinite(nextDuration)) setDuration(nextDuration)
                }}
                onEnded={() => setIsPlaying(false)}
                onError={() => setNotice({ type: 'error', text: 'فرمت این ویدیو قابل پخش نیست.' })}
                onLoadedMetadata={(event) => {
                  const nextDuration = event.currentTarget.duration
                  if (Number.isFinite(nextDuration)) setDuration(nextDuration)
                }}
                onPause={() => setIsPlaying(false)}
                onPlay={() => setIsPlaying(true)}
                onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime)}
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                preload="metadata"
                ref={videoRef}
                src={video.url}
              />
            ) : (
              <div className="empty-state">
                <div className="film-window">
                  <span /><span /><span /><span />
                  <CutIcon />
                </div>
                <h2>ویدیوت را روی میز تدوین بگذار</h2>
                <p>یک فایل انتخاب کن؛ برش‌ها بدون ارسال فایل به اینترنت انجام می‌شوند.</p>
                <button className="button button-primary" onClick={selectVideo} type="button">
                  <FolderIcon /> انتخاب فایل ویدیو
                </button>
              </div>
            )}
          </div>

          <div className="transport" aria-label="کنترل پخش">
            <button
              aria-label="یک فریم جلو"
              className="transport-button frame-button"
              disabled={!video}
              onClick={() => stepFrame(1)}
              title="یک فریم جلو (.)"
              type="button"
            >
              <StepIcon direction="forward" />
              <span>فریم بعد</span>
            </button>
            <button
              aria-label={isPlaying ? 'توقف' : 'پخش'}
              className="play-button"
              disabled={!video}
              onClick={() => void togglePlayback()}
              type="button"
            >
              <PlayIcon playing={isPlaying} />
            </button>
            <button
              aria-label="یک فریم عقب"
              className="transport-button frame-button"
              disabled={!video}
              onClick={() => stepFrame(-1)}
              title="یک فریم عقب (,)"
              type="button"
            >
              <StepIcon direction="back" />
              <span>فریم قبل</span>
            </button>
            <span className="transport-timecode" dir="ltr">
              {formatTimecode(currentTime, fps)}
            </span>
            <span className="transport-divider" />
            <button className="cut-button" disabled={!video} onClick={addCut} type="button">
              <CutIcon />
              برش در این فریم
              <kbd>Z</kbd>
            </button>
          </div>
        </section>

        <aside className="segments-panel panel">
          <div className="panel-heading segments-heading">
            <div>
              <span className="eyebrow">خروجی‌ها</span>
              <h2>کلیپ‌های جداگانه</h2>
            </div>
            <span className="count-badge">{segments.length.toLocaleString('fa-IR')}</span>
          </div>

          <div className="segments-list">
            {segments.length > 0 ? segments.map((segment, index) => {
              const active = currentTime >= segment.start && currentTime < segment.end
              const endingCut = cutTimes[index]
              return (
                <article className={`segment-card ${active ? 'active' : ''}`} key={`${segment.start}-${segment.end}`}>
                  <button
                    className="segment-main"
                    data-time={segment.start}
                    onClick={seekFromButton}
                    type="button"
                  >
                    <span className="segment-number">{String(index + 1).padStart(2, '0')}</span>
                    <span className="segment-details">
                      <strong>کلیپ {index + 1}</strong>
                      <small dir="ltr">{formatShortTime(segment.start)} — {formatShortTime(segment.end)}</small>
                    </span>
                    <span className="segment-duration" dir="ltr">{formatShortTime(segment.end - segment.start)}</span>
                  </button>
                  {endingCut !== undefined && (
                    <button
                      aria-label={`حذف برش ${index + 1}`}
                      className="delete-cut"
                      onClick={() => removeCut(endingCut)}
                      title="حذف نقطه برش"
                      type="button"
                    >
                      <TrashIcon />
                    </button>
                  )}
                </article>
              )
            }) : (
              <div className="segments-empty">
                <span>—</span>
                <p>پس از انتخاب ویدیو، کلیپ‌ها اینجا نمایش داده می‌شوند.</p>
              </div>
            )}
          </div>

          <div className="fps-control">
            <label htmlFor="fps">نرخ فریم ویدیو</label>
            <div>
              <input
                id="fps"
                max="240"
                min="1"
                onChange={(event) => setFps(Math.min(240, Math.max(1, Number(event.target.value) || 30)))}
                step="0.01"
                type="number"
                value={fps}
              />
              <span>FPS</span>
            </div>
            <small>برای حرکت دقیق فریم‌به‌فریم، با نرخ ویدیو یکسان باشد.</small>
          </div>

          <label className="reverse-control">
            <input
              checked={exportReversed}
              disabled={isExporting}
              onChange={toggleExportReversed}
              type="checkbox"
            />
            <span>
              <strong>نسخه‌ی برعکس هر کلیپ را هم بساز</strong>
              <small>کنار هر کلیپ، همان کلیپ از آخر به اول ذخیره می‌شود؛ مثلاً برای حرکت برگشت دوربین. نام: <bdi dir="ltr">…_part_01_reverse.mp4</bdi></small>
            </span>
          </label>
        </aside>

        <section className="timeline-panel panel">
          <div className="timeline-header">
            <div>
              <span className="eyebrow">خط زمان</span>
              <span className="cut-summary">{cutTimes.length.toLocaleString('fa-IR')} نقطه برش</span>
            </div>
            <div className="shortcut-guide">
              <span><kbd>Space</kbd> پخش / توقف</span>
              <span><kbd>,</kbd><kbd>.</kbd> حرکت فریم</span>
              <span><kbd>Z</kbd> برش</span>
            </div>
          </div>

          <div className="timeline-wrap" dir="ltr">
            <div className="timeline-ruler" aria-hidden="true">
              {Array.from({ length: 9 }, (_, index) => (
                <span key={index} style={{ left: `${(index / 8) * 100}%` }}>
                  {formatShortTime((duration * index) / 8)}
                </span>
              ))}
            </div>
            <div
              className="timeline-track"
              style={{ '--progress': `${progressPercent}%` } as CSSProperties}
            >
              <div className="track-film" />
              {cutTimes.map((cut, index) => (
                <button
                  aria-label={`برش ${index + 1} در ${formatShortTime(cut)}`}
                  className="cut-marker"
                  data-time={cut}
                  key={cut}
                  onClick={seekFromButton}
                  style={{ left: `${(cut / duration) * 100}%` }}
                  title={`${formatTimecode(cut, fps)} — برای رفتن به برش کلیک کنید`}
                  type="button"
                >
                  <span>{index + 1}</span>
                </button>
              ))}
              <div className="playhead" style={{ left: `${progressPercent}%` }}>
                <span />
              </div>
              <input
                aria-label="موقعیت پخش"
                disabled={!video}
                max={duration || 1}
                min="0"
                onChange={seekFromTimeline}
                step={1 / fps}
                type="range"
                value={currentTime}
              />
            </div>
          </div>
        </section>
      </main>

      {(notice || exportProgress) && (
        <div className="status-stack" aria-live="polite">
          {exportProgress && (
            <div className="export-status">
              <div>
                <strong>ساخت کلیپ {exportProgress.current.toLocaleString('fa-IR')} از {exportProgress.total.toLocaleString('fa-IR')}</strong>
                <span>{exportProgress.fileName || 'آماده‌سازی…'}</span>
              </div>
              <b>{exportProgress.percent.toLocaleString('fa-IR')}٪</b>
              <i><span style={{ width: `${exportProgress.percent}%` }} /></i>
            </div>
          )}
          {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}
        </div>
      )}
    </div>
  )
}

export default App
