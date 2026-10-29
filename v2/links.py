from __future__ import annotations

import html
import re
from urllib.parse import parse_qs, unquote, urlparse


TELEGRAM_HOSTS = {"t.me", "www.t.me", "telegram.me", "www.telegram.me", "telegram.dog"}
RESERVED_PATHS = {
    "addemoji", "addlist", "addstickers", "addtheme", "assets", "auth", "boost", "call",
    "confirmphone", "contact", "giftcode", "invoice", "joinchat", "login", "m",
    "partners", "proxy", "setlanguage", "share", "signup", "socks", "web",
}
USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{5,32}$")
URL_RE = re.compile(
    r"(?i)(?:(?:https?://)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)/[^\s<>\]\[\"']+)"
)
MENTION_RE = re.compile(
    r"(?i)(?:telegram|телеграм|tg|тг)\s*(?:[:=\-–—]|—>)?\s*@([a-z0-9_]{5,32})"
)
def unwrap_instagram_redirect(value: str) -> str:
    value = html.unescape(value.strip())
    try:
        parsed = urlparse(value)
        hostname = parsed.hostname
    except (TypeError, ValueError):
        return value
    if hostname and hostname.lower() == "l.instagram.com":
        target = parse_qs(parsed.query).get("u", [""])[0]
        if target:
            return unquote(target)
    return value


def normalize_telegram_url(value: str) -> str | None:
    raw = unwrap_instagram_redirect(value).strip().rstrip(".,;:!?)\"'")
    if raw.lower().startswith("tg://resolve"):
        domain = parse_qs(urlparse(raw).query).get("domain", [""])[0].lstrip("@")
        return f"https://t.me/{domain}" if USERNAME_RE.fullmatch(domain) else None
    if not re.match(r"(?i)^https?://", raw):
        raw = "https://" + raw.lstrip("/")
    try:
        parsed = urlparse(raw)
        host = (parsed.hostname or "").lower()
    except (TypeError, ValueError):
        return None
    if host not in TELEGRAM_HOSTS:
        return None
    parts = [unquote(part) for part in parsed.path.split("/") if part]
    if not parts:
        return None
    first = parts[0].lstrip("@").strip()
    if first.lower() in RESERVED_PATHS:
        if first.lower() == "joinchat" and len(parts) > 1:
            return f"https://t.me/joinchat/{parts[1]}"
        return None
    if first.startswith("+"):
        token = re.sub(r"[^A-Za-z0-9_+\-]", "", first)
        return f"https://t.me/{token}" if len(token) >= 6 else None
    if not USERNAME_RE.fullmatch(first):
        return None
    if len(parts) > 1 and not all(part.isdecimal() for part in parts[1:]):
        return None
    path = "/".join([first, *parts[1:]])
    return f"https://t.me/{path}"


def extract_telegram_links(texts: list[str] | tuple[str, ...]) -> list[str]:
    found: dict[str, str] = {}
    for source in texts:
        source = html.unescape(str(source or ""))
        direct = normalize_telegram_url(source)
        if direct:
            found.setdefault(direct.casefold(), direct)
        for match in URL_RE.finditer(source):
            normalized = normalize_telegram_url(match.group(0))
            if normalized:
                found.setdefault(normalized.casefold(), normalized)
        for match in MENTION_RE.finditer(source):
            normalized = f"https://t.me/{match.group(1)}"
            found.setdefault(normalized.casefold(), normalized)
    return list(found.values())


def profile_telegram_links(
    biography: str,
    outgoing_urls: list[str] | tuple[str, ...],
) -> list[str]:
    """Extract Telegram contacts shown directly by an Instagram profile.

    Biography is free text, so Telegram URLs and labelled mentions may appear
    inside it. Outgoing links are deliberately stricter: the whole link must be
    Telegram itself, or an Instagram redirect whose immediate target is
    Telegram. Arbitrary landing pages and URLs merely containing a nested t.me
    value are ignored and are never fetched.
    """
    # The clickable target is more authoritative than its rendered label.
    # Instagram can keep an old/custom label in the header after the owner has
    # changed the underlying URL. Returning both values would leave the stale
    # address available to outreach, so direct Telegram hrefs replace any
    # Telegram-looking text rendered alongside them.
    direct: list[str] = []
    direct_seen: set[str] = set()
    for outgoing in outgoing_urls:
        normalized = normalize_telegram_url(str(outgoing or ""))
        if normalized and normalized.casefold() not in direct_seen:
            direct.append(normalized)
            direct_seen.add(normalized.casefold())
    if direct:
        return direct
    return extract_telegram_links([biography])


def telegram_button_url(url: str) -> str:
    """Use Telegram's documented profile flag for public usernames.

    It avoids the Desktop client silently failing while trying to create a chat
    with an unknown peer. Invite and message links keep their original meaning.
    """
    normalized = normalize_telegram_url(url) or url
    try:
        parsed = urlparse(normalized)
    except (TypeError, ValueError):
        return normalized
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) == 1 and USERNAME_RE.fullmatch(parts[0]):
        return f"https://t.me/{parts[0]}?profile"
    return normalized


def telegram_copy_text(url: str) -> str:
    """Return the most convenient text for a Telegram clipboard button."""
    normalized = normalize_telegram_url(url) or url
    try:
        parsed = urlparse(normalized)
    except (TypeError, ValueError):
        return normalized
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) == 1 and USERNAME_RE.fullmatch(parts[0]):
        return f"@{parts[0]}"
    return normalized


def links_from_landing_page(url: str, timeout: float = 8.0) -> list[str]:
    """Backward-compatible direct-link check; it never fetches ``url``."""
    del timeout
    normalized = normalize_telegram_url(url)
    return [normalized] if normalized else []
