import { createRoot } from 'react-dom/client'
import { App } from './app.tsx'
import './styles.css'

const element = document.getElementById('root')
if (element === null) throw new Error('The playground root is missing.')
createRoot(element).render(<App />)
