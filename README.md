# Doc Polisher

Upload a .txt or .docx, get back a cleanly formatted, error-corrected .docx
(spacing, paragraphs, headings, bullets, numbering, punctuation).

## Run on your computer
1. Install Node.js 18+.
2. In this folder: `npm install`
3. Set your key and start:
   - Mac/Linux: `ANTHROPIC_API_KEY=your-key npm start`
   - Windows (PowerShell): `$env:ANTHROPIC_API_KEY="your-key"; npm start`
4. Open http://localhost:3000

## Put it online (Render)
1. Push this folder to a GitHub repository.
2. On render.com: New > Web Service > connect the repo.
3. Build command: `npm install`  Start command: `npm start`
4. Add environment variables:
   - `ANTHROPIC_API_KEY` (from console.anthropic.com)
   - `ACCESS_CODE` (a password, so strangers can't spend your credits)
5. Deploy, then open the Render URL.

Notes: uploads up to 10 MB and about 400,000 characters. Jobs are held in memory,
so a server restart clears any job in progress.
