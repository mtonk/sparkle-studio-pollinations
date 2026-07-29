# Vendored front-end libraries

These are served from our own origin instead of a CDN. A `<script>` tag from a
third-party host executes with full access to the page, and `lucide@latest` in
particular meant the version could change without a commit or a deploy. Serving
them ourselves also means the installed home-screen app works offline.

| file | version | source |
|---|---|---|
| `fabric-5.3.1.min.js` | 5.3.1 | https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.1/fabric.min.js |
| `lucide-1.27.0.min.js` | 1.27.0 | https://unpkg.com/lucide@1.27.0/dist/umd/lucide.min.js |

SHA-256 of the files as downloaded:

```
bb0442d69a4d4673320f689bc6e16c05a0e3f16ccfbf551f394d90a7e7cfc772  fabric-5.3.1.min.js
e37f337f85a50b1af4c830cb46e32545201ab6625f00deacf42721bf33ff0de0  lucide-1.27.0.min.js
```

## Updating

Download the new version alongside the old one, point the `<script>` tags in
`public/index.html` and `public/settings.html` at it, check the drawing tools
and icons still work, then delete the old file. Keep the version in the
filename so the page and the file can never disagree about what is loaded.
