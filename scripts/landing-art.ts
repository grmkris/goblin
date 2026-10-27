/**
 * `bun scripts/landing-art.ts <drawing> <out.jpg> [--ink white|black] [--width <px>] [--crop <l,t,w,h>] [--trim]`:
 * one of the landing's drawings as an etching. The drawings are engravings made as pure ink on a plain ground (white
 * lines on black for the moss fields, black lines on white for the chapters). What is kept is only how much ink each
 * pixel holds, as a grey image where white is full ink and black none, which the page uses as a luminance
 * `mask-image` (landing.css) and colours with a theme token, so one file draws lichen on moss in light and dark alike.
 * The sources stay outside the repository; the etchings are committed under apps/web/src/assets/landing/.
 */
import { parseArgs } from 'node:util'
import sharp from 'sharp'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ink: { type: 'string', default: 'white' },
    width: { type: 'string', default: '2000' },
    crop: { type: 'string' },
    trim: { type: 'boolean', default: false },
  },
})
const [input, output] = positionals
if (input === undefined || output === undefined || (values.ink !== 'white' && values.ink !== 'black'))
  throw new Error(
    'usage: bun scripts/landing-art.ts <drawing> <out.jpg> [--ink white|black] [--width px] [--crop l,t,w,h] [--trim]',
  )

/** The ground and full ink, in grey levels: paper noise under `GROUND` drops out, and lines over `FULL` are solid. */
const GROUND = 28
const FULL = 228

const ground = values.ink === 'white' ? '#000' : '#fff'
let image = sharp(input).flatten({ background: ground })
if (values.crop !== undefined) {
  const [left = 0, top = 0, width = 0, height = 0] = values.crop.split(',').map(Number)
  image = image.extract({ left, top, width, height })
}
// A vignette keeps only its drawing and a little paper around it, so its box is the drawing's own.
if (values.trim)
  image = sharp(await image.trim({ background: ground, threshold: 48 }).toBuffer()).extend({
    top: 16,
    bottom: 16,
    left: 16,
    right: 16,
    background: ground,
  })
if (values.ink === 'black') image = image.negate({ alpha: false })
await image
  .resize({ width: Number(values.width), withoutEnlargement: true })
  .greyscale()
  .linear(255 / (FULL - GROUND), (-255 * GROUND) / (FULL - GROUND))
  .jpeg({ quality: 55, mozjpeg: true })
  .toFile(output)
