import { useState } from 'react'
import { api } from '../lib/api'
import type { Settings } from '../lib/types'
import { Field, Section } from './common'

export function WebSettingsPanel({ web, onChange, onSave }: { web: Settings['web']; onChange: (web: Settings['web']) => void; onSave: () => Promise<void> }) {
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState('')
  const [failed, setFailed] = useState(false)
  const check = async () => {
    setChecking(true); setStatus('Checking the saved connection…'); setFailed(false)
    try {
      await onSave()
      const result = await api.web.check()
      setStatus(result.route === 'tor' ? `Tor exit verified by Tor Project. Exit IP: ${result.ip}` : `Direct research connection. Public IP: ${result.ip}. Citation links open in Google Chrome.`)
    } catch (error) { setStatus((error as Error).message); setFailed(true) }
    finally { setChecking(false) }
  }
  return <Section title="Web access & Tor Browser" description="Search and read public web pages in Chat and Code. Enable Web in the composer; this turns mining off for that conversation. On macOS and Linux, the managed browser can read JavaScript pages and click controls with your approval.">
    <Field label="Model's Web connection">
      <select className="input mt-1" value={web.mode} onChange={(e) => { onChange({ ...web, mode: e.target.value as Settings['web']['mode'] }); setStatus('') }}>
        <option value="off">Off</option><option value="tor">Tor — proxy connection and DNS, no direct fallback</option><option value="direct">Direct — research uses your normal internet connection</option>
      </select>
    </Field>
    <Field label="Tor SOCKS listener" hint="Tor Browser: 127.0.0.1:9150. Standalone Tor: 127.0.0.1:9050. Only loopback IPs are accepted.">
      <input className="input mt-1 mono" value={web.tor_proxy} onChange={(e) => onChange({ ...web, tor_proxy: e.target.value })} />
    </Field>
    <Field label="Tor Browser application / launcher path" hint="Leave blank to detect the installation. On macOS select Tor Browser.app; on Windows Browser/firefox.exe; on Linux Browser/start-tor-browser.">
      <input className="input mt-1" placeholder="Auto-detect Tor Browser" value={web.tor_browser_path ?? ''} onChange={(e) => onChange({ ...web, tor_browser_path: e.target.value || null })} />
    </Field>
    <p className="text-xs text-ink-500">For Tor mode, connect Tor Browser or start standalone Tor. The managed Chromium window uses the selected route and a separate temporary profile. Tor mode routes its page requests and DNS through Tor, while using Chromium’s browser fingerprint. Enter credentials and submit forms yourself in that window. Text research uses the selected connection without opening browser tabs. Citation links open in Google Chrome in Direct mode and Tor Browser in other modes.</p>
    <button type="button" className="btn" disabled={checking || web.mode === 'off'} onClick={() => void check()}>{checking ? 'Checking…' : 'Save & test connection'}</button>
    {status && <p role="status" className={`text-xs ${failed ? 'text-red-600' : 'text-ink-600 dark:text-ink-300'}`}>{status}</p>}
  </Section>
}
