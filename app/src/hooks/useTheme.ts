import { useCallback, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'creators-explorer-theme'

/** What 'system' currently resolves to. */
const prefersDark = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-color-scheme: dark)').matches

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // Private windows and blocked site data throw on access; the default is fine.
  }
  return 'system'
}

function apply(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && prefersDark())
  document.documentElement.classList.toggle('dark', dark)
  // Makes native controls (scrollbars, date pickers, form fields) match.
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

/**
 * Light / dark / follow-the-OS, remembered per browser.
 *
 * The class is also applied by an inline script in index.html before first paint,
 * so a dark-mode user never sees a white flash while React boots.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readStored)

  useEffect(() => {
    apply(theme)
    if (theme !== 'system') return
    // Follow the OS while it is set to 'system'.
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => apply('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Not being able to remember the choice is not worth failing over.
    }
  }, [])

  return { theme, setTheme }
}
