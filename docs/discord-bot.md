# Community Discord reporting

Requires Node ≥20.12 and the installed `discord.js` package.
The bot uses an administrator's `/setup-report` command, a public button and a private modal
submission. Ordinary channel messages are ignored. Only the Guilds gateway intent is requested;
Message Content Intent is unnecessary and can be disabled in the Discord Developer Portal.

## Configure and run

1. Invite the bot with **bot** and **applications.commands** scopes. Grant View Channel, Send
   Messages, Read Message History, Attach Files and Embed Links in the configured channel.
   Administrators alone can run `/setup-report`; ordinary members can use its button.
2. Set `DISCORD_BOT_TOKEN` and the same `DISCORD_SYNC_SECRET` for both API and
   bot in their environment or ignored `.env`. Never place credentials in source or client-side
   `VITE_` settings. Exported environment values take precedence over `.env`.
3. Set `DISCORD_REPORT_CHANNEL_ID` to your server text channel. It determines the server where
   the command is registered and the destination for outbound web reports. If omitted, startup
   requires exactly one `#fire-reports` channel, optionally restricted by `DISCORD_GUILD_ID`.
   `DISCORD_REPORT_CHANNEL_NAME` changes that fallback name.
4. `COMMUNITY_API_URL` defaults to
   `http://127.0.0.1:8787/api/v1`; use HTTPS for a remote API. The API must use the same sync secret.

In separate terminals:

```sh
npm run api
npm run dev
npm run discord:bot
```

Startup creates or updates only the guild's `setup-report` command; unrelated commands remain.
`npm run discord:check` verifies bot login, channel permissions and
modal location resolution. It sends no Discord messages and creates no community posts.

## Test the report form

1. As a server administrator, run `/setup-report` in the text channel where the panel belongs.
   The bot needs Send Messages and Embed Links there. The embed contains **Report an Incident**.
   If the command is absent, check startup output, the server selected by the configured channel,
   and the application's `applications.commands` invitation scope, then reopen Discord's command menu.
2. Click the button. Enter a location such as **Biratnagar, Nepal** or **26.45505, 87.27007** and
   a description. Image URL and reporter name are optional; a blank name uses your Discord name.
3. Submit. Only you see the initial acknowledgement and subsequent success or error. Success
   means the website saved the report. The appended evidence status explains whether satellites
   matched, weather raised risk, or verification remains pending.
4. Open the web Community page. It refreshes every 15 seconds while visible and on window focus.
   Check the Discord badge, location, image and evidence status. On a Pending or High Risk
   anomaly, three distinct community voting keys turn the badge blue. Poll voting is separate.
5. Type an ordinary channel message: the bot does not consume or forward it.

Use an explicitly labeled test description if making a real test report: it will be saved to the
regular community feed. Automated tests instead use an isolated database and weather fixtures.

## Location, images and verification

- Explicit latitude/longitude or named places are resolved directly using Open-Meteo Geocoding.
  place/country components and Open-Meteo Geocoding to obtain coordinates. A unique result is
  required; ambiguous or unresolved names produce a private error inviting a more specific name
  or coordinates. Coordinates are never invented from imagery.
- Image links must be HTTPS, without credentials or a custom port, on `i.imgur.com`, `imgur.com`,
  `www.imgur.com`, `cdn.discordapp.com`, `media.discordapp.net`, `images.unsplash.com` or
  `upload.wikimedia.org`. Simple Imgur image-page links are converted to a direct link; albums
  are unsupported. The bridge downloads PNG/JPEG/WebP only, up to 4 MiB, with no redirects and
  a 15-second timeout. Both source link and validated Base64 image are stored.
- The API first checks the stored NASA FIRMS window within **15 km**. A satellite match is
  green and includes its acquisition date. Otherwise, current Open-Meteo conditions produce an
  orange **High Risk Weather** badge only when temperature **>30°C**, humidity **<30%** and wind
  **>15 km/h** all hold. Other conditions or provider failure yield yellow **Pending Verification**.
  Discord replies include available °C, % RH and km/h readings. Weather risk is not proof of fire.
- Three distinct registered API keys can confirm a Pending/High Risk anomaly, yielding blue
  **Community Verified**. This is informal community evidence, not verified-person identity.
  It never overrides a satellite match. [API details](api.md#community-reports-and-discord)
  describe timestamps, failure handling and voting routes.

## Delivery and operation

- **Web → Discord:** `DISCORD_WEBHOOK_URL` takes precedence; otherwise the API uses the bot token
  and report channel ID. Images are multipart attachments. Delivery failure leaves the web post
  saved and returns a notice. Poll votes remain backend-persisted; automatic result announcements
  are not enabled.
- **Discord → web:** modal submissions use `discord-sync` with the shared secret. They are never
  echoed back to Discord. Stable interaction IDs deduplicate API retries; mention notifications
  are suppressed. Each modal is acknowledged before network work. Processing is serial, with
  at most five active/queued submissions; overflow receives a private retry notice.
- The JSON store supports one API writer process. Base64 images increase file/feed size; larger
  deployments should use object storage and pagination. The bot is a foreground process:
  stopping its terminal stops button handling, without deleting existing panels or reports.
  Restarting it restores interaction handling. Use a host service manager for deployment.

## Render deployment: Environment tab, web service and Discord worker

Connect **https://github.com/rickykhulal/continuum-final** on branch **main**. The supplied
`render.yaml` describes two paid Starter services: a web service with a 1 GB persistent disk,
and a background worker. Deploying these services incurs Render charges. A free web service can
serve the bundled dashboard, but its filesystem is ephemeral and it cannot provide the persistent
Community store or the always-running Discord worker described here.

For an existing Render service, open **Settings → Build & Deploy** and change its repository to
`continuum-final` and branch to `main`. Use these commands:

| Service | Build command | Start command |
| --- | --- | --- |
| Web/API | `npm ci --include=dev && npm run api:build && npm run build` | `npm start` |
| Background worker | `npm ci --omit=dev` | `npm run discord:bot` |

On the web service, add a persistent disk mounted at `/var/data`. Run only one API instance against
this JSON store. In **Environment → Add Environment Variable**, enter names and actual values
without surrounding quotes. `.env.example` is a template; Render does not use your local `.env`.
Set these separately on each service, then choose **Save, rebuild, and deploy**:

| Variable | Web/API | Discord worker |
| --- | --- | --- |
| `NODE_VERSION` | `22` | `22` |
| `NODE_ENV` | `production` | `production` |
| `DATA_BUNDLE_PATH` | `public/data` | Not needed |
| `APP_DATA_PATH` | `/var/data/continuum` | Not needed; worker writes through the API |
| `LOG_FORMAT` | `json` | Optional |
| `FIRMS_MAP_KEY` | Your NASA FIRMS key, if using keyed access; public CSV polling and bundled startup do not require it | Not needed |
| `DISCORD_BOT_TOKEN` | Your bot token, for outbound posts when no webhook is configured | The same bot token |
| `DISCORD_REPORT_CHANNEL_ID` | Your target channel ID | The same channel ID, selecting the command's server |
| `DISCORD_SYNC_SECRET` | A newly generated random shared secret | Exactly the same value |
| `DISCORD_WEBHOOK_URL` | Optional actual Discord webhook URL; leave absent to use bot delivery | Not needed |
| `COMMUNITY_API_URL` | Not needed | Full web URL ending in `/api/v1`, e.g. `https://your-web-service.onrender.com/api/v1` |

Keep **PORT unset** in the dashboard; Render supplies it. Leave **DATA_BUNDLE_VERSION unset** so
the API reports the committed manifest version. Same-origin hosting also needs no
`PUBLIC_API_BASE_URL`, `API_CORS_ORIGINS` or `VITE_API_BASE`. If hosting the frontend separately,
set `VITE_API_BASE` to the API's HTTPS `/api/v1` URL during the frontend build, set
`API_CORS_ORIGINS` on the API to the frontend origin, and optionally set `PUBLIC_API_BASE_URL` to
its public API URL. `API_MAX_AREA_KM2`, `API_MAX_UPLOAD_MB` and `API_RATE_LIMITS` retain the defaults
in `.env.example`; `METRICS_TOKEN` is optional for authenticated monitoring. `EARTHDATA_TOKEN`
belongs only on a host that performs a keyed archive backfill. Never prefix a secret with `VITE_`.

Generate the shared secret locally with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
and copy it into the two Environment tabs. Do not use a documented sample secret or copy placeholder
strings from `.env.example` as credentials. The webhook is optional, so do not enter a placeholder URL.

After deployment, verify `/api/v1/health` and `/api/v1/ready`, then run `npm run discord:check` in the
worker's Render Shell to verify the configured model, channel permissions and location parsing.
The worker log should show `/setup-report registered`. Run the admin command in Discord and submit
a labeled test report; check its private result and web feed. Stop any local instance of the same
bot before enabling the Render worker, so one process handles each interaction. Existing local
posts are not uploaded by Git; import the local store to the persistent disk separately if needed.

Startup reads the bundled FIRMS snapshot independently of the live provider. Requests have a
10-second deadline, including JSON decoding. Stalled optional archive/climate requests cannot hold
the screen indefinitely; a stalled snapshot request also attempts a bounded cache recovery. If the
snapshot itself is unavailable, the page shows Retry instead of an endless spinner. Map live
polling times out to the bundled snapshot with the toast “Live API timeout. Using bundled snapshot.”
The snapshot keeps its original acquisition window and is labeled as bundled when the live API fails.
