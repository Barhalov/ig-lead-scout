from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Profile:
    username: str
    full_name: str
    url: str
    biography: str
    followers: int | None
    is_private: bool
    outgoing_urls: tuple[str, ...] = ()


@dataclass(frozen=True)
class Lead:
    username: str
    full_name: str
    instagram_url: str
    followers: int | None
    telegram_urls: tuple[str, ...]


@dataclass
class CycleStats:
    discovered: int = 0
    checked: int = 0
    added: int = 0
    duplicate: int = 0
    wrong_niche: int = 0
    wrong_language: int = 0
    too_small: int = 0
    no_telegram: int = 0
    unreadable: int = 0
    failed: int = 0
    notes: list[str] = field(default_factory=list)
