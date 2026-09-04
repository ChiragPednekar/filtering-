/** @type {import('tailwindcss').Config} */
export default {
  // 'class' rather than 'media' so the app can offer an explicit Light/Dark/System
  // choice instead of only following the OS.
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: {} },
  plugins: [],
}
