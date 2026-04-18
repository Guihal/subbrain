export default defineNuxtConfig({
  compatibilityDate: "2025-05-15",
  future: { compatibilityVersion: 4 },
  modules: ["@nuxt/ui", "@vueuse/nuxt"],

  css: ["~/assets/css/main.css"],

  runtimeConfig: {
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE || "",
    },
  },

  colorMode: {
    preference: "dark",
    fallback: "dark",
  },

  devServer: {
    port: 3000,
  },

  nitro: {
    devProxy: {
      "/v1": { target: "http://localhost:4000/v1", changeOrigin: true },
      "/api": { target: "http://localhost:4000/api", changeOrigin: true },
      "/health": { target: "http://localhost:4000/health", changeOrigin: true },
    },
  },

  devtools: { enabled: false },
});
