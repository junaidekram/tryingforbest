import { defineConfig } from "vite"

export default defineConfig({
  root: "src",
  base: process.env.NODE_ENV === 'production' ? '/tryingforbest/' : '/',
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 8000,
    open: "?local",
  },
  plugins: [
    {
      name: "requestLogger",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          console.log(`${req.method} ${req.url}`)
          next()
        })
      },
    },
  ],
})
