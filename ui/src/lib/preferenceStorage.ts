import { createJSONStorage } from 'zustand/middleware'

// Navigation and layout preferences have an in-memory copy in their stores. A full or
// unavailable localStorage must not interrupt startup or stop those controls from working.
export function createPreferenceStorage<T>() {
  return createJSONStorage<T>(() => ({
    getItem: (key) => {
      try {
        return localStorage.getItem(key)
      } catch {
        return null
      }
    },
    setItem: (key, value) => {
      try {
        localStorage.setItem(key, value)
      } catch {
        // The preference still applies for the current session.
      }
    },
    removeItem: (key) => {
      try {
        localStorage.removeItem(key)
      } catch {
        // Storage may be disabled or inaccessible.
      }
    },
  }))
}
