import type { Config } from "tailwindcss";

/**
 * The palette is taken from the logo rather than chosen next to it: a glitched
 * bolt in cyan and magenta on nothing. Those two are the only accents, and
 * everything else is degrees of black — which is what keeps a neon page from
 * turning into a fairground.
 */
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: "#04050a",
        panel: "#0a0d16",
        edge: "#151b2b",
        cyan: { DEFAULT: "#00e5ff", dim: "#0b7f8c" },
        magenta: { DEFAULT: "#ff2bd1", dim: "#8c1476" },
        ash: "#7c88a8",
        bone: "#e6ecff",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      keyframes: {
        flicker: {
          "0%, 100%": { opacity: "1" },
          "48%": { opacity: "1" },
          "50%": { opacity: "0.72" },
          "52%": { opacity: "1" },
        },
        sweep: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
        drift: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-6px)" },
        },
      },
      animation: {
        flicker: "flicker 6s infinite steps(1)",
        sweep: "sweep 7s linear infinite",
        drift: "drift 5s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
export default config;
