"""Local text writes for tailoring candidates and inspection side files."""

from pathlib import Path


class LocalArtifactTextWriter:
    def write_text(self, path: Path, text: str) -> int | None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        try:
            return path.stat().st_size
        except OSError:
            return None
