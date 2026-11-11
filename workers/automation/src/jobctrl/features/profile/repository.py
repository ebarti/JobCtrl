"""Profile SQLite adapter. Every mutation and its invalidation commit together."""

from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import json
from uuid import uuid4

from jobctrl.app.errors import AppError, ConflictError, NotFoundError
from .models import ProfileSnapshot, authoring_request_summary, canonical, fingerprint, profile_identity
from .shape import DEFAULT_STYLE, DEFAULT_TEMPLATE, empty_profile


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def identifier(prefix: str) -> str:
    return f"{prefix}:{uuid4()}"


class ProfileRepository:
    def __init__(self, runtime):
        self.runtime = runtime

    def transaction(self):
        return self.runtime.database.transaction()

    def new_source_id(self):
        return identifier("source")

    def source_row(self, conn, profile_id, source_id, *, active_only=False):
        return conn.execute("SELECT * FROM profile_sources WHERE profile_id=? AND source_id=?" + (" AND active=1" if active_only else ""),
                            (profile_id, source_id)).fetchone()

    def variant_row(self, conn, profile_id, variant_id):
        return conn.execute("SELECT * FROM profile_variants WHERE profile_id=? AND variant_id=?", (profile_id, variant_id)).fetchone()

    def approved_variant(self, conn, profile_id, achievement_id, text, refs):
        for row in conn.execute("SELECT * FROM profile_variants WHERE profile_id=? AND achievement_id=? AND text=? AND status='approved'", (profile_id, achievement_id, text)):
            if json.loads(row["source_refs_json"]) == refs:
                return self.variant(row)
        return None

    def add_variant(self, conn, *, profile_id, achievement_id, text, source_refs, status="pending", origin_key=None, provenance=None):
        if not conn.execute("SELECT 1 FROM profile_achievements WHERE profile_id=? AND achievement_id=? AND active=1", (profile_id, achievement_id)).fetchone():
            raise ConflictError("The authored achievement is no longer current.", reason="stale_achievement")
        if not self.current_refs(conn, source_refs, profile_id):
            raise ConflictError("The wording sources changed.", reason="stale_source_revision")
        variant_id = identifier("wording")
        approval = self.decision(conn, profile_id=profile_id, kind="wording", subject_id=variant_id, revision=1,
                                 decision="approve", exact={"text": text, "source_refs": source_refs}) if status == "approved" else None
        conn.execute("INSERT INTO profile_variants VALUES(?,?,1,?,?,?,?,?,?,?,?)",
                     (profile_id, variant_id, achievement_id, text, canonical(source_refs), status, approval, origin_key,
                      canonical(provenance or {"kind": "user_authored"}), now()))
        return self.variant(self.variant_row(conn, profile_id, variant_id))

    def set_variant_decision(self, conn, *, profile_id, variant_id, status, approval_id, origin_key):
        conn.execute("UPDATE profile_variants SET status=?,approval_id=? WHERE profile_id=? AND variant_id=?",
                     (status, approval_id, profile_id, variant_id))
        if origin_key:
            conn.execute("UPDATE profile_authoring_requests SET status=? WHERE profile_id=? AND origin_key=?", (status, profile_id, origin_key))

    def set_confirmation(self, conn, *, profile_id, source_id, revision, content, status):
        conn.execute("UPDATE profile_sources SET revision=?,confirmation=? WHERE profile_id=? AND source_id=?", (revision, status, profile_id, source_id))
        conn.execute("INSERT INTO profile_source_versions VALUES(?,?,?,?)", (profile_id, source_id, revision,
                     canonical({**content, "source_id": source_id, "revision": revision, "confirmation": status})))

    def determination_row(self, conn, profile_id, determination_id):
        return conn.execute("SELECT * FROM profile_determinations WHERE profile_id=? AND determination_id=?", (profile_id, determination_id)).fetchone()

    def record_determination(self, conn, *, snapshot, kind, sources, context, result, determination_id, provenance):
        values = (snapshot.profile_id, snapshot.profile_revision, kind, canonical({"sources": sources, "context": context}),
                  canonical(result), canonical(provenance))
        prior = conn.execute("SELECT * FROM profile_determinations WHERE determination_id=?", (determination_id,)).fetchone()
        if prior:
            recorded = tuple(prior[key] for key in ("profile_id", "profile_revision", "kind", "request_json", "result_json", "provenance_json"))
            if recorded != values:
                raise AppError("model_receipt_conflict", "The persisted Profile receipt has a conflicting source binding.", 409)
            return
        conn.execute("INSERT INTO profile_determinations VALUES(?,?,?,?,?,?,?,?)", (determination_id, *values, now()))

    def authoring_row(self, conn, profile_id, *, origin_key=None, proposal_id=None):
        if origin_key is not None:
            return conn.execute("SELECT * FROM profile_authoring_requests WHERE profile_id=? AND origin_key=?", (profile_id, origin_key)).fetchone()
        return conn.execute("SELECT * FROM profile_authoring_requests WHERE profile_id=? AND proposal_id=?", (profile_id, proposal_id)).fetchone()

    def authoring_retry_successor(self, conn, profile_id, proposal_id):
        return conn.execute("""SELECT * FROM profile_authoring_requests WHERE profile_id=?
            AND json_extract(brief_json,'$.origin_metadata.retry_of_proposal_id')=? ORDER BY rowid DESC LIMIT 1""",
            (profile_id, proposal_id)).fetchone()

    @staticmethod
    def authoring_interrupted(row):
        import os
        if row["status"] != "generating":
            return False
        owner = json.loads(row["brief_json"]).get("_authoring_owner", {}).get("pid")
        if type(owner) is int:
            try:
                os.kill(owner, 0)
            except ProcessLookupError:
                return True
            except PermissionError:
                pass
        return False

    def recover_interrupted_authoring(self, conn, profile_id, row):
        if self.authoring_interrupted(row):
            self.fail_authoring(conn, profile_id, row["origin_key"], "authoring_interrupted")
            return self.authoring_row(conn, profile_id, origin_key=row["origin_key"])
        return row

    def start_authoring(self, conn, *, profile_id, origin_key, brief):
        import os
        proposal_id = identifier("proposal")
        conn.execute("INSERT INTO profile_authoring_requests VALUES(?,?,?,?, 'generating',NULL,NULL)",
                     (profile_id, origin_key, proposal_id, canonical({**brief, "_authoring_owner": {"pid": os.getpid(), "created_at": now()}})))
        return proposal_id

    def fail_authoring(self, conn, profile_id, origin_key, code):
        conn.execute("UPDATE profile_authoring_requests SET status='failed',failure_code=? WHERE profile_id=? AND origin_key=? AND status='generating'", (code, profile_id, origin_key))

    def finish_authoring(self, conn, profile_id, origin_key, status, variant_id):
        conn.execute("UPDATE profile_authoring_requests SET status=?,variant_id=? WHERE profile_id=? AND origin_key=?", (status, variant_id, profile_id, origin_key))

    @contextmanager
    def reader(self, connection=None):
        if connection is not None:
            yield connection
            return
        with self.runtime.database.connect() as conn:
            conn.execute("BEGIN")
            try:
                yield conn
            finally:
                conn.rollback()

    def root(self, conn, profile_id="default"):
        return conn.execute("SELECT * FROM profile_documents WHERE profile_id=?", (profile_id,)).fetchone()

    def check(self, conn, expected, profile_id="default"):
        row = self.root(conn, profile_id)
        actual = row["revision"] if row else None
        if expected != actual:
            raise ConflictError("The saved Profile has changed.", expectedProfileVersion=expected,
                                actualProfileVersion=actual, reason="stale_profile_version")
        return row

    def config(self, profile_id="default", connection=None) -> dict:
        with self.reader(connection) as conn:
            row = self.root(conn, profile_id)
            if not row:
                return {"ok": True, "profileVersion": None, "profile": empty_profile(),
                        "style": deepcopy(DEFAULT_STYLE), "templateText": DEFAULT_TEMPLATE}
            document = json.loads(row["document_json"])
            # Confirmation is derived from saved decisions. Client flags cannot
            # invent authority or clear an unresolved imported confirmation.
            for role in document.get("resume", {}).get("experience_entries", []):
                role["achievement_ids"] = [item[0] for item in conn.execute(
                    "SELECT achievement_id FROM profile_achievements WHERE profile_id=? AND role_id=? AND active=1 ORDER BY position,achievement_id",
                    (profile_id, role["id"]))]
                for evidence in role.get("achievement_evidence", []):
                    source_id = profile_identity("evidence", profile_id, role["id"], evidence["id"])
                    source = conn.execute("SELECT confirmation FROM profile_sources WHERE profile_id=? AND source_id=? AND active=1",
                                          (profile_id, source_id)).fetchone()
                    if source:
                        evidence["user_confirmed"] = source[0] == "confirmed"
                        evidence["confirmation_review_required"] = source[0] == "review_required"
                    else:
                        evidence["user_confirmed"] = False
                        evidence["confirmation_review_required"] = True
            pending = conn.execute("SELECT COUNT(*) FROM profile_sources WHERE profile_id=? AND active=1 AND confirmation='review_required'",
                                   (profile_id,)).fetchone()[0]
            return {"ok": True, "profileVersion": row["revision"], "factSemanticsVersion": row["fact_revision"],
                    "wordingRevision": row["wording_revision"], "profile": document,
                    "style": json.loads(row["style_json"]), "templateText": row["template_text"],
                    **({"legacyEvidenceReview": {"status": "review_required", "count": pending}} if pending else {})}

    def sources(self, conn, profile_id="default") -> list[dict]:
        result = []
        legacy_cache = None
        legacy_cache_digest = None
        for row in conn.execute("SELECT * FROM profile_sources WHERE profile_id=? AND active=1 ORDER BY source_id", (profile_id,)):
            content = json.loads(row["content_json"])
            source = dict(content, source_id=row["source_id"], revision=row["revision"], confirmation=row["confirmation"])
            if row["confirmation"] == "confirmed":
                decision = conn.execute("SELECT * FROM profile_decisions WHERE profile_id=? AND subject_kind='source' AND subject_id=? AND subject_revision=? AND decision='confirm' ORDER BY created_at DESC,decision_id DESC LIMIT 1",
                                        (profile_id, row["source_id"], row["revision"] - 1)).fetchone()
                if decision and json.loads(decision["exact_content_json"]) == content:
                    source["confirmation_id"] = decision["decision_id"]
                else:
                    from .transfer import _valid_historic_confirmation, validate_bundle
                    if legacy_cache is None:
                        archive = conn.execute("SELECT bundle_json FROM profile_transfer_provenance WHERE profile_id=?", (profile_id,)).fetchone()
                        bundle = json.loads(archive[0]) if archive else None
                        legacy_cache = validate_bundle(bundle) if bundle else {}
                        legacy_cache_digest = bundle["sha256"] if bundle else None
                    receipt = content.get("legacy_review_receipt")
                    if not _valid_historic_confirmation(legacy_cache, content.get("legacy_original"), receipt, "confirmed"):
                        raise AppError("profile_confirmation_invalid", "A saved evidence confirmation cannot be verified.", 409)
                    source["confirmation_id"] = profile_identity("legacy-confirmation", profile_id, legacy_cache_digest, receipt["event_id"])
            result.append(source)
        return result

    def current_refs(self, conn, refs, profile_id="default") -> bool:
        if not refs:
            return False
        return all(conn.execute("SELECT 1 FROM profile_sources WHERE profile_id=? AND source_id=? AND revision=? AND active=1",
                                (profile_id, item["source_id"], item["revision"])).fetchone() for item in refs)

    def snapshot(self, profile_id="default", connection=None) -> ProfileSnapshot:
        with self.reader(connection) as conn:
            row = self.root(conn, profile_id)
            if not row:
                raise NotFoundError("The Profile has not been created.")
            # Raw historical cells remain in owned storage/transfer archives;
            # the public document exposes current recorded authority only.
            document = self.config(profile_id, conn)["profile"]
            achievements = [dict(item) for item in conn.execute(
                "SELECT * FROM profile_achievements WHERE profile_id=? AND active=1 ORDER BY position,achievement_id", (profile_id,))]
            roles = []
            for role in document.get("resume", {}).get("experience_entries", []):
                roles.append({"role_id": role["id"], "achievements": [
                    {"achievement_id": item["achievement_id"], "baseline_variant_id": item["baseline_variant_id"],
                     "source_refs": json.loads(item["source_refs_json"])}
                    for item in achievements if item["role_id"] == role["id"]]})
            variants = [self.variant(row) for row in conn.execute(
                "SELECT * FROM profile_variants WHERE profile_id=? AND status='approved' ORDER BY variant_id", (profile_id,))]
            active_ids = {item["achievement_id"] for item in achievements}
            variants = [item for item in variants if item["achievement_id"] in active_ids
                        and self.current_refs(conn, item["source_refs"], profile_id)]
            for variant in variants:
                approval = conn.execute("SELECT * FROM profile_decisions WHERE decision_id=? AND profile_id=? AND subject_kind='wording' AND subject_id=? AND subject_revision=? AND decision='approve'",
                                        (variant["approval_id"], profile_id, variant["variant_id"], variant["revision"])).fetchone()
                if not approval or json.loads(approval["exact_content_json"]) != {"text": variant["text"], "source_refs": variant["source_refs"]}:
                    raise AppError("wording_approval_invalid", "A saved wording approval cannot be verified.", 409)
            payload = {"profile_id": profile_id, "profile_revision": row["revision"],
                       "fact_semantics_version": row["fact_revision"], "wording_revision": row["wording_revision"],
                       "document": document, "roles": roles, "evidence_sources": self.sources(conn, profile_id),
                       "approved_variants": variants, "style": json.loads(row["style_json"]),
                       "template_text": row["template_text"]}
            digest = fingerprint(payload)
            payload["fingerprint"] = digest
            return ProfileSnapshot(profile_id, row["revision"], row["fact_revision"], row["wording_revision"], digest, canonical(payload))

    @staticmethod
    def variant(row) -> dict:
        return {"variant_id": row["variant_id"], "revision": row["revision"], "achievement_id": row["achievement_id"],
                "text": row["text"], "source_refs": json.loads(row["source_refs_json"]), "status": row["status"],
                "approval_id": row["approval_id"], "origin_key": row["origin_key"],
                "provenance": json.loads(row["provenance_json"])}

    def decision(self, conn, *, profile_id, kind, subject_id, revision, decision, exact, authority="user") -> str:
        decision_id = identifier("approval")
        conn.execute("INSERT INTO profile_decisions VALUES(?,?,?,?,?,?,?,?,?)",
                     (decision_id, profile_id, kind, subject_id, revision, decision, canonical(exact), authority, now()))
        return decision_id

    def event(self, conn, event_type, profile_id, **refs):
        row = self.root(conn, profile_id)
        self.runtime.events.append(conn, event_type, {"profileId": profile_id, "profileVersion": row["revision"], **refs},
                                   feature="profile", aggregate_id=profile_id)

    def retain_version(self, conn, profile_id="default"):
        snapshot = self.snapshot(profile_id, connection=conn)
        conn.execute("INSERT INTO profile_versions VALUES(?,?,?)", (profile_id, snapshot.profile_revision, canonical(snapshot.to_dict())))

    def advance(self, conn, profile_id="default", *, facts=False, wording=False):
        conn.execute("UPDATE profile_documents SET revision=revision+1,fact_revision=fact_revision+?,wording_revision=wording_revision+?,updated_at=? WHERE profile_id=?",
                     (int(facts), int(wording), now(), profile_id))

    def upsert_source(self, conn, profile_id, source_id, content, *, confirmation="authored") -> dict:
        before = conn.execute("SELECT * FROM profile_sources WHERE profile_id=? AND source_id=?", (profile_id, source_id)).fetchone()
        if before:
            previous_content = json.loads(before["content_json"])
            for key in ("legacy_original", "legacy_review_receipt", "legacy_recovery"):
                if key in previous_content and key not in content:
                    content[key] = previous_content[key]
        if before and json.loads(before["content_json"]) == content:
            conn.execute("UPDATE profile_sources SET active=1 WHERE profile_id=? AND source_id=?", (profile_id, source_id))
            return {"source_id": source_id, "revision": before["revision"]}
        revision = before["revision"] + 1 if before else 1
        if before and before["confirmation"] in {"confirmed", "review_required"}:
            confirmation = "review_required"
        conn.execute("INSERT INTO profile_sources VALUES(?,?,?,?,?,1) ON CONFLICT(profile_id,source_id) DO UPDATE SET revision=excluded.revision,content_json=excluded.content_json,confirmation=excluded.confirmation,active=1",
                     (profile_id, source_id, revision, canonical(content), confirmation))
        record = {**content, "source_id": source_id, "revision": revision, "confirmation": confirmation}
        conn.execute("INSERT INTO profile_source_versions VALUES(?,?,?,?)", (profile_id, source_id, revision, canonical(record)))
        return {"source_id": source_id, "revision": revision}

    def save(self, document: dict, *, expected, style=None, template=None, profile_id="default", provenance=None,
             accepted_determination_id=None):
        with self.runtime.database.transaction() as conn:
            before = self.check(conn, expected, profile_id)
            if accepted_determination_id is not None:
                receipt = conn.execute("SELECT * FROM profile_determinations WHERE determination_id=? AND profile_id=? AND profile_revision=? AND kind='target_role_suggestions'",
                                       (accepted_determination_id, profile_id, expected)).fetchone()
                if receipt is None:
                    raise ConflictError("The accepted target suggestion receipt is missing or stale.", reason="stale_candidate_interpretation")
            old_document = json.loads(before["document_json"]) if before else {}
            # Confirmation flags are a read projection. Preserve their original
            # source cells; authority changes only through the decision action.
            old_evidence = {(role["id"], item["id"]): item
                            for role in old_document.get("resume", {}).get("experience_entries", [])
                            for item in role.get("achievement_evidence", [])}
            document = deepcopy(document)
            for role in document.get("resume", {}).get("experience_entries", []):
                for item in role.get("achievement_evidence", []):
                    previous_item = old_evidence.get((role["id"], item["id"]))
                    if previous_item:
                        for flag in ("user_confirmed", "confirmation_review_required"):
                            if flag in previous_item:
                                item[flag] = previous_item[flag]
                            else:
                                item.pop(flag, None)
            old_style = json.loads(before["style_json"]) if before else DEFAULT_STYLE
            next_style = style if style is not None else old_style
            next_template = template if template is not None else before["template_text"] if before else DEFAULT_TEMPLATE
            if before and old_document == document and old_style == next_style and before["template_text"] == next_template and accepted_determination_id is None:
                return self.config(profile_id, conn)
            revision = before["revision"] + 1 if before else 1
            facts_changed = old_document != document
            conn.execute("INSERT INTO profile_documents VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET revision=excluded.revision,fact_revision=excluded.fact_revision,wording_revision=excluded.wording_revision,document_json=excluded.document_json,style_json=excluded.style_json,template_text=excluded.template_text,updated_at=excluded.updated_at",
                         (profile_id, revision, before["fact_revision"] + int(facts_changed) if before else 1,
                          before["wording_revision"] + int(facts_changed) if before else 1, canonical(document),
                          canonical(next_style), next_template, canonical(provenance or {}), now()))
            if facts_changed:
                self.sync_authored_sources(conn, document, old_document, profile_id=profile_id, imported=bool(provenance))
            if accepted_determination_id is not None:
                self.decision(conn, profile_id=profile_id, kind="candidate_interpretation", subject_id=accepted_determination_id,
                              revision=expected, decision="accept_selected_values",
                              exact={"determination_id": accepted_determination_id, "reviewed_profile_version": expected,
                                     "accepted_profile": document})
            self.retain_version(conn, profile_id)
            self.event(conn, "ProfileUpdated", profile_id)
            return self.config(profile_id, conn)

    def sync_authored_sources(self, conn, document, old_document, *, profile_id="default", imported=False):
        # Keep independently attached evidence. Derived authored sources are
        # rebuilt mechanically by stable field/entry/achievement identities.
        conn.execute("UPDATE profile_sources SET active=0 WHERE profile_id=? AND json_extract(content_json,'$.origin')='profile'", (profile_id,))
        old_achievements = [dict(row) for row in conn.execute("SELECT * FROM profile_achievements WHERE profile_id=? AND active=1 ORDER BY position", (profile_id,))]
        conn.execute("UPDATE profile_achievements SET active=0 WHERE profile_id=?", (profile_id,))
        for section in ("personal", "work_authorization", "compensation", "experience", "availability", "application_attestations", "application_preferences", "eeo_voluntary"):
            for key, value in (document.get(section) or {}).items():
                if section == "personal" and key == "password":
                    continue
                if value is None or value == "":
                    continue
                self.upsert_source(conn, profile_id, profile_identity("field", profile_id, section, key), {"kind": "fact", "origin": "profile", "text": value if isinstance(value, str) else canonical(value), "path": [section, key]})
        resume = document["resume"]
        for key, value in resume.items():
            if key not in {"experience_entries", "education_entries", "skill_categories", "tailoring_rules"}:
                self.upsert_source(conn, profile_id, profile_identity("baseline-field", profile_id, key), {"kind": "authored_baseline", "origin": "profile", "text": value if isinstance(value, str) else canonical(value), "path": ["resume", key]})
        for section in ("education_entries", "skill_categories"):
            for item in resume.get(section, []):
                self.upsert_source(conn, profile_id, profile_identity("entry", profile_id, section, item["id"]), {"kind": "fact", "origin": "profile", "text": canonical(item), "path": ["resume", section, item["id"]]})
        old_roles = {item["id"]: item for item in old_document.get("resume", {}).get("experience_entries", [])}
        for role in resume["experience_entries"]:
            role_id = role["id"]
            metadata = {key: value for key, value in role.items() if key not in {"bullets", "achievement_evidence", "achievement_ids"}}
            self.upsert_source(conn, profile_id, profile_identity("role", profile_id, role_id), {"kind": "role", "origin": "profile", "text": canonical(metadata), "role_id": role_id})
            previous = [item for item in old_achievements if item["role_id"] == role_id]
            old_bullets = old_roles.get(role_id, {}).get("bullets", [])
            if previous and old_bullets != role.get("bullets", []) and "achievement_ids" not in role:
                raise ConflictError("Reload the saved Profile before changing achievement text or order.", reason="achievement_ids_required")
            available = list(enumerate(old_bullets))
            used = set()
            assigned_ids = []
            for position, text in enumerate(role.get("bullets", [])):
                explicit_ids = role.get("achievement_ids") or []
                achievement_id = explicit_ids[position] if position < len(explicit_ids) else None
                if achievement_id:
                    owner = conn.execute("SELECT role_id FROM profile_achievements WHERE profile_id=? AND achievement_id=?", (profile_id, achievement_id)).fetchone()
                    if owner and owner[0] != role_id:
                        raise ConflictError("An achievement identity belongs to a different role.", reason="foreign_achievement_id")
                if achievement_id in used:
                    raise AppError("duplicate_achievement_id", "Each authored bullet needs its own achievement identity.")
                available = [(index, value) for index, value in available
                             if index >= len(previous) or previous[index]["achievement_id"] not in used]
                if not achievement_id:
                    match = next(((index, old) for index, old in available if old == text), None)
                    if match:
                        available.remove(match)
                        achievement_id = previous[match[0]]["achievement_id"] if match[0] < len(previous) else None
                achievement_id = achievement_id or identifier("achievement")
                used.add(achievement_id)
                assigned_ids.append(achievement_id)
                ref = self.upsert_source(conn, profile_id, profile_identity("achievement", profile_id, achievement_id),
                                         {"kind": "authored_achievement", "origin": "profile", "text": text,
                                          "role_id": role_id, "achievement_id": achievement_id})
                variant_id = profile_identity("baseline-wording", profile_id, achievement_id, ref["revision"])
                existing = conn.execute("SELECT 1 FROM profile_variants WHERE profile_id=? AND variant_id=?", (profile_id, variant_id)).fetchone()
                if not existing:
                    authority = "imported_authored_baseline" if imported else "authored_save"
                    approval_id = self.decision(conn, profile_id=profile_id, kind="wording", subject_id=variant_id,
                                                revision=1, decision="approve", exact={"text": text, "source_refs": [ref]}, authority=authority)
                    conn.execute("INSERT INTO profile_variants VALUES(?,?,1,?,?,?,'approved',?,NULL,?,?)",
                                 (profile_id, variant_id, achievement_id, text, canonical([ref]), approval_id,
                                  canonical({"kind": "authored_baseline", "authority": authority, "historical_confirmation": "unknown" if imported else "authored"}), now()))
                conn.execute("INSERT INTO profile_achievements VALUES(?,?,?,?,?,?,1) ON CONFLICT(profile_id,achievement_id) DO UPDATE SET role_id=excluded.role_id,position=excluded.position,baseline_variant_id=excluded.baseline_variant_id,source_refs_json=excluded.source_refs_json,active=1",
                             (profile_id, achievement_id, role_id, position, variant_id, canonical([ref])))
            role["achievement_ids"] = assigned_ids
            for evidence in role.get("achievement_evidence", []):
                source_id = profile_identity("evidence", profile_id, role_id, evidence["id"])
                body = {key: value for key, value in evidence.items() if key not in {"user_confirmed", "confirmation_review_required"}}
                self.upsert_source(conn, profile_id, source_id, {"kind": "evidence", "origin": "profile", "text": canonical(body), "role_id": role_id, "evidence_id": evidence["id"], "record": body},
                                   confirmation="review_required" if imported and evidence.get("user_confirmed") else "unconfirmed")
        conn.execute("UPDATE profile_documents SET document_json=? WHERE profile_id=?", (canonical(document), profile_id))

    def library(self, profile_id="default", connection=None) -> dict:
        with self.reader(connection) as conn:
            if self.root(conn, profile_id) is None:
                return {"ok": True, "profileVersion": None, "wordingRevision": 0,
                        "roles": [], "variants": [], "proposals": []}
            snapshot = self.snapshot(profile_id, conn)
            variants = [self.variant(row) for row in conn.execute("SELECT * FROM profile_variants WHERE profile_id=? ORDER BY created_at,variant_id", (profile_id,))]
            active = {item["achievement_id"] for role in snapshot.roles for item in role["achievements"]}
            for item in variants:
                if item["achievement_id"] not in active or not self.current_refs(conn, item["source_refs"], profile_id):
                    item["status"] = "stale"
            proposals = [authoring_request_summary(row) for row in conn.execute(
                "SELECT * FROM profile_authoring_requests WHERE profile_id=? ORDER BY proposal_id", (profile_id,))]
            return {"ok": True, "profileVersion": snapshot.profile_revision, "wordingRevision": snapshot.wording_revision,
                    "roles": list(snapshot.roles), "variants": variants, "proposals": proposals}
