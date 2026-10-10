export {}

declare global {
  interface VideoSelection {
    name: string
    url: string
    fps?: number | null
  }

  interface ExportRequest {
    cutTimes: number[]
    duration: number
    fps: number
    /** Start times of the clips that also get a reversed copy (`…_part_01_reverse.mp4`). */
    reverseStarts?: number[]
  }

  interface ExportProgress {
    current: number
    total: number
    percent: number
    fileName: string
  }

  interface ExportResult {
    canceled: boolean
    count: number
    reversedCount?: number
    directory?: string
  }

  interface Window {
    videoEditor?: {
      selectVideo: () => Promise<VideoSelection | null>
      exportSegments: (request: ExportRequest) => Promise<ExportResult>
      onExportProgress: (callback: (progress: ExportProgress) => void) => () => void
    }
  }
}