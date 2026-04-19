import { render } from 'preact'
import { App } from './app.js'

const host = document.getElementById('app')
if (host) render(<App />, host)
