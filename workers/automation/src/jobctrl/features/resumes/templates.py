"""Versioned resume presentation; template text never supplies candidate claims."""

from __future__ import annotations

from copy import deepcopy
from uuid import uuid4

from .domain import ResumeError, canonical, digest

BUILT_IN_ID = "built_in:modern-html"
BUILT_IN_THEME = {"pageSize": "a4", "fontFamily": "sans", "fontScale": 1, "density": "balanced",
                  "marginMm": {"top": 16.5, "right": 17.5, "bottom": 18, "left": 17.5},
                  "headerLayout": "centered", "sectionHeadingStyle": "rule", "alignment": "justified",
                  "bulletSpacing": "normal", "accentColor": "#111111",
                  "sectionOrder": ["summary", "experience", "education", "skills"], "hiddenSections": []}


def version_dto(row, template_id):
    return {"templateId": template_id, "versionId": row["version_id"], "versionNumber": row["version"],
            "displayName": row["display_name"], "status": "active", "theme": deepcopy(row["theme"]),
            "layout": deepcopy(row["layout"]), "contentHash": digest({"theme": row["theme"], "layout": row["layout"]}),
            "createdAt": row["created_at"]}


class Templates:
    def __init__(self, repository, renderer):
        self.repository, self.renderer = repository, renderer

    def _rows(self, connection=None):
        builtin = {"template_id": BUILT_IN_ID, "version_id": BUILT_IN_ID + ":v1", "version": 1,
                   "display_name": "Modern HTML", "theme": BUILT_IN_THEME, "layout": {},
                   "created_at": "2026-11-06T00:00:00+00:00", "updated_at": "2026-11-06T00:00:00+00:00"}
        builtin["versions"] = [{key: value for key, value in builtin.items() if key != "versions"}]
        return {BUILT_IN_ID: builtin, **{row["template_id"]: row for row in self.repository.templates(connection=connection)}}

    def selected(self, template_id, version_id=None, *, assignment_source="job_override", connection=None):
        row = self._rows(connection).get(template_id)
        if row is None:
            raise ResumeError("resume_template_not_found")
        version = next((item for item in row["versions"] if item["version_id"] == (version_id or row["version_id"])), None)
        if version is None:
            raise ResumeError("resume_template_version_not_found")
        public = version_dto(version, template_id)
        return {"template_id": template_id, "version_id": version["version_id"], "version": version["version"],
                "theme": deepcopy(version["theme"]), "layout": deepcopy(version["layout"]),
                "metadata": {"templateId": template_id, "templateVersionId": version["version_id"],
                             "templateVersionNumber": version["version"], "templateName": version["display_name"],
                             "templateHash": public["contentHash"], "assignmentSource": assignment_source},
                "public_version": public}

    def effective(self, connection=None):
        preference = self.repository.template_preference(connection=connection)
        if preference is None:
            return self.selected(BUILT_IN_ID, assignment_source="built_in", connection=connection)
        return self.selected(preference["template_id"], preference["version_id"], assignment_source="profile_default", connection=connection)

    def _summary(self, row):
        active = version_dto(row, row["template_id"])
        return {"templateId": row["template_id"], "displayName": row["display_name"], "status": "active",
                "builtIn": row["template_id"] == BUILT_IN_ID, "activeVersion": active,
                "createdAt": row["created_at"], "updatedAt": row["updated_at"],
                "versions": [version_dto(item, row["template_id"]) for item in row["versions"]]}

    def list(self):
        effective = self.effective()
        preference = self.repository.template_preference()
        builtin = self.selected(BUILT_IN_ID)
        return {"ok": True, "templates": [self._summary(row) for row in self._rows().values()],
                "defaultTemplate": effective["metadata"] if preference else None,
                "builtInDefault": {**builtin["metadata"], "assignmentSource": "built_in"},
                "effectiveDefaultVersion": effective["public_version"],
                "preferenceRevision": preference["preference_revision"] if preference else 0}

    def detail(self, template_id):
        row = self._rows().get(template_id)
        if row is None:
            raise ResumeError("resume_template_not_found")
        return {"ok": True, "template": self._summary(row)}

    def save(self, payload):
        template_id = payload.get("templateId", payload.get("template_id")) or "resume-template-" + str(uuid4())
        name = payload.get("displayName", payload.get("display_name"))
        if (not isinstance(template_id, str) or not template_id.strip() or len(template_id) > 120
                or not isinstance(name, str) or not name.strip() or len(name) > 120):
            raise ResumeError("invalid_resume_template")
        theme = {**deepcopy(BUILT_IN_THEME), **payload.get("theme", {})}
        layout = deepcopy(payload.get("layout", {}))
        if not isinstance(layout, dict) or set(layout) - {"plateDocument", "sectionOrder"}:
            raise ResumeError("invalid_resume_template_layout")
        if "sectionOrder" in layout:
            theme["sectionOrder"] = deepcopy(layout["sectionOrder"])
        self.renderer.validate_theme(theme)
        if "plateDocument" in layout and not isinstance(layout["plateDocument"], list):
            raise ResumeError("invalid_resume_template_layout")
        if len(canonical(layout).encode()) > 2_000_000:
            raise ResumeError("invalid_resume_template_layout")
        previous = self._rows().get(template_id)
        expected = payload.get("expected_version")
        expected_id = payload.get("expectedVersionId")
        if previous is not None:
            if expected_id is not None:
                if expected_id != previous["version_id"] or (expected is not None and expected != previous["version"]):
                    raise ResumeError("resume_template_version_conflict")
                expected = previous["version"]
            elif expected != previous["version"]:
                raise ResumeError("resume_template_version_conflict")
        elif expected_id is not None:
            raise ResumeError("resume_template_version_conflict")
        # Built-in is immutable presentation; saving it creates a user-owned copy.
        if template_id == BUILT_IN_ID:
            template_id = "resume-template-" + str(uuid4())
            expected = None
        saved = self.repository.save_template(template_id, expected, theme, layout, name.strip())
        return {"ok": True, "template": self._summary(saved)}

    def select_default(self, payload):
        template_id = payload.get("templateId", payload.get("template_id"))
        chosen = self.selected(template_id, payload.get("versionId", payload.get("version_id")), assignment_source="profile_default")
        expected_active = payload.get("expectedActiveVersionId")
        if expected_active is not None and self._rows()[template_id]["version_id"] != expected_active:
            raise ResumeError("resume_template_version_conflict")
        preference = self.repository.set_template_preference(
            {"template_id": template_id, "version_id": chosen["version_id"]},
            expected_revision=payload.get("expectedRevision", payload.get("expected_version")),
            expected_active_version_id=expected_active,
        )
        return {"ok": True, "defaultTemplate": chosen["metadata"],
                "preferenceRevision": preference["preference_revision"]}
