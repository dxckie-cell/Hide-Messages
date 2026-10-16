# HideMessages

Revenge Classic (Vendetta-style) port of the Equicord plugin. Long-press a message and tap **Hide**
to remove it from your view until you restart Discord. Works alongside message loggers such as NoDelete+.

Nothing is stored: hidden messages come back after a restart.

## Build

```sh
npm install
npm run build
```

Output goes to `dist/`. The included GitHub Actions workflow publishes it to GitHub Pages.
