import type { IdeApi } from '../shared/types'

declare global {
  interface Window {
    api: IdeApi
  }
}

export {}
