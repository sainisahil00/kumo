"""Kumo - a calm place for your files.  (Vercel-ready version)

Required environment variables on Vercel:
    SECRET_KEY          long random string (python -c "import secrets; print(secrets.token_hex(32))")
    DATABASE_URL        Postgres connection string (Neon, added from Vercel Marketplace)
    KUMO_AWS_KEY_ID     access key of an IAM user limited to the S3 bucket
    KUMO_AWS_SECRET     secret key of that IAM user
Optional:
    KUMO_S3_BUCKET (default kumo-s3-storage), KUMO_S3_REGION (default ap-south-1),
    KUMO_QUOTA_MB (default 1024), KUMO_MAX_UPLOAD_MB (default 4 on Vercel, 512 elsewhere)

Local run:  set the same variables, then  python app.py
"""
import mimetypes
import os
import re
import secrets
import time
import uuid
from functools import wraps
from pathlib import Path
from urllib.parse import quote

import psycopg2
import psycopg2.extras
from flask import (Flask, abort, g, jsonify, redirect, render_template,
                   request, send_file, session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

BASE = Path(__file__).resolve().parent
INSTANCE = BASE / "instance"
STORAGE = INSTANCE / "storage"
ON_VERCEL = bool(os.environ.get("VERCEL"))

QUOTA = int(float(os.environ.get("KUMO_QUOTA_MB", 1024)) * 1024 * 1024)
# Vercel functions reject request bodies above ~4.5 MB, so uploads through Flask stay small there.
MAX_UPLOAD = int(float(os.environ.get("KUMO_MAX_UPLOAD_MB", 4 if ON_VERCEL else 512)) * 1024 * 1024)

DATABASE_URL = os.environ.get("DATABASE_URL", "")

# S3 storage. Set KUMO_S3_BUCKET="" to keep files on local disk (local development only).
S3_BUCKET = os.environ.get("KUMO_S3_BUCKET", "kumo-s3-storage")
S3_REGION = os.environ.get("KUMO_S3_REGION", "ap-south-1")
USE_S3 = bool(S3_BUCKET)
if USE_S3:
    import boto3
    from botocore.config import Config
    from botocore.exceptions import BotoCoreError, ClientError
    # Explicit keys from env vars (Vercel). If they are not set, boto3 falls back to its
    # normal lookup, which includes the EC2 instance role.
    s3 = boto3.client(
        "s3", region_name=S3_REGION,
        aws_access_key_id=os.environ.get("KUMO_AWS_KEY_ID") or None,
        aws_secret_access_key=os.environ.get("KUMO_AWS_SECRET") or None,
        config=Config(signature_version="s3v4"))
else:
    STORAGE.mkdir(parents=True, exist_ok=True)


def s3_key(uid, stored_name):
    return f"{uid}/{stored_name}"


def load_secret():
    env = os.environ.get("SECRET_KEY")
    if env:
        return env
    path = INSTANCE / "secret.key"  # local development fallback only
    try:
        INSTANCE.mkdir(exist_ok=True)
        if not path.exists():
            path.write_text(secrets.token_hex(32))
        return path.read_text().strip()
    except OSError:
        raise RuntimeError("SECRET_KEY environment variable is not set.")


app = Flask(__name__)
app.config.update(
    SECRET_KEY=load_secret(),
    MAX_CONTENT_LENGTH=MAX_UPLOAD + 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=ON_VERCEL,
    PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 30,
)

# --------------------------------------------------------------------------
# Database (Postgres)
# --------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    pw_hash TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id BIGINT REFERENCES items(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_folder INTEGER NOT NULL DEFAULT 0,
    size BIGINT NOT NULL DEFAULT 0,
    mime TEXT,
    stored_name TEXT,
    starred INTEGER NOT NULL DEFAULT 0,
    share_token TEXT UNIQUE,
    created_at DOUBLE PRECISION NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL,
    deleted_at DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS idx_items_user_parent ON items(user_id, parent_id);
"""


def connect():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL environment variable is not set.")
    return psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)


def init_db():
    conn = connect()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(SCHEMA)
    except psycopg2.Error:
        app.logger.exception("init_db failed (tables may already exist)")
    finally:
        conn.close()


def db():
    if "db" not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def q(sql, args=()):
    with db().cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchall()


def q1(sql, args=()):
    with db().cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchone()


def ex(sql, args=()):
    with db().cursor() as cur:
        cur.execute(sql, args)


def insert(sql, args=()):
    """Run an INSERT and return the new row id."""
    with db().cursor() as cur:
        cur.execute(sql + " RETURNING id", args)
        return cur.fetchone()["id"]


# --------------------------------------------------------------------------
# Auth, CSRF, headers
# --------------------------------------------------------------------------
def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    if "user" not in g:
        g.user = q1("SELECT * FROM users WHERE id = %s", (uid,))
    return g.user


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if current_user() is None:
            if request.path.startswith("/api/"):
                return jsonify(error="Please sign in again."), 401
            return redirect(url_for("login"))
        return view(*args, **kwargs)
    return wrapped


def csrf_token():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(24)
    return session["csrf"]


app.jinja_env.globals["csrf_token"] = csrf_token


@app.before_request
def protect():
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        sent = request.headers.get("X-CSRF-Token") or request.form.get("csrf") or ""
        if not secrets.compare_digest(sent, session.get("csrf", "")):
            if request.path.startswith("/api/"):
                return jsonify(error="Your session expired. Refresh the page and try again."), 400
            abort(400)


@app.after_request
def headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    return resp


FAILS = {}  # per-instance on serverless; still slows down a burst of guesses


def throttled(ip):
    now = time.time()
    FAILS[ip] = [t for t in FAILS.get(ip, []) if now - t < 900]
    return len(FAILS[ip]) >= 10


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
EXT_KINDS = {
    "image": {"png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "heic"},
    "pdf": {"pdf"},
    "doc": {"doc", "docx", "odt", "rtf", "pages", "txt", "md"},
    "sheet": {"xls", "xlsx", "csv", "ods", "numbers", "tsv"},
    "slides": {"ppt", "pptx", "key", "odp"},
    "code": {"py", "js", "ts", "jsx", "tsx", "html", "css", "json", "yml", "yaml",
             "sh", "c", "cpp", "h", "java", "go", "rs", "rb", "php", "sql", "xml", "toml"},
    "audio": {"mp3", "wav", "flac", "m4a", "ogg", "aac"},
    "video": {"mp4", "mov", "mkv", "webm", "avi", "m4v"},
    "archive": {"zip", "rar", "7z", "tar", "gz", "bz2"},
}
TEXT_PREVIEW = {"txt", "md", "csv", "tsv", "py", "js", "ts", "jsx", "tsx", "css", "json",
                "yml", "yaml", "sh", "c", "cpp", "h", "java", "go", "rs", "rb", "php",
                "sql", "xml", "toml", "log", "ini", "cfg"}
SAFE_IMAGE = {"png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"}


def ext_of(name):
    return os.path.splitext(name)[1].lstrip(".").lower()


def kind_of(row):
    if row["is_folder"]:
        return "folder"
    ext = ext_of(row["name"])
    for kind, exts in EXT_KINDS.items():
        if ext in exts:
            return kind
    return "file"


def preview_mode(row):
    """How a file may be shown inline ('' = download only). Kept strict on purpose."""
    if row["is_folder"]:
        return ""
    ext = ext_of(row["name"])
    if ext in SAFE_IMAGE:
        return "image"
    if ext == "pdf":
        return "pdf"
    if ext in TEXT_PREVIEW:
        return "text"
    if ext in EXT_KINDS["audio"]:
        return "audio"
    if ext in EXT_KINDS["video"]:
        return "video"
    return ""


def serialize(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "is_folder": bool(row["is_folder"]),
        "kind": kind_of(row),
        "ext": ext_of(row["name"]),
        "preview": preview_mode(row),
        "size": row["size"],
        "starred": bool(row["starred"]),
        "shared": bool(row["share_token"]),
        "parent_id": row["parent_id"],
        "created": row["created_at"],
        "updated": row["updated_at"],
        "deleted": row["deleted_at"],
    }


def clean_name(raw, fallback="Untitled"):
    name = (raw or "").replace("\\", "/").split("/")[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()
    if name in ("", ".", ".."):
        name = fallback
    return name[:200]


def err(message, status=400):
    return jsonify(error=message), status


def user_dir(uid):
    path = STORAGE / str(uid)
    path.mkdir(parents=True, exist_ok=True)
    return path


def used_bytes(uid):
    return q1("SELECT COALESCE(SUM(size), 0)::bigint AS n FROM items "
              "WHERE user_id = %s AND is_folder = 0", (uid,))["n"]


def get_item(iid, uid, include_deleted=False):
    sql = "SELECT * FROM items WHERE id = %s AND user_id = %s"
    if not include_deleted:
        sql += " AND deleted_at IS NULL"
    row = q1(sql, (iid, uid))
    if row is None:
        abort(404, description="That item no longer exists.")
    return row


def get_folder(fid, uid):
    if fid is None:
        return None
    row = get_item(fid, uid)
    if not row["is_folder"]:
        abort(400, description="That is not a folder.")
    return row


def subtree(iid, uid):
    return q(
        """WITH RECURSIVE t(id) AS (
               SELECT id FROM items WHERE id = %s AND user_id = %s
               UNION ALL
               SELECT i.id FROM items i JOIN t ON i.parent_id = t.id)
           SELECT items.* FROM items JOIN t ON items.id = t.id""",
        (iid, uid))


def unique_name(uid, parent_id, name, is_folder, exclude_id=None):
    stem, ext = (name, "") if is_folder else os.path.splitext(name)
    candidate, n = name, 1
    while q1("""SELECT 1 FROM items WHERE user_id = %s AND parent_id IS NOT DISTINCT FROM %s
                AND lower(name) = lower(%s) AND deleted_at IS NULL
                AND id IS DISTINCT FROM %s""",
             (uid, parent_id, candidate, exclude_id)):
        candidate = f"{stem} ({n}){ext}"
        n += 1
    return candidate


def parse_id(value):
    if value in (None, "", "null", "root"):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        abort(400, description="Invalid id.")


def remove_files(rows):
    keys = [(r["user_id"], r["stored_name"]) for r in rows
            if not r["is_folder"] and r["stored_name"]]
    if USE_S3:
        for i in range(0, len(keys), 1000):  # delete_objects accepts up to 1000 keys
            batch = [{"Key": s3_key(u, n)} for u, n in keys[i:i + 1000]]
            try:
                s3.delete_objects(Bucket=S3_BUCKET, Delete={"Objects": batch, "Quiet": True})
            except (BotoCoreError, ClientError):
                app.logger.exception("S3 delete failed")
        return
    for u, n in keys:
        (STORAGE / str(u) / n).unlink(missing_ok=True)


@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(413)
def handle_error(e):
    code = getattr(e, "code", 400)
    message = getattr(e, "description", "Something went wrong.")
    if code == 413:
        message = f"That file is larger than the {MAX_UPLOAD // (1024 * 1024)} MB upload limit."
    if request.path.startswith("/api/"):
        return err(message, code)
    return render_template("error.html", code=code, message=message), code


# --------------------------------------------------------------------------
# Pages
# --------------------------------------------------------------------------
@app.get("/")
def landing():
    return render_template("landing.html", user=current_user())


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if current_user():
        return redirect(url_for("drive"))
    error, form = None, {}
    if request.method == "POST":
        form = {"name": request.form.get("name", "").strip()[:80],
                "email": request.form.get("email", "").strip().lower()[:200]}
        password = request.form.get("password", "")
        if not form["name"]:
            error = "Tell us what to call you."
        elif not EMAIL_RE.match(form["email"]):
            error = "Enter a valid email address."
        elif len(password) < 8:
            error = "Use a password with at least 8 characters."
        elif q1("SELECT 1 FROM users WHERE email = %s", (form["email"],)):
            error = "An account with that email already exists. Try signing in."
        else:
            new_id = insert(
                "INSERT INTO users (name, email, pw_hash, created_at) VALUES (%s, %s, %s, %s)",
                (form["name"], form["email"], generate_password_hash(password), time.time()))
            db().commit()
            session.clear()
            session.permanent = True
            session["uid"] = new_id
            return redirect(url_for("drive"))
    return render_template("auth.html", mode="signup", error=error, form=form)


@app.route("/login", methods=["GET", "POST"])
def login():
    if current_user():
        return redirect(url_for("drive"))
    error, form = None, {}
    if request.method == "POST":
        form = {"email": request.form.get("email", "").strip().lower()[:200]}
        ip = (request.headers.get("X-Forwarded-For", request.remote_addr) or "?").split(",")[0].strip()
        user = q1("SELECT * FROM users WHERE email = %s", (form["email"],))
        if throttled(ip):
            error = "Too many attempts. Wait a few minutes and try again."
        elif user and check_password_hash(user["pw_hash"], request.form.get("password", "")):
            session.clear()
            session.permanent = True
            session["uid"] = user["id"]
            return redirect(url_for("drive"))
        else:
            FAILS.setdefault(ip, []).append(time.time())
            error = "That email and password don't match."
    return render_template("auth.html", mode="login", error=error, form=form)


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("landing"))


@app.get("/drive")
@login_required
def drive():
    user = current_user()
    return render_template("drive.html", user=user)


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------
@app.get("/api/items")
@login_required
def list_items():
    uid = current_user()["id"]
    view = request.args.get("view", "files")
    folder_id = parse_id(request.args.get("folder"))
    term = request.args.get("q", "").strip()
    path, folder = [], None

    if view == "files":
        folder = get_folder(folder_id, uid)
        rows = q("SELECT * FROM items WHERE user_id = %s AND parent_id IS NOT DISTINCT FROM %s "
                 "AND deleted_at IS NULL", (uid, folder_id))
        if folder:
            path = [dict(r) for r in q(
                """WITH RECURSIVE up(id, parent_id, name, depth) AS (
                       SELECT id, parent_id, name, 0 FROM items WHERE id = %s AND user_id = %s
                       UNION ALL
                       SELECT i.id, i.parent_id, i.name, up.depth + 1
                       FROM items i JOIN up ON i.id = up.parent_id)
                   SELECT id, name FROM up ORDER BY depth DESC""", (folder_id, uid))]
    elif view == "recent":
        rows = q("""SELECT * FROM items WHERE user_id = %s AND is_folder = 0 AND deleted_at IS NULL
                    ORDER BY updated_at DESC LIMIT 40""", (uid,))
    elif view == "starred":
        rows = q("SELECT * FROM items WHERE user_id = %s AND starred = 1 AND deleted_at IS NULL", (uid,))
    elif view == "trash":
        rows = q("""SELECT i.* FROM items i LEFT JOIN items p ON p.id = i.parent_id
                    WHERE i.user_id = %s AND i.deleted_at IS NOT NULL
                      AND (p.id IS NULL OR p.deleted_at IS NULL OR p.deleted_at <> i.deleted_at)
                    ORDER BY i.deleted_at DESC""", (uid,))
    elif view == "search":
        like = "%" + re.sub(r"([%_\\])", r"\\\1", term) + "%"
        rows = q("""SELECT * FROM items WHERE user_id = %s AND deleted_at IS NULL
                    AND name ILIKE %s ESCAPE '\\' LIMIT 200""", (uid, like))
    else:
        return err("Unknown view.")

    return jsonify(items=[serialize(r) for r in rows], path=path,
                   folder=serialize(folder) if folder else None,
                   usage={"used": used_bytes(uid), "quota": QUOTA})


@app.post("/api/folders")
@login_required
def create_folder():
    uid = current_user()["id"]
    data = request.get_json(silent=True) or {}
    parent_id = parse_id(data.get("parent_id"))
    get_folder(parent_id, uid)
    name = unique_name(uid, parent_id, clean_name(data.get("name"), "New folder"), True)
    now = time.time()
    new_id = insert(
        """INSERT INTO items (user_id, parent_id, name, is_folder, created_at, updated_at)
           VALUES (%s, %s, %s, 1, %s, %s)""", (uid, parent_id, name, now, now))
    db().commit()
    return jsonify(item=serialize(get_item(new_id, uid))), 201


@app.post("/api/upload")
@login_required
def upload():
    uid = current_user()["id"]
    parent_id = parse_id(request.form.get("parent"))
    get_folder(parent_id, uid)
    files = [f for f in request.files.getlist("files") if f and f.filename]
    if not files:
        return err("Choose a file to upload.")
    if (request.content_length or 0) > QUOTA - used_bytes(uid):
        return err("Not enough space left. Delete some files or empty the trash.", 413)

    created = []
    for f in files:
        name = unique_name(uid, parent_id, clean_name(f.filename), False)
        stored = uuid.uuid4().hex
        if USE_S3:
            f.stream.seek(0, os.SEEK_END)
            size = f.stream.tell()
            f.stream.seek(0)
            if used_bytes(uid) + size > QUOTA:
                return err("Not enough space left. Delete some files or empty the trash.", 413)
            try:
                s3.upload_fileobj(f.stream, S3_BUCKET, s3_key(uid, stored))
            except (BotoCoreError, ClientError):
                app.logger.exception("S3 upload failed")
                return err("Couldn't save that file to storage. Please try again.", 502)
        else:
            dest = user_dir(uid) / stored
            f.save(dest)
            size = dest.stat().st_size
            if used_bytes(uid) + size > QUOTA:
                dest.unlink(missing_ok=True)
                return err("Not enough space left. Delete some files or empty the trash.", 413)
        now = time.time()
        mime = mimetypes.guess_type(name)[0] or f.mimetype or "application/octet-stream"
        new_id = insert(
            """INSERT INTO items (user_id, parent_id, name, size, mime, stored_name, created_at, updated_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (uid, parent_id, name, size, mime, stored, now, now))
        db().commit()
        created.append(serialize(get_item(new_id, uid)))
    return jsonify(items=created), 201


def send_stored(row, inline):
    mode = preview_mode(row)
    if USE_S3:
        if not row["stored_name"]:
            abort(404, description="The file is missing from storage.")
        if inline and mode:
            ctype = "text/plain" if mode == "text" else (
                mimetypes.guess_type(row["name"])[0] or "application/octet-stream")
            disposition = "inline"
        else:
            ctype = "application/octet-stream"
            disposition = "attachment; filename*=UTF-8''" + quote(row["name"], safe="")
        url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": S3_BUCKET, "Key": s3_key(row["user_id"], row["stored_name"]),
                    "ResponseContentType": ctype, "ResponseContentDisposition": disposition},
            ExpiresIn=60)
        return redirect(url)
    path = STORAGE / str(row["user_id"]) / (row["stored_name"] or "")
    if not path.is_file():
        abort(404, description="The file is missing from storage.")
    if inline and mode:
        mime = "text/plain" if mode == "text" else (mimetypes.guess_type(row["name"])[0] or "application/octet-stream")
        return send_file(path, mimetype=mime, conditional=True)
    return send_file(path, as_attachment=True, download_name=row["name"],
                     mimetype="application/octet-stream", conditional=True)


@app.get("/api/items/<int:iid>/file")
@login_required
def item_file(iid):
    row = get_item(iid, current_user()["id"])
    if row["is_folder"]:
        abort(400, description="Folders can't be downloaded yet.")
    return send_stored(row, request.args.get("inline") == "1")


@app.patch("/api/items/<int:iid>")
@login_required
def update_item(iid):
    uid = current_user()["id"]
    row = get_item(iid, uid)
    data = request.get_json(silent=True) or {}
    parent_id = row["parent_id"]
    name = row["name"]

    if "parent_id" in data:
        target = parse_id(data["parent_id"])
        get_folder(target, uid)
        if target is not None and target in {r["id"] for r in subtree(iid, uid)}:
            return err("A folder can't be moved into itself.")
        parent_id = target
    if "name" in data:
        name = clean_name(data["name"], row["name"])
    if "parent_id" in data or "name" in data:
        if (parent_id, name.lower()) != (row["parent_id"], row["name"].lower()) or "parent_id" in data:
            name = unique_name(uid, parent_id, name, bool(row["is_folder"]), exclude_id=iid)
        ex("UPDATE items SET parent_id = %s, name = %s, updated_at = %s WHERE id = %s",
           (parent_id, name, time.time(), iid))
    if "starred" in data:
        ex("UPDATE items SET starred = %s WHERE id = %s", (1 if data["starred"] else 0, iid))
    db().commit()
    return jsonify(item=serialize(get_item(iid, uid)))


@app.delete("/api/items/<int:iid>")
@login_required
def trash_item(iid):
    uid = current_user()["id"]
    get_item(iid, uid)
    ids = [r["id"] for r in subtree(iid, uid)]
    ex("UPDATE items SET deleted_at = %s WHERE id = ANY(%s) AND deleted_at IS NULL",
       (time.time(), ids))
    db().commit()
    return jsonify(ok=True)


@app.post("/api/items/<int:iid>/restore")
@login_required
def restore_item(iid):
    uid = current_user()["id"]
    row = get_item(iid, uid, include_deleted=True)
    if row["deleted_at"] is None:
        return jsonify(ok=True)
    stamp = row["deleted_at"]
    ids = [r["id"] for r in subtree(iid, uid)]
    ex("UPDATE items SET deleted_at = NULL WHERE id = ANY(%s) AND deleted_at = %s", (ids, stamp))
    parent = q1("SELECT * FROM items WHERE id = %s", (row["parent_id"],)) if row["parent_id"] else None
    parent_id = row["parent_id"] if parent and parent["deleted_at"] is None else None
    name = unique_name(uid, parent_id, row["name"], bool(row["is_folder"]), exclude_id=iid)
    ex("UPDATE items SET parent_id = %s, name = %s WHERE id = %s", (parent_id, name, iid))
    db().commit()
    return jsonify(ok=True)


def purge(iid, uid):
    rows = subtree(iid, uid)
    remove_files(rows)
    ex("DELETE FROM items WHERE id = %s AND user_id = %s", (iid, uid))
    db().commit()


@app.delete("/api/items/<int:iid>/purge")
@login_required
def purge_item(iid):
    uid = current_user()["id"]
    row = get_item(iid, uid, include_deleted=True)
    if row["deleted_at"] is None:
        return err("Move it to the trash first.")
    purge(iid, uid)
    return jsonify(ok=True)


@app.post("/api/trash/empty")
@login_required
def empty_trash():
    uid = current_user()["id"]
    tops = q("""SELECT i.id FROM items i LEFT JOIN items p ON p.id = i.parent_id
                WHERE i.user_id = %s AND i.deleted_at IS NOT NULL
                  AND (p.id IS NULL OR p.deleted_at IS NULL OR p.deleted_at <> i.deleted_at)""", (uid,))
    for r in tops:
        purge(r["id"], uid)
    return jsonify(ok=True)


@app.post("/api/items/<int:iid>/share")
@login_required
def share_item(iid):
    uid = current_user()["id"]
    row = get_item(iid, uid)
    if row["is_folder"]:
        return err("Only files can be shared with a link.")
    enabled = bool((request.get_json(silent=True) or {}).get("enabled", True))
    token = (row["share_token"] or secrets.token_urlsafe(16)) if enabled else None
    ex("UPDATE items SET share_token = %s WHERE id = %s", (token, iid))
    db().commit()
    return jsonify(url=url_for("shared", token=token, _external=True) if token else None,
                   item=serialize(get_item(iid, uid)))


@app.get("/api/items/<int:iid>/share")
@login_required
def share_link(iid):
    row = get_item(iid, current_user()["id"])
    token = row["share_token"]
    return jsonify(url=url_for("shared", token=token, _external=True) if token else None)


# --------------------------------------------------------------------------
# Public share pages
# --------------------------------------------------------------------------
def shared_row(token):
    row = q1("SELECT * FROM items WHERE share_token = %s AND deleted_at IS NULL", (token,))
    if row is None:
        abort(404, description="This link is no longer active.")
    return row


@app.get("/s/<token>")
def shared(token):
    row = shared_row(token)
    owner = q1("SELECT name FROM users WHERE id = %s", (row["user_id"],))
    return render_template("share.html", item=serialize(row), owner=owner["name"], token=token)


@app.get("/s/<token>/file")
def shared_file(token):
    return send_stored(shared_row(token), request.args.get("inline") == "1")


init_db()

if __name__ == "__main__":
    app.run(host=os.environ.get("KUMO_HOST", "127.0.0.1"),
            port=int(os.environ.get("KUMO_PORT", 5000)),
            debug=os.environ.get("KUMO_DEBUG") == "1")