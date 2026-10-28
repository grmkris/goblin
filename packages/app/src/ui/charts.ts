// Charts for an app's view (`charts.js`): the kit's Chart, drawn by Pele (ADR 0130), on core's React.
import { Chart } from '@goblin/kit/chart'
import { provide } from './modules.ts'

provide({ '@goblin/kit/chart': { Chart } })
