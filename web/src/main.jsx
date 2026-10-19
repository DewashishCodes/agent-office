import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

createRoot(document.getElementById('root')).render(<App />)

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
