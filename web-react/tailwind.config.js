/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        // 与 ink CLI / vanilla web 主题对齐
        bg: "var(--cc-bg, #0e1117)",
        fg: "var(--cc-fg, #e6e8eb)",
        muted: "var(--cc-muted, #8b95a5)",
        border: "var(--cc-border, #2c333d)",
        accent: "var(--cc-accent, #4a9cff)",
        danger: "var(--cc-danger, #c83b3b)",
        ok: "var(--cc-ok, #2da94f)",
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
