## Intro Skipper Manifest URL (All Jellyfin Versions)

```
https://intro-skipper.org/manifest.json
```

## Stable Manifest URL (Jellyfin 12.x)

The canonical stable catalog for all Jellyfin 12.x versions is:

```
https://raw.githubusercontent.com/intro-skipper/manifest/main/12/manifest.json
```

## Prerelease Manifest URL (Jellyfin 12.x)

Every commit to the intro-skipper `12.0` branch publishes an automated prerelease build to `12/manifest-prerelease.json`. Add this URL as an additional repository in Jellyfin to test the latest build:

```
https://raw.githubusercontent.com/intro-skipper/manifest/main/12/manifest-prerelease.json
```

Prerelease versions follow the scheme `<jellyfin major>.<jellyfin minor>.<release>.<commits since release>` (for example `12.0.1.14`), so a prerelease always sorts above the stable release it is based on and below the next stable release. The catalog only contains the single most recent build, as each build replaces the previous prerelease archive.

Both `12.0/manifest.json` and `12.0/manifest-prerelease.json` remain available as byte-identical, synchronized compatibility copies of the catalogs under `12/`. They are regular JSON files, not symlinks, so existing raw GitHub and jsDelivr URLs continue to work. The `12.0` source branch, plugin versions, and `targetAbi` values are unchanged; Jellyfin still checks each entry's `targetAbi` for compatibility. Jellyfin 10.x catalogs retain their existing major.minor directories, such as `10.11/`.

# Issues

If you are having issues, check this out:

```bash
curl -A "Jellyfin-Server/10.11.1" https://intro-skipper.org/manifest.json -L -v
```

This should resolve to:

* IPv6: `2a03:b0c0:3:f0::cd5f:a000` or `2a03:b0c0:2:f0::841b:d001` or `2a01:4f8:c014:ffe9::1`
* IPv4: `161.35.245.42` or `165.227.244.161` or `178.105.98.131`

From there, you are redirected to jsDelivr.
