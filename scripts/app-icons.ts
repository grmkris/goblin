/**
 * `bun run icons`: the app's icons, drawn from the original shared goblin mark so the sizes never drift apart.
 * Writes committed files to apps/web/public: the 180px Home Screen icon iOS uses, the manifest's 192/512/1024 icons and
 * a maskable one for Android (the mark inside its safe zone), all on the page's opaque background, which iOS needs
 * (it composites transparency on black), an SVG favicon that follows the light or dark scheme, the startup image
 * for every iPhone and iPad screen a Home Screen app opens on (apps/web/src/lib/startup-images.ts), and the landing's
 * 1200x630 link preview (`og.png`): the mark and the headline on the moss field beside the hero's night etching, set in
 * Geist by a local Chromium.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import sharp from 'sharp'
import { GOBLIN_PATHS } from '../packages/ui/src/brand.ts'
import { startupImages } from '../apps/web/src/lib/startup-images.ts'

const OUT = resolve(import.meta.dirname, '../apps/web/public')
/** The light theme's --background and --foreground, and the dark --foreground (packages/ui/src/styles.css). */
const PAPER = '#fafaf9'
const INK = '#0d1014'
const INK_DARK = '#ecebe8'
const STROKE = 'fill="none" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"'
const paths = GOBLIN_PATHS.map((d) => `<path d="${d}"/>`).join('')

/** The mark centred on an opaque square, `scale` of its side. */
function square(size: number, scale: number): string {
  const glyph = size * scale
  const offset = (size - glyph) / 2
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" fill="${PAPER}"/>`,
    `<g transform="translate(${offset} ${offset}) scale(${glyph / 24})" stroke="${INK}" ${STROKE}>${paths}</g>`,
    '</svg>',
  ].join('')
}

/**
 * A startup image: the page's background, which the first paint keeps, with the mark small at its centre, clear of the
 * status bar, the notch and the home indicator on every screen.
 */
function splash(width: number, height: number): string {
  const glyph = Math.round(Math.min(width, height) * 0.16)
  const [x, y] = [(width - glyph) / 2, (height - glyph) / 2]
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${PAPER}"/>`,
    `<g transform="translate(${x} ${y}) scale(${glyph / 24})" stroke="${INK}" ${STROKE}>${paths}</g>`,
    '</svg>',
  ].join('')
}

const FAVICON = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${STROKE}>`,
  `<style>g{stroke:${INK}}@media (prefers-color-scheme:dark){g{stroke:${INK_DARK}}}</style>`,
  `<g>${paths}</g></svg>`,
].join('')

const PNGS: readonly (readonly [string, number, number])[] = [
  ['apple-touch-icon.png', 180, 0.6],
  ['icon-192.png', 192, 0.6],
  ['icon-512.png', 512, 0.6],
  ['icon-1024.png', 1024, 0.6],
  // Android crops a maskable icon to a circle 80% wide: the mark stays well inside it.
  ['icon-maskable-512.png', 512, 0.46],
]

mkdirSync(OUT, { recursive: true })
for (const [name, size, scale] of PNGS) {
  await sharp(Buffer.from(square(size, scale)))
    .png({ compressionLevel: 9 })
    .toFile(resolve(OUT, name))
  console.log(`${name} ${size}x${size}`)
}
writeFileSync(resolve(OUT, 'favicon.svg'), `${FAVICON}\n`)
console.log('favicon.svg')
mkdirSync(resolve(OUT, 'splash'), { recursive: true })
for (const image of startupImages()) {
  const { width, height } = image.pixels
  await sharp(Buffer.from(splash(width, height)))
    .png({ compressionLevel: 9, palette: true })
    .toFile(resolve(OUT, image.file))
}
console.log(`splash/ ${startupImages().length} startup images`)

/** The shell's moss tokens (packages/ui/src/styles.css), as the landing's hero shows them in light. */
const MOSS = { field: '#233e27', ink: '#f4f4ea', muted: '#bfc8b3', tile: '#e4edc8', tileInk: '#112e16' }
const GEIST = readFileSync(
  resolve(
    import.meta.dirname,
    '../packages/ui/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2',
  ),
).toString('base64')
/**
 * The hero's night etching (landing.css): lichen lines on the field, covering it from the bottom left, with the
 * lantern's warm light where the drawing has it (`--presence-warm` in light).
 */
const NIGHT = readFileSync(
  resolve(import.meta.dirname, '../apps/web/src/assets/landing/etching-night-1400.jpg'),
).toString('base64')
const SCENE = { ratio: 2000 / 1129, glowX: 0.4007, glowY: 0.612, glowSize: 0.15 }
const sceneHeight = 1200 / SCENE.ratio
/** How far the scene sinks below the image's foot, so its hills and cottage sit under the words. */
const sink = 48
const OG = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Geist;src:url(data:font/woff2;base64,${GEIST}) format('woff2');font-weight:100 900}
*{margin:0;box-sizing:border-box}
html,body{width:1200px;height:630px;overflow:hidden;background:${MOSS.field};color:${MOSS.ink};font-family:Geist;-webkit-font-smoothing:antialiased}
.scene{position:absolute;left:0;bottom:-${sink}px;width:1200px;height:${sceneHeight}px;background:rgb(228 237 200 / 0.42);mask:url(data:image/jpeg;base64,${NIGHT}) luminance 0 0/100% 100% no-repeat}
.glow{position:absolute;left:${1200 * SCENE.glowX}px;top:${630 + sink - sceneHeight + sceneHeight * SCENE.glowY}px;width:${1200 * SCENE.glowSize}px;height:${1200 * SCENE.glowSize}px;translate:-50% -50%;border-radius:50%;background:radial-gradient(closest-side,oklch(0.8 0.14 70 / 0.46),oklch(0.8 0.14 70 / 0.14) 42%,transparent);mix-blend-mode:screen}
main{position:relative;display:flex;flex-direction:column;height:100%;margin-left:590px;padding:64px 56px 0 0}
.brand{display:flex;align-items:center;gap:16px;margin-bottom:64px;font-size:36px;font-weight:640;letter-spacing:-0.015em}
.tile{display:grid;place-items:center;width:56px;height:56px;border-radius:16px;background:${MOSS.tile};color:${MOSS.tileInk}}
h1{font-size:66px;font-weight:680;line-height:0.98;letter-spacing:-0.04em}
p{margin-top:26px;color:${MOSS.muted};font-size:26px;line-height:1.4}
</style></head><body><div class="scene"></div><div class="glow"></div><main>
<div class="brand"><span class="tile"><svg width="34" height="34" viewBox="0 0 24 24" stroke="currentColor" ${STROKE}>${paths}</svg></span>goblin</div>
<h1>Your own goblin,<br>always on.</h1>
<p>A personal agent that keeps working while you're away, and asks before it spends.</p>
</main></body></html>`

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } })
  await page.setContent(OG)
  // Wait for Geist to load before the screenshot (a string: scripts are not typed with the DOM).
  await page.evaluate('document.fonts.ready.then(() => true)')
  await sharp(await page.screenshot({ type: 'png' }))
    .png({ compressionLevel: 9, palette: true })
    .toFile(resolve(OUT, 'og.png'))
  console.log('og.png 1200x630')
} finally {
  await browser.close()
}
