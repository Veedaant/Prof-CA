import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";

const mono = {
  50: "#fafafa", 100: "#f4f4f5", 200: "#e4e4e7", 300: "#d4d4d8", 400: "#a1a1aa",
  500: "#52525b", 600: "#0a0a0a", 700: "#000000", 800: "#000000", 900: "#000000", 950: "#000000",
};

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: { sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"] },
      colors: {
        slate: colors.neutral,
        blue: mono,
        indigo: mono,
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
    },
  },
  plugins: [],
} satisfies Config;
