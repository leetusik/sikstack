"""Sections: every current document split at its headings, the unit of search and fetch.

A section is a heading of level 2 or 3 with everything after it up to the next such
heading, plus a **lead** section for the text before the first one. The rows live in
``document_sections`` (``server/db.py``), derived like the rest of the SQLite store:
``db.upsert_document`` re-splits a document on every write, a new version and every
reindex, so a rebuild reproduces them from the files alone.

**Anchors** are what the reader lands on (``#<anchor>``):

* ``native``: the heading ids the native parse writes into the stored source on first
  parse (``server/native/parse.py``). They are kept across versions and shared by
  translations, so an unchanged section keeps its anchor on v2. The split reads only
  headings: an id'd code fence or typed block never starts a section. A section's text
  is ``project._search_block`` of each of its blocks, so a section made only of typed
  blocks (a diagram, a quiz) still has search text, and the sections together hold the
  document's whole search projection.
* ``md``: the id the reader gives a loose Markdown heading (``web/src/lib/reader/load.ts``
  ``idMarkdownHeadings``): every top-level h2-h4 with text takes ``heading_slug`` of its
  plain text through one ``IdRegistry``, ``s-<n>`` when it has no ASCII slug.
* ``html``: a heading's own ``id`` attribute, else the same slug rule.

The lead section's anchor is ``""`` (the reader's top) and its heading the document's
title; it exists only when it has text. A document with no heading is one lead section.

**Embeddings** are cached by content (``section_embeddings``), keyed by the sha256 of the
composed text (``composed``) and the model, never by a row id, so a reindex that
renumbers every row re-embeds nothing unchanged and an edited section re-embeds alone.
No key: nothing is embedded and search stays keyword-only.
"""
from __future__ import annotations

import datetime
import hashlib
import logging
import re
import sqlite3
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Any, Optional
from uuid import UUID

from markdown_it import MarkdownIt

from server import config, embeddings
from server.native.ids import IdRegistry, heading_slug

logger = logging.getLogger(__name__)

SPLIT_LEVELS = (2, 3)
LEAD = ""


@dataclass(frozen=True, slots=True)
class Section:
    anchor: str
    heading: str
    level: int  # 0 for the lead section
    position: int
    text: str


# -- the split ---------------------------------------------------------------------------


def split(
    *,
    format: str,
    title: str,
    markdown: Optional[str],
    source: Optional[str] = None,
    raw_html: Optional[str] = None,
) -> list[Section]:
    """A document's sections in order. Never raises: a body that cannot be split is one
    lead section of its readable text."""

    try:
        if format == "native" and source:
            parts = _split_native(source)
        elif format == "html" and raw_html:
            parts = _split_html(raw_html)
        else:
            parts = _split_markdown(markdown or "")
    except Exception:  # noqa: BLE001 - a split must never fail a write
        logger.warning("section split failed; one whole-document section", exc_info=True)
        parts = [(LEAD, "", 0, markdown or "")]
    out: list[Section] = []
    for anchor, heading, level, text in parts:
        text = text.strip("\n")
        if anchor == LEAD:
            if not text.strip():
                continue
            heading = title
        out.append(Section(anchor, heading, level, len(out), text))
    return out


def _split_native(source: str) -> list[tuple[str, str, int, str]]:
    from server.native.parse import parse_chapter
    from server.native.project import _search_block, inline_text

    tree = parse_chapter(source).tree
    lead: list[str] = [tree["summary"]] if tree.get("summary") else []
    out: list[tuple[str, str, int, list[str]]] = [(LEAD, "", 0, lead)]
    for block in tree["blocks"]:
        if block["type"] == "heading" and block["level"] in SPLIT_LEVELS and block.get("id"):
            out.append((block["id"], inline_text(block["content"]), block["level"], []))
            continue  # the heading is the section's heading, not its text
        out[-1][3].extend(p for p in _search_block(block) if p)
    return [(a, h, lv, "\n".join(parts)) for a, h, lv, parts in out]


def _md_parser() -> MarkdownIt:
    md = MarkdownIt("commonmark", {"html": True})
    md.enable(["table", "strikethrough"])
    return md


def _inline_plain(token) -> str:
    out = []
    for child in token.children or []:
        if child.type in ("text", "code_inline"):
            out.append(child.content)
        elif child.type in ("softbreak", "hardbreak"):
            out.append("\n")
    return "".join(out)


def _split_markdown(body: str) -> list[tuple[str, str, int, str]]:
    lines = body.split("\n")
    tokens = _md_parser().parse(body)
    ids = IdRegistry()
    cuts: list[tuple[int, int, str, str, int]] = []  # (start line, end line, anchor, heading, level)
    for i, tok in enumerate(tokens):
        if tok.type != "heading_open" or tok.level != 0 or not tok.map:
            continue
        level = int(tok.tag[1])
        if level not in (2, 3, 4):
            continue
        text = _inline_plain(tokens[i + 1])
        if not text.strip():
            continue
        slug = heading_slug(text)
        anchor = ids.assign_slug(slug) if slug else ids.assign_numbered("s")
        if level in SPLIT_LEVELS:
            cuts.append((tok.map[0], tok.map[1], anchor, text, level))
    out: list[tuple[str, str, int, str]] = []
    first = cuts[0][0] if cuts else len(lines)
    out.append((LEAD, "", 0, "\n".join(lines[:first])))
    for n, (start, end, anchor, heading, level) in enumerate(cuts):
        stop = cuts[n + 1][0] if n + 1 < len(cuts) else len(lines)
        out.append((anchor, heading, level, "\n".join(lines[end:stop])))
    return out


class _HtmlSections(HTMLParser):
    """Text split at ``h2``/``h3`` (script, style and template text dropped)."""

    _SKIP = {"script", "style", "template", "noscript"}
    _BLOCK = {"p", "div", "li", "tr", "br", "section", "article", "pre", "blockquote",
              "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol", "figure", "figcaption"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ids = IdRegistry()
        self.parts: list[list[Any]] = [[LEAD, "", 0, []]]
        self.skip = 0
        self.heading: Optional[list[Any]] = None  # [level, id attr, text parts]

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self.skip += 1
        elif tag in ("h2", "h3") and self.heading is None:
            self.heading = [int(tag[1]), dict(attrs).get("id"), []]
        elif tag in self._BLOCK:
            self._text("\n")

    def handle_endtag(self, tag):
        if tag in self._SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in ("h2", "h3") and self.heading is not None and int(tag[1]) == self.heading[0]:
            level, raw_id, texts = self.heading
            self.heading = None
            text = " ".join("".join(texts).split())
            if not text:
                return
            if raw_id and raw_id not in self.ids:
                self.ids.claim(raw_id)
                anchor = raw_id
            else:
                slug = heading_slug(text)
                anchor = self.ids.assign_slug(slug) if slug else self.ids.assign_numbered("s")
            self.parts.append([anchor, text, level, []])
        elif tag in self._BLOCK:
            self._text("\n")

    def handle_data(self, data):
        if self.skip:
            return
        if self.heading is not None:
            self.heading[2].append(data)
        else:
            self._text(data)

    def _text(self, data: str) -> None:
        self.parts[-1][3].append(data)


def _split_html(raw_html: str) -> list[tuple[str, str, int, str]]:
    parser = _HtmlSections()
    parser.feed(raw_html)
    parser.close()
    out = []
    for anchor, heading, level, texts in parser.parts:
        joined = "".join(texts)
        lines = [" ".join(line.split()) for line in joined.split("\n")]
        out.append((anchor, heading, level, "\n".join(line for line in lines if line)))
    return out


# -- the rows ----------------------------------------------------------------------------


def composed(title: str, heading: str, text: str) -> str:
    """The exact text a section embeds: the document title, its heading, then its text,
    truncated like a document's (``embeddings.MAX_INPUT_CHARS``)."""

    head = (title or "").strip()
    sub = (heading or "").strip()
    if sub and sub != head:
        head = f"{head} — {sub}" if head else sub
    return embeddings.document_input(head, text)


def content_hash(title: str, heading: str, text: str) -> str:
    """sha256 of ``composed``: with the model, the section's embedding key."""

    return hashlib.sha256(composed(title, heading, text).encode("utf-8")).hexdigest()


def replace_for_document(
    conn: sqlite3.Connection,
    doc_id: int,
    *,
    format: str,
    title: str,
    markdown: Optional[str],
    source: Optional[str] = None,
    raw_html: Optional[str] = None,
) -> int:
    """Replace one document's section rows from its current body. Not committed here (the
    caller's upsert commits). Returns the number of sections."""

    secs = split(format=format, title=title, markdown=markdown, source=source, raw_html=raw_html)
    conn.execute("DELETE FROM document_sections WHERE doc_id = ?", (doc_id,))
    conn.executemany(
        "INSERT INTO document_sections "
        "(doc_id, anchor, heading, level, position, title, text, content_hash) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (doc_id, s.anchor, s.heading, s.level, s.position, title, s.text,
             content_hash(title, s.heading, s.text))
            for s in secs
        ],
    )
    return len(secs)


def list_sections(conn: sqlite3.Connection, doc_id: int) -> list[dict[str, Any]]:
    """A document's sections in order, ``{anchor, heading, level, position, text}``."""

    rows = conn.execute(
        "SELECT anchor, heading, level, position, text FROM document_sections "
        "WHERE doc_id = ? ORDER BY position",
        (doc_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_section(conn: sqlite3.Connection, doc_id: int, anchor: str) -> Optional[dict[str, Any]]:
    """One section of a document by anchor (``""`` is the lead), or ``None``."""

    row = conn.execute(
        "SELECT anchor, heading, level, position, text FROM document_sections "
        "WHERE doc_id = ? AND anchor = ? ORDER BY position LIMIT 1",
        (doc_id, anchor),
    ).fetchone()
    return dict(row) if row is not None else None


def count(conn: sqlite3.Connection) -> int:
    return int(conn.execute("SELECT COUNT(*) AS n FROM document_sections").fetchone()["n"])


# -- embeddings --------------------------------------------------------------------------


def _now() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def sync_embeddings(
    conn: sqlite3.Connection,
    *,
    doc_id: Optional[int] = None,
    retries: int = 0,
    collect: bool = False,
) -> dict[str, Any]:
    """Embed every section (of one document, or all) whose content has no vector yet.

    Each distinct content is embedded once and stored as it succeeds, so a failure keeps
    the progress. ``collect`` (a full reindex) also drops vectors no section holds any
    more and those of another model. No key: nothing is embedded.
    Report: ``{embedded, cached, removed, skipped_reason?}``.
    """

    if not config.embeddings_enabled():
        return {"embedded": 0, "cached": 0, "removed": 0, "skipped_reason": "no api key"}
    model = config.embedding_model()
    sql = (
        "SELECT s.content_hash, s.title, s.heading, s.text, e.content_hash AS have "
        "FROM document_sections s LEFT JOIN section_embeddings e "
        "ON e.content_hash = s.content_hash AND e.model = ?"
    )
    params: list[Any] = [model]
    if doc_id is not None:
        sql += " WHERE s.doc_id = ?"
        params.append(doc_id)
    todo: dict[str, str] = {}
    cached: set[str] = set()
    for row in conn.execute(sql, params).fetchall():
        if row["have"] is not None:
            cached.add(row["content_hash"])
        else:
            todo.setdefault(row["content_hash"], composed(row["title"], row["heading"], row["text"]))
    embedded = failed = 0
    for h, text in todo.items():
        try:
            vec = embeddings.embed_texts([text], kind="document", retries=retries)[0]
        except embeddings.EmbeddingError:
            failed += 1
            continue
        conn.execute(
            "INSERT INTO section_embeddings (content_hash, model, dims, vector, updated_at) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT(content_hash, model) DO UPDATE SET "
            "dims = excluded.dims, vector = excluded.vector, updated_at = excluded.updated_at",
            (h, model, len(vec), sqlite3.Binary(embeddings.pack_vector(vec)), _now()),
        )
        conn.commit()
        embedded += 1
    removed = 0
    if collect:
        cur = conn.execute(
            "DELETE FROM section_embeddings WHERE model != ? OR content_hash NOT IN "
            "(SELECT content_hash FROM document_sections)",
            (model,),
        )
        conn.commit()
        removed = cur.rowcount
    report: dict[str, Any] = {"embedded": embedded, "cached": len(cached), "removed": removed}
    if failed:
        report["skipped_reason"] = f"{failed} of {len(todo)} section embeds failed (rate limit / API)"
    return report


# -- who is reading ----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Viewer:
    """Who a section search answers, and how its reader URLs are built.

    ``member`` reads every item of the tenant searched (a key of the org, or a member).
    Anyone else reads only the items in ``public``, ``(project, kind, key)`` triples
    (``server.sharing``: a document's stem or a book's slug); a Link item is never in it,
    so a link item never appears in anyone else's search. ``org`` is the org's slug, the
    one way a loose document's pretty path names its org (``/@{slug}/{project}/{slug}``);
    ``org_label`` is its slug or, for an org with none, its tenant id, which a book's
    chapter path also takes. A document of an org with no slug (and legacy mode) is
    addressed by id (``/documents/{id}``).
    """

    member: bool
    org: Optional[str] = None
    public: frozenset = field(default_factory=frozenset)
    org_label: Optional[str] = None

    def may_read(self, project: str, kind: str, key: str) -> bool:
        return self.member or (project, kind, key) in self.public


async def viewer_for(tenant_id: UUID, *, member: bool) -> Viewer:
    """The ``Viewer`` for a search of ``tenant_id``'s library (the in-process door).

    A member's viewer reads everything; anyone else's holds the org's Public items only.
    Every failure reads as nothing public (fail closed).
    """

    from server import sharing
    from server.accounts.service import get_accounts_service
    from server.reader_state import org_label

    org: Optional[str] = None
    label: Optional[str] = None
    public: set[tuple[str, str, str]] = set()
    try:
        service = get_accounts_service()
        tenant = await service.get_tenant(tenant_id)
        if tenant is not None:
            org, label = tenant.slug or None, org_label(tenant)
        if not member:
            registry = await service.list_projects_for_tenant(tenant_id)
            names = {p.id: p.name for p in registry}
            shares = await sharing.get_shares(names.keys())
            for (pid, kind, key), share in shares.items():
                if share.state == sharing.PUBLIC and pid in names:
                    public.add((names[pid], kind, key))
    except Exception:  # noqa: BLE001 - fail closed: nothing public
        logger.warning("section viewer could not read sharing; nothing public", exc_info=True)
        public = set()
    return Viewer(member=member, org=org, public=frozenset(public), org_label=label)


def reader_url(
    viewer: Viewer,
    *,
    doc_id: int,
    project: str,
    slug: str,
    anchor: str,
    book: Optional[str] = None,
    chapter_key: Optional[str] = None,
    lang: Optional[str] = None,
) -> str:
    """The reader address that lands on a section: ``…#<anchor>`` (the lead: the top)."""

    base = config.public_base_url()
    label = viewer.org_label or viewer.org
    if book and chapter_key and label:
        path = f"/@{label}/{project}/books/{book}/{chapter_key}"
        if lang and lang != "en":
            path += f"?lang={lang}"
    elif viewer.org:
        path = f"/@{viewer.org}/{project}/{slug}"
    else:
        path = f"/documents/{doc_id}"
    return f"{base}{path}" + (f"#{anchor}" if anchor else "")


def item_key(project: str, rel_path: str, book: Optional[str]) -> tuple[str, str]:
    """``(kind, key)`` whose sharing gates a section's document (``sharing.item_of_doc``)."""

    from server.reader_state import doc_of

    if book:
        return "book", book
    return "doc", doc_of(project, rel_path)


_WS = re.compile(r"\s+")


def excerpt(text: str, chars: int = 240) -> str:
    flat = _WS.sub(" ", (text or "").strip())
    return flat[:chars] + ("…" if len(flat) > chars else "")

