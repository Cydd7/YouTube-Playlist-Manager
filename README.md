# Playlist Manager for YouTube

A Chrome extension that adds a dashboard to the top of your YouTube playlists page
(<https://www.youtube.com/feed/playlists>). In it you can:

- sort playlists into folders, and folders into folders
- drag and drop folders, playlists and videos
- open and close folders
- back everything up (the folder structure plus full video details) as one JSON file, and restore it
- pull all your playlists and videos from YouTube in one go (a temporary feature)

Everything stays in your browser. Changes you make in the dashboard don't change your playlists on YouTube.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension` folder.
4. Open <https://www.youtube.com/feed/playlists>, or click the extension's toolbar button.

To try it without any setup, click **Import** and choose [`samples/sample-backup.json`](samples/sample-backup.json).

After changing the code, click the reload button on the extension's card in `chrome://extensions` and refresh the YouTube tab.

## Using the dashboard

| To | Do this |
|---|---|
| Add a folder | **Folder** in the toolbar adds one at the top level. The folder-plus button on a folder's row adds one inside it. |
| Rename a folder | Use the pencil button on its row, or double-click its name. Enter saves, Esc cancels. |
| Delete a folder | Use the bin button on its row. Whatever was inside moves up to the parent folder; no playlists or videos are deleted. |
| Open or close | Click a folder's or playlist's row. An open playlist shows its videos. |
| Move something | Drag its row. Drop on the top or bottom edge of a row to place it before or after that row. Drop on the middle of a folder to put it inside. Drop a video on a playlist to add it to the end. Drop below the last row to move to the top level. Hovering over a closed folder while dragging opens it. |
| Back up | **Export** downloads `playlist-manager-backup-YYYY-MM-DD.json`. |
| Restore | **Import** a backup. The file is checked first, and you're asked before your current library is replaced. |
| Hide the folders | Click the arrow next to "Playlist Manager". |

A folder can hold folders and playlists. A playlist can hold only videos. The same video can be in several playlists.

## Set up "Pull from YouTube"

The pull uses the official YouTube Data API with read-only access to your account, so it needs a Google Cloud
project of your own. This is a one-time setup of about 10 minutes.

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project (any name).
2. In **APIs & Services → Library**, find **YouTube Data API v3** and click **Enable**.
3. Set up the **OAuth consent screen** (called **Google Auth Platform** in newer versions of the console):
   - Enter an app name and your email, and choose the **External** audience.
   - Under **Audience → Test users**, add the Google account that owns your YouTube channel.
   - Under **Data Access**, add the scope `https://www.googleapis.com/auth/youtube.readonly`.
   - Leave the app in **Testing**. You don't need to publish or verify it.
4. Create an **OAuth client ID** (under **Clients**, or **Credentials → Create credentials**):
   - Application type: **Web application**.
   - Authorized redirect URI: `https://hbmgcfjjjjkdmbajfejeeabakcakcoil.chromiumapp.org/` (with the trailing slash).
5. Paste the client ID into [`extension/config.js`](extension/config.js) as `googleClientId`, then reload the
   extension in `chrome://extensions`.
6. On the playlists page, click **Pull from YouTube** and pick your account or brand channel. Google warns that it
   hasn't verified the app. It's your own app in testing mode, so choose **Continue**.

The `key` in `manifest.json` fixes the extension's ID (`hbmgcfjjjjkdmbajfejeeabakcakcoil`), so the redirect URI is
the same wherever you load the folder from. If sign-in fails, the dashboard shows the redirect URI to check.

What the pull does:

- It reads every playlist your channel owns, every video in them, and the full details of each video: title,
  channel, duration, description, tags, publish date, view/like/comment counts, privacy and more.
- Each API call returns up to 50 items and costs 1 quota unit. 100 playlists with 5,000 videos use about 250 of
  the 10,000 free daily units.
- It replaces your current library after asking. Export first if you want to keep it. Every playlist lands at the
  top level, ready to sort.
- Deleted and private videos are kept and marked as unavailable.
- Watch Later and playlists you saved from other channels aren't included, because the API doesn't provide them.

## Backup format

A backup is a single JSON document. The library is stored in the same shape.

```jsonc
{
  "format": "playlist-manager",
  "version": 1,
  "exportedAt": "2026-10-30T12:00:00.000Z",
  "root": ["fld_music", "PLsample0000000004"],            // top level, in display order
  "folders": {
    "fld_music": { "name": "Music", "open": true, "children": ["PLsample0000000001", "fld_focus"] }
  },
  "playlists": {
    "PLsample0000000001": {
      "title": "Morning run",
      "open": false,
      "items": [{ "videoId": "sampleVid01", "addedAt": "2024-05-01T10:00:00Z" }],
      "youtube": { /* the playlist exactly as the YouTube API returned it */ }
    }
  },
  "videos": {
    "sampleVid01": { /* the video exactly as the YouTube API returned it: snippet, contentDetails, statistics, … */ }
  }
}
```

- The data is flat: folders, playlists and videos each live in their own map keyed by ID, and the tree only lists
  IDs. A video's details are stored once even when it's in several playlists, and moving something only edits two
  ID lists.
- Playlists keep their YouTube IDs and the raw API data. That leaves room to sync changes back to YouTube later.
- `version` lets future versions convert older backups.
- An import is rejected, with the reasons shown, if the file breaks the rules. For example: an ID listed in two
  places, a folder inside itself, an item that isn't a folder or playlist, or a playlist entry whose video is
  missing from `videos`.

The library is saved in `chrome.storage.local`, with the `unlimitedStorage` permission because full details for a few
thousand videos exceed Chrome's default 10 MB. It's split into two keys: the structure, which is small and saved on
every change, and the video details, which are large and saved only by Import and Pull. That keeps dragging fast.
The data belongs to this Chrome profile; use Export and Import to move it to another computer.

## Development

There's no build step: the files in `extension/` are what Chrome loads.

| Path | What it does |
|---|---|
| `extension/manifest.json` | Manifest V3. The content scripts run on youtube.com, but the dashboard only appears on `/feed/playlists`. |
| `extension/lib/model.js` | Data model: rules, moves, validation, import/export, building the library from API data. Pure JavaScript, also used by the tests. |
| `extension/lib/storage.js` | Loading and saving in `chrome.storage.local`, and noticing changes from other tabs. |
| `extension/lib/youtube-api.js` | YouTube Data API client for the pull: paging, retries, error messages. |
| `extension/background.js` | Service worker: Google sign-in and the pull. The toolbar button opens the playlists page. |
| `extension/content/main.js` | Finds the playlists page (YouTube changes pages without reloading) and places the dashboard above the grid. |
| `extension/content/dashboard.js` | The dashboard itself, rendered in a Shadow DOM so YouTube's CSS can't affect it. |
| `extension/content/dnd.js` | Drag and drop: which drops are allowed and where they land. |
| `extension/content/pull.js` | The Pull from YouTube button and its progress messages. |
| `extension/content/dom.js`, `styles.js` | Element and icon helpers, and the dashboard's CSS. The UI is built without `innerHTML` because YouTube enforces Trusted Types. |

Tests:

```bash
npm test
```

```bash
npm run test:e2e
```

`npm test` runs the unit tests (model, drag-and-drop rules, API client) with Node's built-in test runner.
`npm run test:e2e` loads the extension into Chromium and drives the dashboard on a stand-in YouTube page, with Google
sign-in and the API stubbed. It needs Playwright first:

```bash
npm i -D playwright && npx playwright install chromium
```

### Removing "Pull from YouTube" later

1. Delete `extension/content/pull.js`, `extension/lib/youtube-api.js` and `extension/config.js`.
2. In `extension/background.js`, remove everything except the toolbar-button listener.
3. In `extension/manifest.json`, remove `content/pull.js` from the content scripts, the `identity` permission and the
   `https://www.googleapis.com/*` host permission.

The dashboard hides the button by itself once `pull.js` is gone.
