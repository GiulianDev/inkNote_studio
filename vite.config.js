import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { singleFileOffline } from 'vite-plugin-singlefile-offline'

export default defineConfig(({ mode }) => {
  let plugins = [tailwindcss()]

  if (mode === 'singlefile') {
    plugins = plugins.concat(viteSingleFile())
  } else if (mode === 'singlefileoffline') {
    plugins = plugins.concat(singleFileOffline())
  }

  return {
    base: './',
    plugins,
  }
})
