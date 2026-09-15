import { DataWindow } from './components/DataWindow'
import { PlotMeasurementWindow } from './components/PlotMeasurementWindow'
import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { GlobalTooltip } from './components/GlobalTooltip'

const dataWindowId = new URLSearchParams(window.location.search).get('dataWindow')
const plotMeasurement = new URLSearchParams(window.location.search).has('plotMeasurement')
if (plotMeasurement) document.body.classList.add('plot-measurement-body')
if (dataWindowId) document.body.classList.add('data-window-body')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {plotMeasurement ? (
      <PlotMeasurementWindow />
    ) : dataWindowId ? (
      <DataWindow id={dataWindowId} />
    ) : (
      <App />
    )}
    <GlobalTooltip />
  </StrictMode>
)
