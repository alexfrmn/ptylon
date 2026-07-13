# Showcase assets

The screenshots in this directory are captured from a real, isolated Ptylon
instance. They are not mockups.

## Reproduce

Build and start the application with throwaway `DATA_DIR`, `WORKSPACE_ROOT`,
and credentials, then run:

```bash
WC_BASE_URL=http://127.0.0.1:8790 \
WC_AUTH_PASSWORD=showcase-password \
pnpm capture:showcase
```

The command writes these files to `docs/images/`:

- `ptylon-workspace.png`
- `ptylon-theme-gallery.png`
- `ptylon-mobile.png`

The capture helper replaces the terminal prompt with a neutral display prompt.
Still inspect every generated image before publishing: never commit screenshots
that expose real hostnames, paths, usernames, terminal history, credentials, or
customer data.
