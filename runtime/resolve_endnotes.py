#!/usr/bin/env python3
"""Automatically resolve endnotes page boundaries for books with book_end_notes."""

import argparse
import json
import re
from collections import Counter
from pathlib import Path

try:
    import pymupdf as fitz
except ImportError:
    import fitz


NOTES_RE = re.compile(r'(?i)(?:^|\b)(?:notes?|anmerkungen|endnotes?|annotations?|注释)(?:\b|$)')

_WORD_NUMS = {
    'one': '1', 'first': '1', 'two': '2', 'second': '2', 'three': '3', 'third': '3',
    'four': '4', 'fourth': '4', 'five': '5', 'fifth': '5', 'six': '6', 'sixth': '6',
    'seven': '7', 'seventh': '7', 'eight': '8', 'eighth': '8', 'nine': '9', 'ninth': '9',
    'ten': '10', 'tenth': '10', 'eleven': '11', 'eleventh': '11', 'twelve': '12', 'twelfth': '12',
    'thirteen': '13', 'thirteenth': '13', 'fourteen': '14', 'fourteenth': '14',
    'fifteen': '15', 'fifteenth': '15', 'sixteen': '16', 'sixteenth': '16',
    'seventeen': '17', 'seventeenth': '17', 'eighteen': '18', 'eighteenth': '18',
    'nineteen': '19', 'nineteenth': '19', 'twenty': '20', 'twentieth': '20',
}
_ROMAN_NUMS = {
    'i': '1', 'ii': '2', 'iii': '3', 'iv': '4', 'v': '5', 'vi': '6', 'vii': '7',
    'viii': '8', 'ix': '9', 'x': '10', 'xi': '11', 'xii': '12', 'xiii': '13',
    'xiv': '14', 'xv': '15', 'xvi': '16', 'xvii': '17', 'xviii': '18', 'xix': '19', 'xx': '20',
}
_STOPWORDS = {
    'the', 'and', 'for', 'with', 'from', 'into', 'towards', 'toward', 'about',
    'upon', 'over', 'under', 'between', 'through', 'chapter', 'part', 'section',
    'der', 'die', 'das', 'und', 'des', 'dem', 'den', 'von', 'zur', 'zum',
    'les', 'des', 'dans', 'pour', 'sur', 'avec', 'une',
}
_STRUCTURAL_HEAD_RE = re.compile(
    r'^(?:'
    r'(?:introduction|preface|prologue|foreword|epilogue|conclusion|afterword|postscript|einleitung|vorwort|nachwort)(?:\s*[:\-–—].*)?|'
    r'(?:chapter|chapitre|kapitel|part|book|section|appendix)\s+(?:[0-9]{1,2}|[ivxlcdm]{1,6}|'
    + '|'.join(_WORD_NUMS.keys())
    + r')(?:\b[\s:\-–—.].*)?|'
    r'第\s*[一二三四五六七八九十百零0-9]+\s*[章节篇部卷].*'
    r')$',
    re.IGNORECASE,
)


def clean_text(text):
    return re.sub(r'[^a-z0-9\u4e00-\u9fff]', '', str(text or '').lower())


def _extract_structural_tag(text):
    s = re.sub(r'\s+', ' ', str(text or '').strip())
    m = re.match(
        r'^(introduction|preface|prologue|foreword|epilogue|conclusion|afterword|postscript|einleitung|vorwort|nachwort)\b',
        s, re.IGNORECASE,
    )
    if m:
        return ('front_back', m.group(1).lower())
    m = re.match(
        r'^(chapter|chapitre|kapitel|part|book|section|appendix)\s+([a-z0-9]+)\b',
        s, re.IGNORECASE,
    )
    if m:
        kind = m.group(1).lower()
        if kind in {'chapitre', 'kapitel'}:
            kind = 'chapter'
        tok = m.group(2).lower()
        num = tok if tok.isdigit() else (_WORD_NUMS.get(tok) or _ROMAN_NUMS.get(tok))
        if num:
            return (kind, num)
    m = re.match(r'^([ivxlcdm]{1,6})\b', s, re.IGNORECASE)
    if m and (re.fullmatch(r'[ivxlcdm]{1,6}\.?', s, re.IGNORECASE) or re.match(r'^[IVXLCDM]{1,6}[\s.:—\-]+[A-Z]', s)):
        num = _ROMAN_NUMS.get(m.group(1).lower())
        if num:
            return ('roman_chapter', num)
    return None


def _tokens(text):
    words = re.findall(r'[a-z0-9]{3,}|[\u4e00-\u9fff]{2,}', str(text or '').lower())
    return {w for w in words if w not in _STOPWORDS and w not in _WORD_NUMS}


def _is_noise_line(raw, running_heads):
    s = raw.strip()
    if not s or len(s) > 90:
        return True
    if s.upper() in {'NOTES', 'ENDNOTES', 'ANMERKUNGEN'} or clean_text(s) in running_heads:
        return True
    if re.search(r'(?i)notes to pages|\b\d+\s+[YZ]\s+|\b[YZ]\s+\d+', s):
        return True
    # Numbered note definitions ("1. ...", "24. Ibid.") or page numbers
    if re.match(r'^\s*\d+\s*[.,)\]]', s) or re.match(r'^\s*\d+\s*$', s):
        return True
    # Prose fragments ending in sentence/clause punctuation or citation markers
    if re.search(r'[,;?!)\]"\']\s*$', s) or re.search(r'\bpp?\.\s*\d|\b\d{4}\b', s):
        return True
    if s.endswith('.') and not _STRUCTURAL_HEAD_RE.match(s):
        return True
    return False


def _match_score(h_raw, bc_title):
    h_tag = _extract_structural_tag(h_raw)
    bc_tag = _extract_structural_tag(bc_title)
    if h_tag and bc_tag:
        if h_tag == bc_tag:
            return 100
        if h_tag[0] == bc_tag[0] and h_tag[1] != bc_tag[1]:
            return 0
    h_c = clean_text(h_raw)
    bc_c = clean_text(bc_title)
    if not h_c or not bc_c:
        return 0
    if h_c == bc_c:
        return 95
    if len(h_c) >= 6 and (h_c in bc_c or bc_c in h_c):
        # Guard against e.g. "introduction" matching a prose line containing "Introduction"
        if h_tag and not bc_tag and h_tag[0] == 'front_back' and not bc_c.startswith(h_c):
            return 0
        return 80 + min(len(h_c), 14)
    h_toks = _tokens(h_raw)
    bc_toks = _tokens(bc_title)
    if h_toks and bc_toks:
        common = h_toks & bc_toks
        if len(common) >= 2 or (len(common) == 1 and len(h_toks) == 1 and next(iter(common)) not in {'self', 'time', 'being', 'work', 'life'}):
            return 50 + 10 * len(common)
    return 0


def resolve_endnotes(pdf_path, chapters):
    doc = fitz.open(pdf_path)
    notes_ch = next(
        (c for c in chapters if c.get('role_hint') in {'notes', 'endnotes'} or NOTES_RE.search(c.get('title', ''))),
        None,
    )
    if not notes_ch:
        return chapters

    ns = notes_ch.get('start_page')
    ne = notes_ch.get('end_page')
    if not (isinstance(ns, int) and isinstance(ne, int) and 1 <= ns <= ne <= len(doc)):
        return chapters

    sizes = Counter()
    header_Counter = Counter()
    page_lines = {}
    for pno in range(ns, ne + 1):
        page = doc[pno - 1]
        h = page.rect.height or 1.0
        lines_on_page = []
        for b in page.get_text('dict').get('blocks', []):
            for l in b.get('lines', []):
                spans = [s for s in l.get('spans', []) if s.get('text', '').strip()]
                if not spans:
                    continue
                raw = re.sub(r'\s+', ' ', ' '.join(s.get('text', '').strip() for s in spans)).strip()
                y0 = float(l['bbox'][1])
                sz = max(round(float(s.get('size', 0)), 1) for s in spans)
                for s in spans:
                    t = s.get('text', '').strip()
                    if t:
                        sizes[round(float(s.get('size', 0)), 1)] += len(t)
                if y0 < h * 0.095:
                    cleaned = clean_text(re.sub(r'\b\d+\b', '', raw))
                    if cleaned:
                        header_Counter[cleaned] += 1
                lines_on_page.append((y0, sz, raw, h))
        lines_on_page.sort(key=lambda item: item[0])
        page_lines[pno] = lines_on_page

    note_sz = sizes.most_common(1)[0][0] if sizes else 9.0
    running_heads = {k for k, cnt in header_Counter.items() if cnt >= 2 and k}

    # Extract candidate section headings across notes pages
    sec_heads = []
    for pno in range(ns, ne + 1):
        lines_p = page_lines[pno]
        for y0, sz, raw, h in lines_p:
            if y0 < h * 0.085 or y0 > h * 0.93:
                continue
            if _is_noise_line(raw, running_heads):
                continue
            # Reject split inline OCR fragments sharing the same horizontal row with another text box
            if any((ly, lraw) != (y0, raw) and abs(ly - y0) < 4.5 for ly, _lsz, lraw, _lh in lines_p):
                continue
            is_struct = bool(_STRUCTURAL_HEAD_RE.match(raw))
            is_upper_short = raw.isupper() and 4 <= len(clean_text(raw)) <= 45
            if is_struct or is_upper_short or sz >= note_sz + 1.2:
                sec_heads.append((pno, y0, raw))

    body_chs = [c for c in chapters if c is not notes_ch and c.get('start_page', 0) < ns]

    mapped = []
    min_bc_idx = 0
    for pno, y0, h_text in sec_heads:
        best_idx, best_score = None, 0
        for idx in range(min_bc_idx, len(body_chs)):
            score = _match_score(h_text, body_chs[idx].get('title', ''))
            # Fuzzy token matches cannot leapfrog structural chapters; only exact
            # structural-tag or full-title matches (>=95) may skip zero-note chapters.
            if score < 95 and idx > min_bc_idx:
                continue
            if score > best_score:
                best_score = score
                best_idx = idx
        if best_idx is not None and best_score >= 60:
            bc = body_chs[best_idx]
            if not mapped or mapped[-1][2] is not bc:
                mapped.append((pno, y0, bc))
                min_bc_idx = best_idx + 1

    for idx, (pno, _y0, ch) in enumerate(mapped):
        if idx + 1 < len(mapped):
            next_pno, next_y0, _next_ch = mapped[idx + 1]
            if next_pno == pno:
                end_pno = pno
            else:
                # Check if any note body line exists above next_y0 (and below running head) on next_pno
                has_prior_notes = any(
                    (h * 0.095) <= ly < (next_y0 - 4.0)
                    and clean_text(re.sub(r'\b\d+\b', '', lraw)) not in running_heads
                    and lraw.strip().upper() != 'NOTES'
                    for ly, _lsz, lraw, h in page_lines.get(next_pno, [])
                )
                end_pno = next_pno if has_prior_notes else max(pno, next_pno - 1)
        else:
            end_pno = ne
        ch['note_pages'] = [pno, end_pno]

    notes_ch['role_hint'] = 'notes'
    return chapters


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf')
    ap.add_argument('chapters')
    args = ap.parse_args()

    if Path(args.chapters).exists():
        chapters = json.loads(Path(args.chapters).read_text(encoding='utf-8'))
    else:
        chapters = json.loads(args.chapters)

    updated = resolve_endnotes(args.pdf, chapters)
    print(json.dumps(updated, ensure_ascii=False))


if __name__ == '__main__':
    main()
