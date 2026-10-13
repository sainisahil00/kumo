# Kumo (雲)

A cloud storage website with a liquid-glass interface, built with Python (Flask) and SQLite.

## Run it

```bash
cd kumo
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000, create an account, and start dropping files in.

## What it does

- Accounts (sign up, sign in, sign out), each with a private space
- Upload by button or by dragging files anywhere on the page, with live progress
- Folders, rename, and drag an item onto a folder (or a breadcrumb) to move it
- Preview images, PDFs, text and code, audio and video without leaving the page
- Share any file with a link you can turn off again
- Search across all folders, Recent, Starred, and a Trash with undo and restore
- Storage meter with a per-user quota
- Grid and list layouts, sort by name, date or size
- Motion: staged hero, pointer parallax, scroll reveals, cascading file cards, gliding dock
  (all of it switches off for people who prefer reduced motion)

## Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `KUMO_QUOTA_MB` | 1024 | Storage per user |
| `KUMO_MAX_UPLOAD_MB` | 512 | Largest single file |
| `KUMO_HOST` / `KUMO_PORT` | 127.0.0.1 / 5000 | Where it listens |
| `KUMO_DEBUG` | off | Set to `1` for Flask debug mode |

## Where things live

```
app.py              Flask app: pages, JSON API, SQLite, file storage
templates/          Jinja pages (landing, auth, drive, share)
static/css/kumo.css The visual system (glass, layout, tokens)
static/css/motion.css Animation and premium finish layer
static/js/fx.js     Pointer light, hero parallax, scroll reveals
static/js/drive.js  The drive: listing, uploads, menus, previews
instance/           Created on first run: kumo.db, secret.key, storage/
```

Uploaded files are stored on disk under `instance/storage/<user id>/` with random names, and the
database maps them back to the names you see.

## Before putting it on the internet

This is a solid local app, not yet a hardened service. For public hosting, run it behind
gunicorn or waitress with HTTPS, set `SESSION_COOKIE_SECURE=True`, and consider adding email
verification, password reset, and rate limiting at the proxy.

## Known limits

- Dropping a whole folder from your desktop isn't supported yet (drop its files instead)
- Folders can't be downloaded as a zip or shared with a link yet
