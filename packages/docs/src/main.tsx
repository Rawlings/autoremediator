import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'

function getBasename() {
  const base = import.meta.env.BASE_URL
  if (!base || base === '/') {
    return '/'
  }
  return base.endsWith('/') ? base.slice(0, -1) : base
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={getBasename()}>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
