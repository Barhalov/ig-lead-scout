from __future__ import annotations

import re


NON_WORD = re.compile(r"[^a-zа-яё0-9_]+", re.IGNORECASE)
CYRILLIC = re.compile(r"[а-яё]", re.IGNORECASE)
UKRAINIAN_LETTERS = frozenset("іїєґ")
UKRAINIAN_MARKERS = (
    "україн", "київ", "львів", "харків", "одес", "дніпр", "запоріж",
    "працюю", "навчаю", "допомагаю", "підготов", "викладач",
    "харчуван", "схуднен", "здоров я",
)
UKRAINE_GEOGRAPHY_RU = (
    "украин", "киев", "львов", "харьков", "одесс", "днепр", "запорож",
)
EXCLUDED_GEOGRAPHY = (
    "бишкек", "bishkek", "кыргызстан", "кыргыз", "киргизия", "kyrgyzstan",
    "ош кыргызстан", "ош кыргыз", "osh kyrgyzstan", "osh kg",
    "жалал абад", "джалал абад", "jalal abad", "каракол кыргыз", "karakol kyrgyz",
    "астана", "astana", "нур султан", "нурсултан", "алматы", "almaty",
    "казахстан", "казах", "kazakhstan", "шымкент", "караганда", "актобе",
    "костанай", "павлодар", "петропавловск", "кызылорда", "оскемен",
    "узбекистан", "узбек", "uzbekistan", "ташкент", "tashkent", "toshkent",
    "самарканд", "samarkand", "бухара", "bukhara", "андижан", "andijan",
    "наманган", "namangan", "фергана", "fergana", "нукус", "nukus",
)


PRESETS: tuple[tuple[tuple[str, ...], tuple[str, ...]], ...] = (
    (("йога", "йог", "yoga"), ("йога", "йоге", "йоги", "йог", "инструктор йоги", "преподаватель йоги", "yoga")),
    (("фитнес", "тренер"), ("фитнес", "тренер", "трениров", "fitness", "coach", "gym")),
    (("репетитор",), ("репетитор", "преподават", "учител", "подготовка к егэ", "подготовка к огэ")),
    (("биохакер", "биохакинг"), ("биохак", "биохакинг")),
    (("юрист", "адвокат"), ("юрист", "адвокат", "правовая", "юридическ", "lawyer")),
    (("недвижим", "риелтор", "риэлтор"), ("недвижим", "риелтор", "риэлтор", "агент по недвиж", "брокер по недвиж", "realtor", "real estate")),
    (("нутрициолог", "диетолог"), ("нутрициолог", "диетолог", "нутрици", "nutrition")),
    (("косметолог",), ("косметолог", "косметологи", "эстетист", "beautician")),
)


def normalize(value: str) -> str:
    return " ".join(NON_WORD.sub(" ", value.casefold().replace("ё", "е")).split())


def looks_russian(value: str) -> bool:
    """Accept Russian-language text while rejecting clear Ukrainian signals."""
    raw = str(value or "").casefold().replace("ё", "е")
    if not CYRILLIC.search(raw):
        return False
    if "🇺🇦" in raw or any(letter in raw for letter in UKRAINIAN_LETTERS):
        return False
    clean = normalize(raw)
    if any(marker in clean for marker in (*UKRAINIAN_MARKERS, *UKRAINE_GEOGRAPHY_RU)):
        return False
    return True


def excluded_geography(value: str) -> bool:
    """Reject explicit non-Russian Central Asian locations in Russian profiles."""
    raw = str(value or "").casefold().replace("ё", "е")
    clean = normalize(raw)
    return any(flag in raw for flag in ("🇰🇬", "🇰🇿", "🇺🇿")) or any(
        marker in clean for marker in EXCLUDED_GEOGRAPHY
    )


def keywords(niche: str) -> tuple[str, ...]:
    cleaned = normalize(niche)
    for aliases, words in PRESETS:
        if any(alias in cleaned for alias in aliases):
            return words
    tokens = tuple(token for token in cleaned.split() if len(token) >= 4)
    return tokens or (cleaned,)


def matches(text: str, niche: str) -> bool:
    haystack = normalize(text)
    cleaned_niche = normalize(niche)
    if any(marker in cleaned_niche for marker in ("йог", "yoga")):
        has_yoga = any(marker in haystack for marker in ("йог", "yoga"))
        has_teacher = any(
            marker in haystack
            for marker in (
                "тренер", "инструктор", "преподават", "учител", "наставник",
                "обучаю", "практик", "coach", "teacher",
            )
        )
        return has_yoga and has_teacher
    if "фитнес" in cleaned_niche or "fitness" in cleaned_niche:
        has_fitness = any(
            marker in haystack
            for marker in (
                "фитнес", "fitness", "gym", "трениров", "workout",
                # Real fitness coaches often describe the result instead of
                # repeating the word "фитнес" in their bio.
                "тело", "форму", "форма", "мышеч", "питани",
                "похуд", "сушк", "набор массы", "здоровый образ жизни",
            )
        )
        has_trainer = any(
            marker in haystack
            for marker in ("тренер", "coach", "инструктор", "персональн")
        )
        return has_fitness and has_trainer
    if "репетитор" in cleaned_niche:
        misleading = (
            "репетитор твоего тела",
            "репетитор по тяжелой атлетике",
        )
        if any(marker in haystack for marker in misleading):
            return False
        return any(
            marker in haystack
            for marker in (
                "репетитор", "преподават", "учител",
                "подготовка к егэ", "подготовка к огэ",
            )
        )
    return any(word in haystack for word in keywords(niche) if word)


def search_terms(niche: str) -> tuple[str, ...]:
    cleaned = normalize(niche)
    if any(marker in cleaned for marker in ("йог", "yoga")):
        return ("йога",)
    words = keywords(niche)
    terms = [cleaned]
    terms.extend(word for word in words if re.fullmatch(r"[а-я ]+", word) and len(word) >= 5)
    return tuple(dict.fromkeys(term.strip() for term in terms if term.strip()))


def query_variants(niche: str) -> tuple[str, ...]:
    # Use the same canonical phrase in Instagram's global search and inside
    # the donor's followers/following dialogs. Rotating through broad words
    # such as "тренер" produced unrelated candidates.
    return (search_terms(niche)[0],)
