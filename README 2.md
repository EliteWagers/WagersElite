# Elite Wagers — clean restart package

This package preserves the Elite Wagers website UI and its matching Node.js server.

## Files must be in the repository ROOT (not inside another folder)
- index.html
- server.js
- package.json
- Dockerfile (fallback if using Render Docker runtime)
- .env.example
- .gitignore
- README.md

Do not rename these files or add numbers/spaces to their names.

## Recommended Render setup (Node runtime)
- Runtime: Node
- Root Directory: leave blank
- Build Command: `npm install`
- Start Command: `npm start`
- Instance: Free

If the Render service is configured as Docker instead, this package includes a Dockerfile. Prefer the Node runtime settings above for the simplest setup.

## Optional integrations
The website's optional Odds API / AI integrations require their own provider keys and may have usage limits or charges. Keep keys in Render Environment Variables only; never commit `.env` or keys to GitHub.

## Restart instructions
1. Replace the old repository files with the contents of this ZIP at the repository root.
2. Confirm `package.json`, `server.js`, and `index.html` appear together at the first level.
3. In Render, open Settings and confirm Node runtime, blank Root Directory, `npm install`, and `npm start`.
4. Trigger Manual Deploy -> Deploy latest commit.
