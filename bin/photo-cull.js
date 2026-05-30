#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DEFAULT_OUT = 'reports'
const DEFAULT_LIMIT = 24
const MAX_LIMIT = 80
const CONFIDENCE_DELETE_THRESHOLD = 0.8

const ACTIONS = new Set(['keep', 'review', 'archive_candidate', 'duplicate_candidate'])
const LEVELS = new Set(['conservative', 'medium', 'aggressive'])

function usage() {
  console.log(`local-ai-photo-culler

Usage:
  photo-cull auth
  photo-cull scan [--limit 24] [--model llava:latest] [--level conservative|medium|aggressive]
                  [--screenshots-only] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                  [--out reports] [--ollama http://127.0.0.1:11434]
  photo-cull delete --manifest reports/run-.../manifest.json [--ids-file selected-delete-ids.txt]

The scan command only stages candidates. Delete moves selected Apple Photos assets
to Recently Deleted, where macOS keeps them recoverable for about 30 days.`)
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      args.help = true
      continue
    }
    if (!arg.startsWith('--')) {
      args._.push(arg)
      continue
    }
    const key = arg.slice(2)
    if (['screenshots-only', 'dry-run', 'yes'].includes(key)) {
      args[key] = true
      continue
    }
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`)
    args[key] = value
    i += 1
  }
  return args
}

function helperPath() {
  return path.join(ROOT, 'native', 'photokit-helper', 'photokit-helper')
}

function execFile(file, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Timed out after ${timeoutMs}ms: ${file} ${args.join(' ')}`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const parsed = safeJson(stdout)
      if (code === 0) resolve(parsed)
      else {
        const message = parsed?.error || stderr.trim() || stdout.trim() || `exit ${code}`
        const error = new Error(message)
        error.json = parsed
        reject(error)
      }
    })
  })
}

function safeJson(text) {
  try {
    return JSON.parse(String(text || '').trim())
  } catch {
    return null
  }
}

async function ensureHelper() {
  try {
    await fs.access(helperPath())
  } catch {
    throw new Error('PhotoKit helper is missing. Run: npm run build:helper')
  }
}

async function runHelper(args, timeoutMs) {
  await ensureHelper()
  return execFile(helperPath(), args, timeoutMs)
}

function clampLimit(raw) {
  const value = Number(raw ?? DEFAULT_LIMIT)
  if (!Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.round(value)))
}

function getModel(args) {
  return args.model || process.env.PHOTO_CULL_MODEL || process.env.OLLAMA_MODEL || 'llava:latest'
}

function getOllamaBase(args) {
  return (args.ollama || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '')
}

async function assertOllama(baseUrl) {
  const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`Ollama is not reachable: HTTP ${response.status}`)
}

function dateArgs(args) {
  const out = []
  if (args.from) out.push('--after', `${args.from}T00:00:00Z`)
  if (args.to) out.push('--before', `${args.to}T23:59:59Z`)
  return out
}

async function analyzePhoto({ baseUrl, model, imagePath }) {
  const imageBase64 = await fs.readFile(imagePath, 'base64')
  const prompt = `You are helping cull an Apple Photos library. The goal is to find photos that are obviously low-value and safe to send to human review for deletion.

Privacy rules:
- Only describe visible content.
- Do not identify people by name.
- Do not infer sensitive identity, relationships, health, religion, politics, or private attributes.

Low-quality flags:
- blurry: subject is clearly out of focus, motion smeared, or unreadable.
- too_dark: nearly black or severely underexposed.
- screenshot: phone/computer screenshot.
- document: receipt, invoice, form, pure text document, or document screenshot.
- duplicate_candidate: obviously the same scene as a burst/near-duplicate.

Screenshots:
- keep: receipts, order confirmations, payment proof, tickets, QR/barcodes, maps/routes, important instructions, or content clearly saved for reference.
- archive_candidate: memes, random app/web/social screenshots, temporary info, expired content, or no clear save value.
- If unsure, choose keep or review.

Keep clear people, travel, food, events, pets, scenery, meaningful objects, and normal life photos unless they are truly unusable.

Return strict JSON:
{
  "caption": "one sentence",
  "album_suggestions": ["short label"],
  "quality_flags": ["blurry|too_dark|screenshot|document|duplicate_candidate"],
  "cleanup_action": "keep|review|archive_candidate|duplicate_candidate",
  "confidence": 0.0,
  "reason": "one sentence"
}`

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: 'json',
      options: {
        temperature: 0.1,
        num_ctx: 4096,
        num_predict: 700
      },
      messages: [
        {
          role: 'system',
          content: 'You are a local privacy-preserving photo culling assistant. Return JSON only.'
        },
        { role: 'user', content: prompt, images: [imageBase64] }
      ]
    }),
    signal: AbortSignal.timeout(300000)
  })
  if (!response.ok) throw new Error(`Ollama chat failed: HTTP ${response.status}`)
  const data = await response.json()
  const raw = data?.message?.content || '{}'
  const parsed = safeJson(raw) || {}
  return normalizeAnalysis(parsed)
}

function normalizeAnalysis(parsed) {
  const flags = Array.isArray(parsed.quality_flags)
    ? parsed.quality_flags.map(String).filter(Boolean)
    : []
  const albums = Array.isArray(parsed.album_suggestions)
    ? parsed.album_suggestions.map(String).filter(Boolean).slice(0, 4)
    : []
  const action = ACTIONS.has(parsed.cleanup_action) ? parsed.cleanup_action : 'review'
  const confidence = Number(parsed.confidence)
  return {
    caption: typeof parsed.caption === 'string' && parsed.caption.trim()
      ? parsed.caption.trim()
      : 'No stable caption returned by the local model.',
    albumSuggestions: albums.length ? albums : ['Needs review'],
    qualityFlags: flags,
    cleanupAction: action,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    reason: typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : 'Needs human review.'
  }
}

function isDeleteCandidate(item, isDuplicate, level) {
  if (item.isFavorite) return [false, 'favorite protected']
  if (isDuplicate) return [true, 'exact exported-image duplicate; one copy kept']
  const flags = item.qualityFlags.join(' ').toLowerCase()
  const blurry = /blurry|blur|模糊|糊/.test(flags)
  const dark = /too_dark|dark|underexposed|过暗|欠曝/.test(flags)
  if ((blurry || dark) && item.confidence >= CONFIDENCE_DELETE_THRESHOLD) {
    return [true, `high-confidence ${blurry ? 'blurry' : 'too-dark'} photo (${Math.round(item.confidence * 100)}%)`]
  }
  if (level !== 'conservative' && item.isScreenshot) {
    const modelJunk = item.cleanupAction === 'archive_candidate' || item.cleanupAction === 'duplicate_candidate'
    if (modelJunk || (level === 'aggressive' && item.cleanupAction !== 'keep')) {
      return [true, 'screenshot with no clear save value']
    }
  }
  if (level === 'aggressive' && item.cleanupAction !== 'keep') {
    return [true, `aggressive mode: ${item.cleanupAction}`]
  }
  return [false, 'not staged']
}

async function sha256(filePath) {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
}

function findDuplicates(entries) {
  const seen = new Map()
  const duplicates = new Set()
  for (const entry of entries) {
    if (!entry.hash || entry.item.isFavorite || entry.item.error) continue
    if (seen.has(entry.hash)) duplicates.add(entry.item.id)
    else seen.set(entry.hash, entry.item.id)
  }
  return duplicates
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

async function writeReviewHtml(runDir, manifest) {
  const rows = manifest.items.map((item) => {
    const thumb = path.relative(runDir, item.thumbnailPath).split(path.sep).join('/')
    const checked = item.deleteCandidate ? 'checked' : ''
    const danger = item.deleteCandidate ? ' candidate' : ''
    return `<article class="photo${danger}">
  <label class="check"><input type="checkbox" ${checked} value="${escapeHtml(item.localIdentifier)}"> stage</label>
  <img src="${escapeHtml(thumb)}" alt="">
  <div class="meta">
    <strong>${escapeHtml(item.fileName || item.id)}</strong>
    <span>${escapeHtml(item.caption)}</span>
    <small>${escapeHtml(item.deleteReason || item.reason)}</small>
    <code>${escapeHtml(item.cleanupAction)} · ${Math.round(item.confidence * 100)}%</code>
  </div>
</article>`
  }).join('\n')
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Local AI Photo Culler Review</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:0;background:#f6f7f9;color:#16181d}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #dfe3ea;padding:16px 20px;z-index:2}
h1{font-size:20px;margin:0 0 6px}p{margin:4px 0;color:#59606c}.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
button{border:1px solid #ccd2dc;background:#fff;border-radius:8px;padding:8px 10px;cursor:pointer}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;padding:18px}
.photo{background:#fff;border:1px solid #dfe3ea;border-radius:10px;overflow:hidden}.photo.candidate{border-color:#e59a9a}
.check{display:flex;gap:7px;align-items:center;padding:10px;font-size:13px}.photo img{width:100%;aspect-ratio:4/3;object-fit:contain;background:#eceff4}
.meta{padding:11px 12px 14px;display:flex;flex-direction:column;gap:6px}.meta span{font-size:13px;line-height:1.4}.meta small{color:#b42318}.meta code{font-size:11px;color:#59606c}
textarea{width:min(900px,calc(100vw - 40px));height:120px;margin-top:10px}
</style>
<header>
  <h1>Local AI Photo Culler Review</h1>
  <p>${manifest.summary.deleteCandidateCount} staged out of ${manifest.summary.scannedCount} scanned. Review carefully, then copy selected IDs.</p>
  <p>Delete command: <code>photo-cull delete --manifest ${escapeHtml(path.basename(manifest.manifestPath))} --ids-file selected-delete-ids.txt</code></p>
  <div class="bar">
    <button onclick="setAll(true)">Select all</button>
    <button onclick="setAll(false)">Select none</button>
    <button onclick="copyIds()">Copy selected IDs</button>
    <button onclick="downloadIds()">Download selected-delete-ids.txt</button>
  </div>
  <textarea id="ids" placeholder="Selected IDs will appear here"></textarea>
</header>
<main>${rows}</main>
<script>
function boxes(){return [...document.querySelectorAll('input[type=checkbox]')]}
function selected(){return boxes().filter(b=>b.checked).map(b=>b.value).join('\\n')}
function refresh(){document.querySelector('#ids').value=selected()}
function setAll(v){boxes().forEach(b=>b.checked=v);refresh()}
async function copyIds(){refresh(); await navigator.clipboard.writeText(document.querySelector('#ids').value)}
function downloadIds(){refresh(); const blob=new Blob([document.querySelector('#ids').value+'\\n'],{type:'text/plain'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='selected-delete-ids.txt'; a.click()}
boxes().forEach(b=>b.addEventListener('change',refresh)); refresh()
</script>`
  const target = path.join(runDir, 'review.html')
  await fs.writeFile(target, html)
  return target
}

async function scan(args) {
  if (args.help) {
    usage()
    return
  }
  await ensureHelper()
  const baseUrl = getOllamaBase(args)
  const model = getModel(args)
  const level = LEVELS.has(args.level) ? args.level : 'conservative'
  const limit = clampLimit(args.limit)
  await assertOllama(baseUrl)

  const runDir = path.resolve(process.cwd(), args.out || DEFAULT_OUT, `run-${new Date().toISOString().replaceAll(':', '-')}`)
  const thumbDir = path.join(runDir, 'thumbs')
  await fs.mkdir(thumbDir, { recursive: true })

  const listArgs = ['list', '--limit', String(limit), '--order', 'asc', ...dateArgs(args)]
  if (args['screenshots-only']) listArgs.push('--screenshots-only')
  const candidates = await runHelper(listArgs, 30000)
  if (!Array.isArray(candidates)) throw new Error('PhotoKit helper returned an invalid list response.')

  const entries = []
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const id = createHash('sha1').update(candidate.localIdentifier).digest('hex').slice(0, 16)
    const thumbnailPath = path.join(thumbDir, `${String(index + 1).padStart(3, '0')}-${id}.jpg`)
    process.stdout.write(`[${index + 1}/${candidates.length}] ${candidate.originalFilename || candidate.fileName || id} ... `)
    try {
      await runHelper(['export', '--id', candidate.localIdentifier, '--out', thumbnailPath, '--max', '1024'], 30000)
      const analysis = candidate.isFavorite
        ? {
            caption: 'Favorite photo; skipped model analysis.',
            albumSuggestions: ['Favorite'],
            qualityFlags: [],
            cleanupAction: 'keep',
            confidence: 1,
            reason: 'Favorites are always protected.'
          }
        : await analyzePhoto({ baseUrl, model, imagePath: thumbnailPath })
      const item = {
        id,
        localIdentifier: candidate.localIdentifier,
        fileName: candidate.fileName || candidate.originalFilename || '',
        createdAt: candidate.creationDate || '',
        modifiedAt: candidate.modificationDate || candidate.creationDate || '',
        sizeBytes: Number(candidate.sizeBytes || 0),
        isFavorite: Boolean(candidate.isFavorite),
        isScreenshot: Boolean(candidate.isScreenshot),
        thumbnailPath,
        ...analysis,
        deleteCandidate: false,
        deleteReason: ''
      }
      entries.push({ item, hash: await sha256(thumbnailPath) })
      process.stdout.write(`${analysis.cleanupAction}\n`)
    } catch (error) {
      entries.push({
        item: {
          id,
          localIdentifier: candidate.localIdentifier,
          fileName: candidate.fileName || candidate.originalFilename || '',
          createdAt: candidate.creationDate || '',
          modifiedAt: candidate.modificationDate || candidate.creationDate || '',
          sizeBytes: Number(candidate.sizeBytes || 0),
          isFavorite: Boolean(candidate.isFavorite),
          isScreenshot: Boolean(candidate.isScreenshot),
          thumbnailPath,
          caption: 'Analysis failed.',
          albumSuggestions: ['Needs review'],
          qualityFlags: [],
          cleanupAction: 'review',
          confidence: 0,
          reason: error instanceof Error ? error.message : String(error),
          error: error instanceof Error ? error.message : String(error),
          deleteCandidate: false,
          deleteReason: ''
        },
        hash: null
      })
      process.stdout.write(`failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  const duplicates = findDuplicates(entries)
  for (const entry of entries) {
    const [candidate, reason] = isDeleteCandidate(entry.item, duplicates.has(entry.item.id), level)
    entry.item.deleteCandidate = candidate
    entry.item.deleteReason = candidate ? reason : ''
  }

  const items = entries.map((entry) => entry.item)
  const manifest = {
    tool: 'local-ai-photo-culler',
    createdAt: new Date().toISOString(),
    model,
    ollamaBaseUrl: baseUrl,
    level,
    runDir,
    manifestPath: path.join(runDir, 'manifest.json'),
    summary: {
      scannedCount: items.length,
      deleteCandidateCount: items.filter((item) => item.deleteCandidate).length,
      favoriteProtectedCount: items.filter((item) => item.isFavorite).length,
      screenshotCount: items.filter((item) => item.isScreenshot).length
    },
    items
  }
  await fs.writeFile(manifest.manifestPath, JSON.stringify(manifest, null, 2))
  const reviewPath = await writeReviewHtml(runDir, manifest)
  console.log(`\nScan complete.`)
  console.log(`Manifest: ${manifest.manifestPath}`)
  console.log(`Review:   ${reviewPath}`)
}

async function auth(args = {}) {
  if (args.help) {
    usage()
    return
  }
  await ensureHelper()
  const status = await runHelper(['request-auth'], 120000)
  console.log(JSON.stringify(status, null, 2))
}

async function deletePhotos(args) {
  if (args.help) {
    usage()
    return
  }
  if (!args.manifest) throw new Error('Missing --manifest')
  const manifestPath = path.resolve(args.manifest)
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  let ids = []
  if (args['ids-file']) {
    ids = (await fs.readFile(path.resolve(args['ids-file']), 'utf8'))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } else {
    ids = manifest.items
      .filter((item) => item.deleteCandidate)
      .map((item) => item.localIdentifier)
  }
  if (!ids.length) throw new Error('No IDs selected for deletion.')
  if (!args.yes) {
    console.log(`Refusing to delete without --yes. ${ids.length} IDs are selected.`)
    console.log('Review your IDs, then rerun with --yes. macOS Photos will show another confirmation.')
    return
  }
  const result = await runHelper(['delete', '--ids', ids.join(',')], 600000)
  console.log(JSON.stringify(result, null, 2))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  if (!command || command === 'help' || command === '--help') {
    usage()
    return
  }
  if (command === 'auth') return auth(args)
  if (command === 'scan') return scan(args)
  if (command === 'delete') return deletePhotos(args)
  throw new Error(`Unknown command: ${command}`)
}

main().catch((error) => {
  console.error(`Error: ${error.message}`)
  process.exit(1)
})
