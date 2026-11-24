import { api } from './api'
import { createPollingResource } from './polling'

// Keep services independent of React and the Studio store so commands and panels share them.
export const promptStackResource = createPollingResource((signal) => api.promptStack(signal))
export const miningQueueResource = createPollingResource((signal) => api.miningQueue(signal))
