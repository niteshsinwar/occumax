/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "#fdfbf7",
        surface: { DEFAULT: "#ffffff", '2': "#f4eedb" },
        border: "#e6dcd3",
        text: { DEFAULT: "#2c1b18", muted: "#7a594e" },
        accent: { DEFAULT: "#c5a059", dim: "#f8f3e6" },
        occugreen: { DEFAULT: "#154734", dim: "#e6efea" },
        occured: { DEFAULT: "#8c2a2a", dim: "#f4e6e6" },
        occuorange: { DEFAULT: "#a66a38", dim: "#f3ebe4" },
        occublue: { DEFAULT: "#283553", dim: "#e8ebf0" },
        occuyellow: { DEFAULT: "#d4af37", dim: "#fbf6e8" },
      },
      boxShadow: {
        'glass': '0 8px 32px rgba(44, 27, 24, 0.05)',
        'subtle': '0 2px 10px rgba(44, 27, 24, 0.03)',
      },
      fontFamily: {
        serif: ["'Playfair Display'", "serif"],
        sans: ["Inter", "ui-sans-serif", "system-ui"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
}
