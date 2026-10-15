# HideMessages

Revenge Classic (Vendetta-style) port of the Equicord plugin. Temporarily hide messages and DMs until you restart Discord.

- **Messages:** long-press a message and tap **Hide**.
- **DMs:** run `/hidedm` inside a DM to hide or unhide it.
- **Show hidden DMs:** run `/showhiddendms` to toggle them back into the DM list.

Everything is kept in memory only, so it resets on restart.

## Build

```sh
npm install
npm run build
```

The output is written to `dist/` (`index.js` and `manifest.json`). Host that folder
(for example with GitHub Pages or `npx http-server dist`) and install the plugin in
Revenge by its URL.
