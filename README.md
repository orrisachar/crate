# Record Crate

A crate-digging website for your Discogs collection. Guests scan a QR code, flip through your records like a bin at a shop, and pull one out to see the tracklist, pressing details and the actual vinyl colour.

Live example: https://orrisachar.github.io/crate/

## What you need

- A Discogs account, with your collection set to public in your Discogs privacy settings
- A free GitHub account
- Optional: a Google account, for the full setup below

## Quick setup (GitHub only, about 10 minutes)

1. Click **Fork** at the top right of this page, then **Create fork**.
2. In your fork, open `index.html` and click the pencil icon to edit it. Near the top, change the settings block:
   - `title`: the name shown on your site
   - `discogsUser`: your Discogs username
   - `feed`: set it to `''` (two single quotes). Otherwise your site shows Orri's records.
   - Also change the `<title>` line just above the settings block.
3. Click **Commit changes**.
4. Go to **Settings > Pages**. Set Source to **Deploy from a branch** and Branch to **main** and **/(root)**, then click **Save**.
5. After a minute or two your site is live at `https://YOUR-USERNAME.github.io/crate/`. Point your QR code there.

Without the full setup, each record shows the year of the pressing you own rather than the original release year, and there's no Spotify player. Everything else works.

## Full setup (adds original years and Spotify)

This adds a free Google Apps Script that feeds the site. It adds original release years, an optional Spotify player, and caching.

1. Go to script.google.com and click **New project**.
2. Paste the contents of `Code.gs` from this repo into the editor's `Code.gs`. In `CONFIG` at the top, change `DISCOGS_USER` and `SITE_TITLE`.
3. Next to Files, click **+ > HTML**, name it `Index`, and paste in the contents of `index.html`.
4. Get a Discogs token at discogs.com/settings/developers. In Apps Script, go to **Project Settings > Script properties** and add `DISCOGS_TOKEN` with the token as the value.
5. Pick `warmUp` in the function dropdown and click **Run**. Approve the permissions; Google warns because it's your own unverified script, so click Advanced, then go to the project.
6. Click **Deploy > New deployment**, choose **Web app**, and set Execute as: **Me** and Who has access: **Anyone**. Copy the URL ending in `/exec`.
7. In your fork's `index.html`, set `feed` to that URL and commit.

**Optional Spotify:**
1. Create an app at developer.spotify.com/dashboard. The account that owns the app needs Spotify Premium.
2. Add `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` as script properties.
3. Run `warmUp` again.

## Good to know

- Point your QR code at the github.io page, not the Apps Script `/exec` link. Google breaks `/exec` links for people signed into more than one Google account.
- New Discogs adds show up on their own. With Apps Script it takes up to about 10 minutes; run `refreshNow` to force it.
- After changing `Code.gs`, go to **Deploy > Manage deployments**, click the pencil icon, choose **New version**, then **Deploy**. Don't create a new deployment, because that changes the URL.
- Link straight to one record by adding `?r=` and the Discogs release id to the URL.
