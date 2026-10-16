# HideMessages

Temporarily hide messages on **Revenge Classic** (Vendetta-style Discord mobile mod) until you restart Discord.

A port of the Equicord/Vencord *HideMessages* plugin.

## Install

In Revenge, go to **Settings → Plugins → Add** and paste:

```
https://dxckie-cell.github.io/Hide-Messages/
```

## Usage

1. Long-press any message.
2. Tap **Hide** at the bottom of the menu.

The message disappears from your view. It is only removed locally: nobody else sees any change, and nothing is deleted on Discord.

## Notes

- Hidden messages come back after you restart Discord. Nothing is saved.
- Works together with message-logger plugins such as NoDelete+, which normally keep "deleted" messages on screen.
- If a message can't be removed, the plugin shows a toast saying so.

## Build

Pushing to `main` builds the plugin with GitHub Actions and publishes it to GitHub Pages
(repo **Settings → Pages → Source: GitHub Actions**).

To build locally:

```sh
npm install
npm run build
```

The output is written to `dist/`.
