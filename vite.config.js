import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { singleFileOffline } from 'vite-plugin-singlefile-offline'

export default defineConfig(({ mode }) => {
  let plugins = []

  if (mode === 'singlefile') {
    plugins = [viteSingleFile()]
  } else if (mode === 'singlefileoffline') {
    plugins = [singleFileOffline()]
  }

  return {
    base: './',
    plugins,
  }
})