// Diagrams for an app's view (`diagrams.js`): the kit's Diagram (Pele, every kind in the one frame bundle), on core's React.
import { Diagram } from '@goblin/kit/diagram'
import { provide } from './modules.ts'

provide({ '@goblin/kit/diagram': { Diagram } })
