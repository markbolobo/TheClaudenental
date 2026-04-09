import { useState, useEffect, useRef } from 'react'
import { ALL_TIERS, TIER_META } from './BountySystem.jsx'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ACCEPT_MEDIA = '.jpg,.jpeg,.png,.webp,.gif,.mp4,.webm'
const ACCEPT_AUDIO = '.mp3,.ogg,.wav,.m4a'

function mediaCategory(filename) {
  if (!filename) return null
  const ext = filename.split('.').pop().toLowerCase()
  if (['jpg','jpeg','png','webp','gif'].includes(ext)) return 'image'
  if (['mp4','webm'].includes(ext))                   return 'video'
  if (['mp3','ogg','wav','m4a'].includes(ext))        return 'audio'
  return null
}

async function loadSettings() {
  try { return await fetch('/api/bounty/settings').then(r => r.json()) } catch { return {} }
}

async function saveSettings(s) {
  await fetch('/api/bounty/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  })
}

async function deleteAsset(tier, type) {
  await fetch(`/api/bounty/asset/${tier}/${type}`, { method: 'DELETE' })
}

// Check which assets exist by probing the asset endpoints
async function probeAssets(tier) {
  const check = async (type) => {
    const r = await fetch(`/api/bounty/asset/${tier}/${type}`, { method: 'GET' })
    if (!r.ok) return null
    const ct = r.headers.get('content-type') ?? ''
    return ct
  }
  const [mediaCt, audioCt] = await Promise.all([check('media'), check('audio')])
  return {
    hasMedia: !!mediaCt,
    mediaIsVideo: mediaCt?.startsWith('video'),
    hasAudio: !!audioCt,
  }
}

// ─── FileUploadZone ───────────────────────────────────────────────────────────

function FileUploadZone({ tier, assetType, accept, label, onUploaded, onDeleted, hasFile }) {
  const inputRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState(null)

  async function upload(file) {
    if (!file) return
    setUploading(true); setErr(null)
    try {
      const fd = new FormData()
      fd.append('tier', tier)
      fd.append('assetType', assetType)
      fd.append('file', file, file.name)
      const r = await fetch('/api/bounty/upload', { method: 'POST', body: fd })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? 'Upload failed')
      onUploaded(d)
    } catch (e) {
      setErr(e.message)
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete() {
    await deleteAsset(tier, assetType)
    onDeleted()
  }

  return (
    <div className="flex items-center gap-2">
      <input ref={inputRef} type="file" accept={accept} className="hidden"
        onChange={e => upload(e.target.files[0])} />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="px-2 py-1 text-[9px] uppercase tracking-wider border rounded-sm transition-colors disabled:opacity-40
          border-[var(--gold-border)] text-[var(--gold)] hover:bg-[var(--gold-dim)]">
        {uploading ? 'Uploading…' : hasFile ? '↺ Replace' : '↑ Upload'}
      </button>
      {hasFile && (
        <button onClick={handleDelete}
          className="px-2 py-1 text-[9px] uppercase tracking-wider border rounded-sm
            border-red-700/50 text-red-400 hover:bg-red-900/20">
          ✕ Clear
        </button>
      )}
      {hasFile && (
        <span className="text-[9px] text-[var(--text-muted)] truncate max-w-[110px]">
          ♪ {label}
        </span>
      )}
      {err && <span className="text-[9px] text-red-400">{err}</span>}
    </div>
  )
}

// ─── TierEditor ───────────────────────────────────────────────────────────────

function TierEditor({ tier, settings, onSave, onBack }) {
  const meta = TIER_META[tier]
  const cfg  = settings[tier] ?? {}

  const [mediaType,    setMediaType]    = useState(cfg.mediaType    ?? 'default')
  const [imageDuration,setImageDuration]= useState(cfg.imageDuration ?? 3)
  const [audioMode,    setAudioMode]    = useState(cfg.audioMode    ?? 'video')
  const [audioEnabled, setAudioEnabled] = useState(cfg.audioEnabled ?? false)
  const [assets, setAssets] = useState({ hasMedia: false, mediaIsVideo: false, hasAudio: false })
  const [probing, setProbing] = useState(true)
  const [previewKey, setPreviewKey] = useState(0)

  useEffect(() => {
    setProbing(true)
    probeAssets(tier).then(a => { setAssets(a); setProbing(false) })
  }, [tier])

  // Sync mediaType with actual file if not yet set
  useEffect(() => {
    if (probing) return
    if (cfg.mediaType === 'default' && assets.hasMedia)
      setMediaType(assets.mediaIsVideo ? 'video' : 'image')
  }, [probing])

  function commit(patch) {
    const next = { ...settings, [tier]: { mediaType, imageDuration, audioMode, audioEnabled, ...patch } }
    onSave(next)
  }

  function handleMediaUploaded(d) {
    const newType = d.category === 'video' ? 'video' : 'image'
    setMediaType(newType)
    setAssets(a => ({ ...a, hasMedia: true, mediaIsVideo: d.category === 'video' }))
    setPreviewKey(k => k + 1)
    commit({ mediaType: newType })
  }

  function handleMediaDeleted() {
    setMediaType('default')
    setAssets(a => ({ ...a, hasMedia: false, mediaIsVideo: false }))
    setPreviewKey(k => k + 1)
    commit({ mediaType: 'default' })
  }

  function handleAudioUploaded() {
    setAssets(a => ({ ...a, hasAudio: true }))
    commit({})
  }

  function handleAudioDeleted() {
    setAssets(a => ({ ...a, hasAudio: false }))
    commit({})
  }

  const isVideo  = mediaType === 'video'
  const isImage  = mediaType === 'image'
  const isDefault= mediaType === 'default'

  return (
    <div className="flex flex-col h-full">
      {/* Sub-header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] shrink-0">
        <button onClick={onBack}
          className="text-[var(--text-muted)] hover:text-[var(--text)] text-[10px] tracking-wide">
          ← Back
        </button>
        <span className="text-[10px] uppercase tracking-[0.2em]"
          style={{ color: meta.color }}>{meta.label}</span>
        <span className="text-[9px] text-[var(--text-muted)]">— {meta.desc}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">

        {/* ── MEDIA ──────────────────────────────────────────────────────── */}
        <section>
          <div className="text-[8px] text-[var(--text-muted)] uppercase tracking-[0.3em] mb-3 border-b border-[var(--border)] pb-1.5">
            Media
          </div>

          {/* Radio: default / image / video */}
          <div className="flex gap-4 mb-3">
            {[
              { value: 'default', label: 'Default' },
              { value: 'image',   label: 'Image / GIF' },
              { value: 'video',   label: 'Video' },
            ].map(opt => (
              <label key={opt.value} className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name={`mt-${tier}`}
                  checked={mediaType === opt.value}
                  onChange={() => { setMediaType(opt.value); commit({ mediaType: opt.value }) }}
                  className="accent-[var(--gold)]" />
                <span className="text-[10px] text-[var(--text)]">{opt.label}</span>
              </label>
            ))}
          </div>

          {/* Upload zone */}
          {!isDefault && (
            <FileUploadZone
              tier={tier} assetType="media"
              accept={ACCEPT_MEDIA}
              label={isVideo ? 'video file' : 'image / gif'}
              hasFile={assets.hasMedia}
              onUploaded={handleMediaUploaded}
              onDeleted={handleMediaDeleted}
            />
          )}

          {/* Preview */}
          {!isDefault && assets.hasMedia && (
            <div className="mt-3 relative rounded overflow-hidden border border-[var(--border)]"
              style={{ maxHeight: 140 }}>
              {isImage
                ? <img key={previewKey} src={`/api/bounty/asset/${tier}/media?t=${previewKey}`}
                    alt="" className="w-full object-contain max-h-[140px]" />
                : <video key={previewKey} src={`/api/bounty/asset/${tier}/media?t=${previewKey}`}
                    muted autoPlay loop className="w-full max-h-[140px] object-contain" />
              }
            </div>
          )}

          {/* Image duration */}
          {isImage && (
            <div className="mt-3 flex items-center gap-3">
              <span className="text-[9px] text-[var(--text-muted)] shrink-0">Duration</span>
              <input type="range" min={0.5} max={10} step={0.5}
                value={imageDuration}
                onChange={e => { const v = +e.target.value; setImageDuration(v); commit({ imageDuration: v }) }}
                className="flex-1 accent-[var(--gold)]" />
              <span className="text-[9px] tabular-nums text-[var(--gold)] shrink-0 w-8">{imageDuration}s</span>
            </div>
          )}

          {isDefault && (
            <p className="text-[9px] text-[var(--text-muted)] mt-1">
              Uses built-in John Wick text animation for this tier.
            </p>
          )}
        </section>

        {/* ── AUDIO ─────────────────────────────────────────────────────── */}
        <section>
          <div className="text-[8px] text-[var(--text-muted)] uppercase tracking-[0.3em] mb-3 border-b border-[var(--border)] pb-1.5">
            Audio
          </div>

          {isVideo ? (
            /* Video mode: choose original / custom */
            <div className="space-y-2">
              <div className="flex gap-4 mb-2">
                {[
                  { value: 'video',  label: 'Original audio' },
                  { value: 'custom', label: 'Custom audio file' },
                ].map(opt => (
                  <label key={opt.value} className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name={`am-${tier}`}
                      checked={audioMode === opt.value}
                      onChange={() => { setAudioMode(opt.value); commit({ audioMode: opt.value }) }}
                      className="accent-[var(--gold)]" />
                    <span className="text-[10px] text-[var(--text)]">{opt.label}</span>
                  </label>
                ))}
              </div>
              {audioMode === 'custom' && (
                <FileUploadZone
                  tier={tier} assetType="audio"
                  accept={ACCEPT_AUDIO} label="audio file"
                  hasFile={assets.hasAudio}
                  onUploaded={handleAudioUploaded}
                  onDeleted={handleAudioDeleted}
                />
              )}
            </div>
          ) : (
            /* Image / default mode: toggle + upload */
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <div
                  onClick={() => { const v = !audioEnabled; setAudioEnabled(v); commit({ audioEnabled: v }) }}
                  className={`w-8 h-4 rounded-full transition-colors cursor-pointer border ${
                    audioEnabled
                      ? 'bg-[var(--gold)] border-[var(--gold)]'
                      : 'bg-[var(--surface-2)] border-[var(--border-2)]'
                  }`}>
                  <div className={`w-3 h-3 rounded-full bg-white mt-0.5 transition-transform ${
                    audioEnabled ? 'translate-x-4' : 'translate-x-0.5'
                  }`} />
                </div>
                <span className="text-[10px] text-[var(--text)]">Play audio</span>
              </label>
              {audioEnabled && (
                <FileUploadZone
                  tier={tier} assetType="audio"
                  accept={ACCEPT_AUDIO} label="audio file"
                  hasFile={assets.hasAudio}
                  onUploaded={handleAudioUploaded}
                  onDeleted={handleAudioDeleted}
                />
              )}
              {audioEnabled && assets.hasAudio && (
                <audio key={previewKey} controls
                  src={`/api/bounty/asset/${tier}/audio?t=${previewKey}`}
                  className="w-full h-7 mt-1" />
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

// ─── TierCard ─────────────────────────────────────────────────────────────────

function TierCard({ tier, settings, hasMedia, hasAudio, onClick, onPreview }) {
  const meta = TIER_META[tier]
  const cfg  = settings[tier] ?? {}
  const typeLabel = cfg.mediaType === 'video' ? '▶' : cfg.mediaType === 'image' ? '◼' : '✦'

  return (
    <div className="flex flex-col gap-1 relative">
      <button onClick={onClick}
        className="flex flex-col gap-1.5 p-2.5 rounded border border-[var(--border)] hover:border-[var(--gold-border)]
          bg-[var(--surface-2)] hover:bg-[var(--surface)] transition-all text-left group"
        style={{ boxShadow: hasMedia || hasAudio ? `0 0 0 1px ${meta.color}22` : undefined }}>
        {/* Preview thumbnail or default glyph */}
        <div className="w-full h-10 rounded overflow-hidden flex items-center justify-center bg-[var(--bg)] relative">
          {hasMedia
            ? (cfg.mediaType === 'video'
                ? <video src={`/api/bounty/asset/${tier}/media`} muted loop
                    className="absolute inset-0 w-full h-full object-cover" />
                : <img src={`/api/bounty/asset/${tier}/media`} alt=""
                    className="absolute inset-0 w-full h-full object-cover" />
              )
            : <span className="text-lg" style={{ color: meta.color }}>{typeLabel}</span>
          }
        </div>
        <div className="text-[8px] font-semibold uppercase tracking-wider leading-none"
          style={{ color: meta.color }}>{meta.label}</div>
        <div className="text-[7px] text-[var(--text-muted)] leading-none truncate">{meta.desc}</div>
        <div className="flex gap-1 mt-0.5">
          {hasMedia && <span className="text-[6px] px-1 rounded bg-[var(--border)] text-[var(--text-muted)] uppercase">{cfg.mediaType}</span>}
          {hasAudio && <span className="text-[6px] px-1 rounded bg-[var(--border)] text-[var(--text-muted)] uppercase">♪</span>}
        </div>
      </button>
      {/* Preview button */}
      <button
        onClick={e => { e.stopPropagation(); onPreview?.(tier) }}
        title="預覽演出"
        className="w-full py-0.5 rounded border border-[var(--border)] hover:border-[var(--gold-border)]
          text-[7px] uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--gold)]
          bg-[var(--surface-2)] hover:bg-[var(--surface)] transition-colors"
      >▶ 預覽</button>
    </div>
  )
}

// ─── BountySettings Modal ─────────────────────────────────────────────────────

export default function BountySettings({ onClose, onPreview }) {
  const [settings, setSettings]   = useState({})
  const [assetMap, setAssetMap]   = useState({}) // { [tier]: { hasMedia, mediaIsVideo, hasAudio } }
  const [editTier, setEditTier]   = useState(null)
  const [loading,  setLoading]    = useState(true)

  useEffect(() => {
    Promise.all([
      loadSettings(),
      Promise.all(ALL_TIERS.map(t => probeAssets(t).then(a => [t, a]))),
    ]).then(([s, pairs]) => {
      setSettings(s)
      setAssetMap(Object.fromEntries(pairs))
      setLoading(false)
    })
  }, [])

  async function handleSave(next) {
    setSettings(next)
    await saveSettings(next)
  }

  if (loading) return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.88)' }}>
      <span className="text-[var(--gold)] text-[10px] tracking-widest animate-pulse">Loading…</span>
    </div>
  )

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.88)' }} onClick={onClose}>
      <div className="relative w-full max-w-lg mx-3 bg-[var(--surface)] border border-[var(--gold-border)] rounded-sm
        shadow-[0_0_80px_rgba(201,162,39,0.1)] flex flex-col overflow-hidden"
        style={{ height: '88vh', maxHeight: 680 }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="px-5 py-3 border-b border-[var(--gold-border)]/40 shrink-0 flex items-center gap-3">
          {editTier
            ? null
            : <>
                <div>
                  <div className="text-[7px] text-[var(--gold)]/50 tracking-[0.3em] uppercase">The Continental</div>
                  <div className="text-[11px] text-[var(--gold)] tracking-[0.15em] uppercase font-semibold">Bounty Announcement Settings</div>
                </div>
                <div className="flex-1" />
                <button onClick={onClose}
                  className="text-[var(--text-muted)] hover:text-[var(--text)] text-sm">✕</button>
              </>
          }
          {editTier && (
            <button onClick={onClose}
              className="absolute top-3 right-3 text-[var(--text-muted)] hover:text-[var(--text)] text-sm">✕</button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden min-h-0">
          {!editTier ? (
            /* Tier grid */
            <div className="h-full overflow-y-auto px-4 py-4">
              {[
                { group: 'Light', tiers: ['L1','L2','L3','L4'] },
                { group: 'Heavy', tiers: ['H1','H2','H3','H4'] },
                { group: 'Special Milestones', tiers: ['S1','S2','S3','S4'] },
                { group: 'Settlement', tiers: ['C'] },
              ].map(({ group, tiers }) => (
                <div key={group} className="mb-5">
                  <div className="text-[7px] text-[var(--text-muted)] uppercase tracking-[0.3em] mb-2 border-b border-[var(--border)] pb-1">
                    {group}
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {tiers.map(t => (
                      <TierCard key={t} tier={t} settings={settings}
                        hasMedia={assetMap[t]?.hasMedia ?? false}
                        hasAudio={assetMap[t]?.hasAudio ?? false}
                        onClick={() => setEditTier(t)}
                        onPreview={onPreview} />
                    ))}
                  </div>
                </div>
              ))}
              <p className="text-[8px] text-[var(--text-muted)] text-center mt-2 pb-2">
                Click a tier to customise its media, duration, and audio.
              </p>
            </div>
          ) : (
            /* Tier editor */
            <TierEditor
              tier={editTier}
              settings={settings}
              onSave={handleSave}
              onBack={() => setEditTier(null)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
