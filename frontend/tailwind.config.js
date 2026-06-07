/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['DM Serif Display', 'Georgia', 'serif'],
        body: ['DM Sans', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        ink: {
          50: '#f5f3f0',
          100: '#e8e4de',
          200: '#d0c9bf',
          300: '#b5a99a',
          400: '#9a8a77',
          500: '#7d6e5c',
          600: '#63574a',
          700: '#4a4038',
          800: '#322c26',
          900: '#1c1814',
          950: '#0e0c0a',
        },
        amber: {
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          400: '#fbbf24',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
          800: '#92400e',
          900: '#78350f',
        },
        sage: {
          50: '#f2f5f0',
          100: '#e2e9de',
          200: '#c3d2bb',
          300: '#9bb591',
          400: '#739469',
          500: '#557548',
          600: '#415c37',
          700: '#31452a',
          800: '#222f1d',
          900: '#141c11',
        },
        drift: {
          positive: '#4CAF7D',
          negative: '#E05C5C',
          neutral: '#9A8A77',
        }
      },
      animation: {
        'fade-in': 'fadeIn 0.4s ease-out',
        'slide-up': 'slideUp 0.4s ease-out',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        slideUp: { from: { opacity: '0', transform: 'translateY(12px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        pulseSoft: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.6' } },
      }
    }
  },
  plugins: [],
}
