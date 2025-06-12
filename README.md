## Intro Skipper Manifest URL (All Jellyfin Versions)

```
https://intro-skipper.org/manifest.json
```

# Issues

If you are having issues, check this out:

```bash
curl -A "Jellyfin-Server/10.10.7" https://intro-skipper.org/manifest.json -L -v
```

This should resolve to:

* IPv6: `2a03:b0c0:3:f0::cd5f:a000` or `2a03:b0c0:2:f0::841b:d001`
* IPv4: `161.35.245.42` or `165.227.244.161`

From there, you are redirected to GitHub.
